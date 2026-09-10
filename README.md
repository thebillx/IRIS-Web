# IRIS

IRIS is a macOS-first, local-first system consisting of a local daemon and a browser UI served on localhost.

The project is currently in its clean-sheet foundation phase. The architecture is:

`browser → localhost API → local daemon → macOS capabilities`

The former project at `/Users/bill/iris-native-runtime` is a read-only source of lessons only. No source, tests, implementation text, or Git history are reused.

## Local development

Requires Node.js 24 or later and pnpm.

```sh
pnpm install
pnpm dev
```

The web app defaults to `http://127.0.0.1:5173`; its development server proxies `/health` to the runtime on port `43110`. The combined `pnpm dev` command configures that port automatically. When the runtime is launched separately without `IRIS_PORT`, it selects an available loopback port.

Validation commands are `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`.

## Supervised local stack

The supported daily control surface is `pnpm iris up`, `pnpm iris status`,
`pnpm iris doctor`, `pnpm iris restart`, and `pnpm iris down`. The first run on
an existing tunnel-client setup requires an explicit credential migration; IRIS
does not copy shell or legacy profile secrets automatically. See
[`docs/architecture/RUNTIME_SUPERVISOR.md`](docs/architecture/RUNTIME_SUPERVISOR.md)
for the credential, connector, readiness, recovery, and LaunchAgent model.
V2.3 catalog activation and cross-session durable mission continuation are
documented in
[`docs/architecture/V2_3_MCP_ACTIVATION_AND_MISSION_REBIND.md`](docs/architecture/V2_3_MCP_ACTIVATION_AND_MISSION_REBIND.md).
