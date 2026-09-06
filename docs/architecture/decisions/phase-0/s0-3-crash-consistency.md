# S0-3 - GO

> A terminal completion is emitted only after the final assistant message and completed turn state commit durably.

- Recovery: Any non-completed turn becomes interrupted and its dsh session is replaced, never resumed.
- Idempotency key: `turn_id + ACP update sequence`
- Fault boundaries: 15
- Idempotency replay: PASS

| Boundary                      | Result | Recovered state | UI acknowledged | Final messages | dsh action      |
| ----------------------------- | ------ | --------------- | --------------: | -------------: | --------------- |
| `prompt_before_commit`        | PASS   | not-created     |           false |              0 | none            |
| `prompt_after_commit`         | PASS   | interrupted     |           false |              0 | replace-session |
| `acp_send_before`             | PASS   | interrupted     |           false |              0 | replace-session |
| `acp_send_after`              | PASS   | interrupted     |           false |              0 | replace-session |
| `update_first_before_commit`  | PASS   | interrupted     |           false |              0 | replace-session |
| `update_first_after_commit`   | PASS   | interrupted     |           false |              0 | replace-session |
| `update_middle_before_commit` | PASS   | interrupted     |           false |              0 | replace-session |
| `update_middle_after_commit`  | PASS   | interrupted     |           false |              0 | replace-session |
| `update_final_before_commit`  | PASS   | interrupted     |           false |              0 | replace-session |
| `update_final_after_commit`   | PASS   | interrupted     |           false |              0 | replace-session |
| `settlement_before`           | PASS   | interrupted     |           false |              0 | replace-session |
| `settlement_after`            | PASS   | interrupted     |           false |              0 | replace-session |
| `bridge_commit_before`        | PASS   | interrupted     |           false |              0 | replace-session |
| `bridge_commit_after`         | PASS   | completed       |           false |              1 | resume          |
| `ui_complete_after`           | PASS   | completed       |            true |              1 | resume          |

The probe deliberately does not resume a dsh session for an interrupted turn. Public ACP can resume model context but cannot replay its transcript; resuming after an uncertain crash would let model context diverge from the durable UI history.
