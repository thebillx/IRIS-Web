# Storage model

Persistent state will have explicit owners, schemas, and mutation paths. Reads and diagnostics must not cause concealed writes. Project and workspace references must be validated before storage access.

No database or persistent store is selected or implemented in this bootstrap.
