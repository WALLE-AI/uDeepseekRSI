# ADR: bridge crash consistency

Status: accepted for V1 single-agent bridge.

## Guarantee

A prompt is confirmed complete to the renderer only after the user message, the complete assistant message and the terminal turn state are durable in bridge SQLite. A crash may discard a streaming tail that was never confirmed complete. Recovery always marks its turn `interrupted`; it never leaves a permanent `running` row.

## State machine

`queued -> running -> settling -> completed` is the successful path. Recovery maps `queued`, `running` and `settling` to `interrupted`. `completed` is terminal and is never downgraded. A retry creates a new turn id.

## Write and publish order

1. In one SQLite transaction, insert the client-generated turn id and user message.
2. Send the ACP prompt and store the ACP session id.
3. For every ACP update, insert `event_id = turn_id:sequence` and update the pending assistant row in one transaction.
4. After ACP prompt settlement, commit the final assistant row and `turn.state = completed` in one transaction.
5. Only after step 4 returns, emit the renderer `turn.completed` event.

The bridge never emits a chunk before its corresponding update row commits. Duplicate update sequences use `INSERT OR IGNORE` and cannot duplicate assistant content.

## dsh recovery rule

ACP resume restores model context but does not replay transcript events. Resuming a session whose turn was active when the bridge crashed can therefore make hidden dsh context disagree with visible SQLite history. The bridge closes or abandons that session and creates a replacement. It resumes an existing dsh session only when every locally known turn is terminal.

This trades post-crash context continuity for an auditable history. V1 must surface the context reset beside the interrupted turn.

## Evidence

[`s0-3-crash-consistency.md`](s0-3-crash-consistency.md) injects process exit at 15 write/publish boundaries against a real WAL SQLite file. All cases recover without an acknowledged final disappearing, duplicate final rows or permanent running state. It also replays the final update id to prove idempotency.
