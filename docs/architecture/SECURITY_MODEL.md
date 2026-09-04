# Security model

The default trust boundary is the local machine. Network listeners bind to `127.0.0.1`; a non-loopback bind is rejected. Future authority must be single-writer and fail closed, and observation must not alter ownership state.

Paths crossing into runtime operations must be validated before use. The V0 runtime provides no arbitrary filesystem or shell surface, no credentials, no public listener, and no security bypass.

V0 treats same-user localhost processes as inside the local observation/project-registration trust boundary. Browser requests are constrained by loopback binding, Host/Origin checks, JSON-only mutations, and same-origin proxying. Runtime shutdown is stronger: it requires an instance-bound owner-only control token that is never exposed by public status. Fine-grained capability authorization and durable audit attribution are introduced in V1.1 rather than implied by V0.
