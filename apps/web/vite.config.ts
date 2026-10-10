import http from 'node:http';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const runtimeUrl = process.env.IRIS_RUNTIME_URL ?? 'http://127.0.0.1:43110';

function supervisorBridge() {
  const controlUrl = process.env.IRIS_SUPERVISOR_CONTROL_URL;
  const ownerSecret = process.env.IRIS_OWNER_ACCESS_SECRET;
  const supervisorSecret = process.env.IRIS_SUPERVISOR_CONTROL_SECRET;
  return {
    name: 'iris-supervisor-owner-bridge',
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
        request.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 64 * 1024) request.destroy(new Error('request too large'));
          else chunks.push(chunk);
        });
        request.on('end', () => {
          const target = new URL(targetPath, controlUrl);
          const proxy = http.request(target, {
            method: request.method,
            headers: {
              authorization: `Bearer ${supervisorSecret}`,
              ...(request.headers['content-type'] === undefined ? {} : { 'content-type': request.headers['content-type'] }),
              ...(request.headers['mcp-protocol-version'] === undefined ? {} : { 'mcp-protocol-version': request.headers['mcp-protocol-version'] }),
              ...(request.headers['mcp-method'] === undefined ? {} : { 'mcp-method': request.headers['mcp-method'] }),
              ...(request.headers['mcp-name'] === undefined ? {} : { 'mcp-name': request.headers['mcp-name'] }),
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
          proxy.end(Buffer.concat(chunks));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), supervisorBridge()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/health': runtimeUrl,
      '/doctor': runtimeUrl,
      '/status': runtimeUrl,
      '/projects': runtimeUrl,
      '/sessions': runtimeUrl,
      '/missions': runtimeUrl,
      '/permissions': runtimeUrl,
      '/approvals': runtimeUrl,
      '/capabilities': runtimeUrl,
      '/mcp': runtimeUrl,
    },
  },
});
