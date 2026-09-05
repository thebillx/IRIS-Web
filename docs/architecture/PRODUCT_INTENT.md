# Product intent

IRIS is a macOS-first local execution system whose primary conversational interface is ChatGPT. ChatGPT reaches the user's local IRIS environment through the installed IRIS connector/plugin bridge, while the single local daemon remains the execution, project/session, permission, approval, and audit authority.

The localhost Web app is a control-and-visibility surface for active workspace/session state, runtime health, permissions/settings, Approval Center, recent activity, diagnostics, and optional standalone interaction. Its chat surface is secondary and does not define V1.3 success.

The runtime does not require a cloud control plane. GitHub is used for source history, not product operation. The standalone production-model executor remains an optional daemon capability for standalone/background use and is not a dependency of the normal ChatGPT-driven workflow. Remote hosting, Windows support, and an Electron shell are outside the current target.
