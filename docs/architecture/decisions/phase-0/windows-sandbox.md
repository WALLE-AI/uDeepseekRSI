# S0-6 Windows sandbox boundary

Verdict: **GO for the V1 threat model, with explicit limitations.**

The S0-1 Windows probe confirmed that the selected dsh profile can request approval for a write denied by the default workspace sandbox. Both rejecting the request and selecting the elevated option were observed through ACP, and the runtime remained usable afterward.

## Enforced boundary

- Workspace-scoped file writes are allowed by the default policy.
- A write outside the allowed workspace is denied before approval.
- ACP exposes the approval request and the selected or cancelled outcome.
- Elevated access is granted per explicit user decision; the bridge must never select it automatically.

## Non-guarantees

This is a filesystem-write boundary, not a complete security boundary. It does not by itself guarantee isolation of reads, network access, child processes, environment variables, installed CLI credentials, or operating-system resources. A tool granted elevated access can exceed the workspace boundary for that invocation.

The product must describe the concrete requested operation, default to rejection, retain an audit record without secrets, and treat malformed or unknown permission options as rejection. Team workers use the same policy independently; one member's approval is not inherited by another member.

## Release gate

Before distribution, repeat the allow/reject probe from a packaged Electron build on every supported Windows version. Any path that performs an out-of-workspace write without an ACP approval event blocks release.
