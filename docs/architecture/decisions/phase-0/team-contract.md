# S0-4 Team domain contract

Verdict: **GO for the self-built rule-engine route; implementation remains blocked from release by S0-7.**

## Ownership

The deterministic `dsh-team` rule engine owns run queues, task dependencies, member lifecycle, cancellation and recovery. The Lead is a normal member with routing privileges; it is not the source of truth for orchestration state. dsh experimental Team code is reference material only.

## V1 scope decisions

| Capability                        | Decision                                                      | Durable owner                                            |
| --------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| Team/member CRUD and Lead         | Keep                                                          | `teams` plus normalized member rows in the bridge schema |
| Direct member message and mailbox | Keep                                                          | append-only mailbox rows                                 |
| Task board and dependencies       | Keep                                                          | tasks plus validated dependency edges                    |
| Run queue                         | Keep, one active run per Team                                 | run/turn tables                                          |
| Interrupt member                  | Keep, retaining or dropping queued work explicitly            | run event log                                            |
| Pause/cancel                      | Keep; pause settles only at a quiescent boundary              | run event log                                            |
| Attach/restart/reset              | Keep as separate operations                                   | member runtime record                                    |
| Idle reclaim/recovery             | Keep; runtime process is disposable                           | durable member/session record                            |
| Permission ownership              | Per member request; UI decision is correlated by request id   | permission decision rows                                 |
| Member failure isolation          | Keep; running task returns to pending, other members continue | reducer transaction                                      |
| Activity pagination               | Keep with `(timestamp, id)` cursor                            | append-only activity rows                                |
| WebSocket reconnect               | Snapshot first, then events after snapshot cursor             | bridge event sequence                                    |

## State machines

Run: `idle -> running -> paused -> running`, `running|paused -> cancelling -> completed`, and `running -> completed|failed`.

Member: `detached -> attaching -> ready -> busy -> ready`; failure is `* -> failed -> recovering -> ready`. A failed member is removed from the active set in the same reducer transition. Its running task becomes unowned `pending` in that transaction.

Task: `pending -> blocked|running -> completed`; interruption returns `running -> pending`; cancellation ends at `cancelled`. A task starts only when every `blockedBy` task is completed.

## `ipcBridge.team` compatibility

| Existing facade                                                                 | V1 mapping                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `create/list/get/remove`, `addAgent/removeAgent`, `rename*`, `updateAgentModel` | Preserve signatures; bridge persistence                               |
| `ensureSession/stop/activeLease`                                                | Preserve; dsh session registry and idle reclaimer                     |
| `getConfigOptions/setConfigOption`                                              | Preserve; ACP session config option mapping                           |
| `getRunState/listMailbox/listTasks/listActivity`                                | Preserve; local read models                                           |
| `sendMessage/sendMessageToAgent`                                                | Preserve; create rule-engine work items                               |
| `interruptAgent/cancelRun/cancelChildTurn/pauseSlotWork`                        | Preserve; reducer command then ACP cancel                             |
| `attachAgent/restartAgentRuntime/resetAgentContext`                             | Preserve; replace or resume according to crash-consistency ADR        |
| All current `team.*` events                                                     | Preserve names; add monotonic sequence and snapshot cursor internally |

## Prototype evidence

`packages/dsh-team` contains a pure reducer. `tests/unit/dsh-team` proves two members can run concurrently, one failure is isolated and requeues its task, recovery returns the member to ready, and invalid lifecycle transitions fail closed. The focused suite passes 5/5.
