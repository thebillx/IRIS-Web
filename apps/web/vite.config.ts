import http from 'node:http';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const runtimeUrl = process.env.IRIS_RUNTIME_URL ?? 'http://127.0.0.1:43110';
const SUPERVISOR_WEB_TOOLS = new Set(['supervisor_status', 'supervisor_doctor', 'workload_on', 'workload_off', 'workload_restart']);
const OWNER_ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;

export interface SupervisorBridgeIdentity {
  readonly connectorProfile: 'FULL' | 'PRO';
  readonly deploymentEpoch: number;
  readonly runtimeId: string;
}

export function validateSupervisorWebRequest(body: unknown, headers: { readonly method: string | undefined; readonly name: string | undefined }): string | null {
  if (!isRecord(body) || body.method !== 'tools/call') return 'Supervisor bridge accepts only tools/call requests';
  const params = isRecord(body.params) ? body.params : null;
  if (params === null) return 'Supervisor tool arguments must be an object';
  const name = typeof params.name === 'string' ? params.name : null;
  if (name === null || !SUPERVISOR_WEB_TOOLS.has(name)) return 'Supervisor tool is not available through the Web bridge';
  if (headers.method !== 'tools/call' || headers.name !== name) return 'Supervisor request headers do not match the JSON-RPC request';
  if (params.arguments !== undefined && !isRecord(params.arguments)) return 'Supervisor tool arguments must be an object';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSupervisorBridgeIdentity(value: unknown): SupervisorBridgeIdentity | null {
  if (!isRecord(value) || value.state !== 'VERIFIED') return null;
  const binding = isRecord(value.tunnelBinding) ? value.tunnelBinding : null;
  const connectorProfile = binding?.mode === 'FULL' || binding?.mode === 'PRO' ? binding.mode : null;
  const deploymentEpoch = value.deploymentEpoch;
  const runtimeId = value.runtimeId;
  if (connectorProfile === null || typeof deploymentEpoch !== 'number' || !Number.isSafeInteger(deploymentEpoch) || deploymentEpoch <= 0 || typeof runtimeId !== 'string' || runtimeId.length === 0) return null;
  return { connectorProfile, deploymentEpoch, runtimeId };
}

export function injectOwnerAccessBootstrap(html: string, token: string | undefined): string {
  if (token === undefined || !OWNER_ACCESS_TOKEN_PATTERN.test(token)) return html;
  const bootstrap = `<script>window.__IRIS_OWNER_ACCESS_TOKEN__=${JSON.stringify(token)};</script>`;
  return html.includes('</head>') ? html.replace('</head>', `${bootstrap}</head>`) : `${bootstrap}${html}`;
}

export async function readSupervisorBridgeIdentity(controlUrl: string, supervisorSecret: string): Promise<SupervisorBridgeIdentity> {
  const response = await fetch(new URL('/identity', controlUrl), {
    headers: { authorization: `Bearer ${supervisorSecret}` },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`Supervisor identity returned HTTP ${response.status}`);
  const identity = parseSupervisorBridgeIdentity(await response.json() as unknown);
  if (identity === null) throw new Error('Supervisor identity is missing or stale');
  return identity;
}

export function createSupervisorBridge(environment: NodeJS.ProcessEnv = process.env) {
  const controlUrl = environment.IRIS_SUPERVISOR_CONTROL_URL;
  const ownerSecret = environment.IRIS_OWNER_ACCESS_SECRET;
  const supervisorSecret = environment.IRIS_SUPERVISOR_CONTROL_SECRET;
  return {
    name: 'iris-supervisor-owner-bridge',
    transformIndexHtml(html: string) {
      return injectOwnerAccessBootstrap(html, ownerSecret);
    },
    configureServer(server: { middlewares: { use: (path: string, handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, next: () => void) => void) => void } }) {
      server.middlewares.use('/supervisor-control', (request, response, next) => {
        if (ownerSecret === undefined || supervisorSecret === undefined || controlUrl === undefined) {
          response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ error: { code: 'SUPERVISOR_UNAVAILABLE', message: 'Authenticated supervisor bridge is unavailable' } }));
          return;
        }
        if (request.headers.authorization !== `Bearer ${ownerSecret}`) {
          response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ error: { code: 'CONTROL_DENIED', message: 'Owner access credential is required' } }));
          return;
        }
        const targetPath = request.url === '/healthz' ? '/healthz' : request.url === '/mcp' ? '/mcp' : null;
        if (targetPath === null || (targetPath === '/mcp' && request.method !== 'POST') || (targetPath === '/healthz' && request.method !== 'GET')) {
          next();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        let tooLarge = false;
        request.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 64 * 1024) tooLarge = true;
          else chunks.push(chunk);
        });
        request.on('end', () => {
          void (async () => {
          if (tooLarge) {
            response.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ error: { code: 'REQUEST_TOO_LARGE', message: 'Supervisor control request exceeds the 64 KiB limit' } }));
            return;
          }
          const body = Buffer.concat(chunks);
          if (targetPath === '/mcp') {
            let parsed: unknown;
            try { parsed = JSON.parse(body.toString('utf8')); } catch {
              response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
              response.end(JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'Supervisor control request is not valid JSON' } }));
              return;
            }
            const validationError = validateSupervisorWebRequest(parsed, {
              method: typeof request.headers['mcp-method'] === 'string' ? request.headers['mcp-method'] : undefined,
              name: typeof request.headers['mcp-name'] === 'string' ? request.headers['mcp-name'] : undefined,
            });
            if (validationError !== null) {
              response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
              response.end(JSON.stringify({ error: { code: 'CONTROL_DENIED', message: validationError } }));
              return;
            }
          }
          let identity: SupervisorBridgeIdentity | null = null;
          if (targetPath === '/mcp') {
            try {
              identity = await readSupervisorBridgeIdentity(controlUrl, supervisorSecret);
            } catch {
              response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
              response.end(JSON.stringify({ error: { code: 'SUPERVISOR_IDENTITY_UNAVAILABLE', message: 'Supervisor connector identity is unavailable' } }));
              return;
            }
          }
          const target = new URL(targetPath, controlUrl);
          const proxy = http.request(target, {
            method: request.method,
            headers: {
              authorization: `Bearer ${supervisorSecret}`,
              ...(request.headers['content-type'] === undefined ? {} : { 'content-type': request.headers['content-type'] }),
              ...(request.headers['mcp-protocol-version'] === undefined ? {} : { 'mcp-protocol-version': request.headers['mcp-protocol-version'] }),
              ...(request.headers['mcp-method'] === undefined ? {} : { 'mcp-method': request.headers['mcp-method'] }),
              ...(request.headers['mcp-name'] === undefined ? {} : { 'mcp-name': request.headers['mcp-name'] }),
              ...(identity === null ? {} : {
                'x-iris-connector-profile': identity.connectorProfile,
                'x-iris-deployment-epoch': String(identity.deploymentEpoch),
                'x-iris-runtime-id': identity.runtimeId,
              }),
              'content-length': String(Buffer.concat(chunks).byteLength),
            },
          }, (upstream) => {
            response.writeHead(upstream.statusCode ?? 502, upstream.headers);
            upstream.pipe(response);
          });
          proxy.on('error', () => {
            if (!response.headersSent) {
              response.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
              response.end(JSON.stringify({ error: { code: 'SUPERVISOR_UNAVAILABLE', message: 'Supervisor control did not respond' } }));
            } else response.end();
          });
          proxy.end(body);
          })().catch(() => {
            if (!response.headersSent) {
              response.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
              response.end(JSON.stringify({ error: { code: 'SUPERVISOR_UNAVAILABLE', message: 'Supervisor control did not respond' } }));
            } else response.end();
          });
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), createSupervisorBridge()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/health': runtimeUrl,
      '/doctor': runtimeUrl,
      '/status': runtimeUrl,
      '/projects': runtimeUrl,
      '/sessions': runtimeUrl,
      '/jobs': runtimeUrl,
      '/missions': runtimeUrl,
      '/permissions': runtimeUrl,
      '/approvals': runtimeUrl,
      '/capabilities': runtimeUrl,
      '/mcp': runtimeUrl,
    },
  },
});
