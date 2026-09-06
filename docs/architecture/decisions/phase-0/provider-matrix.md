# S0-7 Team provider compatibility

Verdict: **NO-GO. Stage 3 remains blocked.**

Tested on Windows x64 with dsh `0.1.2-rc.1`, `dsh-subagent-codex` `0.1.2-rc.1`, and `dsh-subagent-claude-code` `0.1.2-rc.1`.

| Provider    | Availability/auth                                        | Minimal delegation                                                                                                | Visibility                                | Cancel                           | Resume                      | V1 disposition                                                 |
| ----------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------- | --------------------------- | -------------------------------------------------------------- |
| Claude Code | CLI `2.1.260`, native OAuth logged in                    | Native CLI PASS; pinned Agent SDK `0.3.241` PASS; dsh provider FAIL (`query-run`, `invalid-result`, child exit 1) | Final answer only                         | Provider abort/process-tree kill | No, fresh query per run     | Blocked pending provider integration fix or compatible release |
| Codex       | CLI `0.153.2`, not logged in; provider bundles `0.149.1` | Not runnable without user-owned authentication                                                                    | Final answer only                         | Provider abort/process-tree kill | No, fresh thread per run    | Blocked by authentication and version skew validation          |
| Generic ACP | Package not part of selected production bundle           | Not tested                                                                                                        | Final text only; no reasoning/tools/plans | Yes                              | No continuation in provider | Restricted teammate candidate only                             |
| Qwen Code   | Not installed                                            | Not tested                                                                                                        | Unknown                                   | Unknown                          | Unknown                     | Hidden                                                         |
| Gemini CLI  | Not installed                                            | Not tested                                                                                                        | Unknown                                   | Unknown                          | Unknown                     | Hidden                                                         |
| Goose       | Not installed                                            | Not tested                                                                                                        | Unknown                                   | Unknown                          | Unknown                     | Hidden                                                         |

## Product rule

One-shot providers never appear as full live teammates. The UI labels them as final-answer-only workers and does not invent intermediate activity, tool cards or resumability. Missing installation or authentication disables creation with a concrete reason.

## Evidence and next gate

The configured DeepSeek parent successfully discovered and invoked `subagent_claude_code`; the dsh provider failed twice at the same lifecycle stage. Running the native Claude CLI and the exact pinned Agent SDK directly both succeeded immediately, isolating the failure to the dsh provider/subprocess integration rather than account authentication.

S0-7 becomes GO only after a dsh provider delegation succeeds for both Claude Code and Codex on the selected released dependency closure. Codex authentication is a user-owned prerequisite; no credential is copied into this repository.
