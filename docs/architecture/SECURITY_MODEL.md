# Security model

The default trust boundary is the local machine. Network listeners bind to `127.0.0.1`; a non-loopback bind is rejected. Future authority must be single-writer and fail closed, and observation must not alter ownership state.

Paths crossing into runtime operations must be validated before use. The bootstrap provides validation without filesystem writes, shell execution, credentials, public listeners, or security bypasses.
