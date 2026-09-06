# S0-1 — GO

> Does `dsh --profile acp` expose enough of a contract to back AionUi's chat, stop button, permission dialog, model switcher and Team panel on Windows?

- Ran: 2026-09-04T16:13:28.062Z → 2026-09-04T16:13:59.614Z
- Platform: win32/x64, Node v24.14.0
- Blocking checks: 12/12 passed

## Environment

- **dshBin**: `D:\llm\uDeepseekRSI\spikes\node_modules\@deepseek-ai\dsh\lib\bin.js`
- **dshVersion**: `0.1.2-rc.1`
- **acpSdkProtocolVersion**: `1`
- **dshHome**: `D:\llm\uDeepseekRSI\spikes\.tmp\s0-1\dsh-home`
- **workspaceA**: `D:\llm\uDeepseekRSI\spikes\.tmp\s0-1\workspace-a`
- **workspaceB**: `D:\llm\uDeepseekRSI\spikes\.tmp\s0-1\workspace-b`
- **model**: `deepseek-ai/DeepSeek-V4-Flash`
- **provider**: `spike-gateway`

## Checks

| Result  | Kind         | Check                                                     | Time   |
| ------- | ------------ | --------------------------------------------------------- | ------ |
| ✅ PASS | **blocking** | preflight: `dsh --profile acp --dump-config` composes     | 152ms  |
| ✅ PASS | **blocking** | initialize → advertised capabilities                      | 2279ms |
| ✅ PASS | **blocking** | session/new honours a per-session cwd                     | 51ms   |
| ✅ PASS | **blocking** | session/prompt streams updates (renderer coverage)        | 2442ms |
| ✅ PASS | **blocking** | session/cancel stops a turn and leaves the runtime alive  | 2542ms |
| ✅ PASS | **blocking** | session/request_permission supports reject and allow      | 8389ms |
| ✅ PASS | **blocking** | session/set_config_option switches model without restart  | 3356ms |
| ✅ PASS | **blocking** | two concurrent sessions, distinct cwds, one connection    | 8313ms |
| ✅ PASS | **blocking** | session/list excludes active sessions                     | 9ms    |
| ✅ PASS | **blocking** | session/close then session/resume restores the session    | 1553ms |
| ✅ PASS | **blocking** | resumed session still accepts a prompt with prior context | 2393ms |
| ✅ PASS | **blocking** | teardown: stdin EOF reaps the process on Windows          | 46ms   |

## Detail

### preflight: `dsh --profile acp --dump-config` composes — PASS

```json
{
  "mountedPluginCount": 87,
  "permissionRelated": [
    "@deepseek-ai/dsh-sandbox-local",
    "@deepseek-ai/dsh-sandbox-policy",
    "@deepseek-ai/dsh-bash-sandbox",
    "@deepseek-ai/dsh-pwsh-sandbox",
    "@deepseek-ai/dsh-user-approval",
    "@deepseek-ai/dsh-permission-presets",
    "@deepseek-ai/dsh-fs-sandbox"
  ],
  "subagentProviders": [
    "@deepseek-ai/dsh-subagent",
    "@deepseek-ai/dsh-subagent-spawn-in-process",
    "@deepseek-ai/dsh-subagent-fork-in-process",
    "@deepseek-ai/dsh-tool-subagent-control",
    "@deepseek-ai/dsh-tool-subagent-control",
    "@deepseek-ai/dsh-tool-subagent",
    "@deepseek-ai/dsh-tool-subagent"
  ],
  "configBytes": 11965
}
```

### initialize → advertised capabilities — PASS

```json
{
  "protocolVersion": 1,
  "promptCapabilities": {
    "image": false,
    "audio": false,
    "embeddedContext": false
  },
  "mcpCapabilities": {
    "http": true
  },
  "supportsSessionList": true,
  "supportsSessionResume": true,
  "supportsSessionClose": true,
  "supportsSessionFork": false,
  "raw": {
    "protocolVersion": 1,
    "agentInfo": {
      "name": "deepseek-harness-acp",
      "version": "0.0.1"
    },
    "agentCapabilities": {
      "mcpCapabilities": {
        "http": true
      },
      "promptCapabilities": {
        "image": false,
        "audio": false,
        "embeddedContext": false
      },
      "sessionCapabilities": {
        "close": {},
        "list": {},
        "resume": {}
      }
    },
    "authMethods": []
  }
}
```

### session/new honours a per-session cwd — PASS

```json
{
  "sessionId": "f531abc8-98e5-430a-9a15-815c2abd6361",
  "configOptions": [
    {
      "id": "model",
      "name": "Model",
      "category": "model",
      "type": "select",
      "currentValue": "[\"spike-gateway\",\"deepseek-ai/DeepSeek-V4-Flash\"]",
      "options": [
        {
          "group": "deepseek-official",
          "name": "DeepSeek",
          "options": [
            {
              "value": "[\"deepseek-official\",\"deepseek-v4-flash\"]",
              "name": "DeepSeek-V4-Flash",
              "description": "Fast, efficient, and economical; suited to focused, routine, or parallel tasks."
            },
            {
              "value": "[\"deepseek-official\",\"deepseek-v4-pro\"]",
              "name": "DeepSeek-V4-Pro",
              "description": "Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost."
            },
            {
              "value": "[\"deepseek-official\",\"deepseek-v4-flash-vision-exp\"]",
              "name": "DeepSeek-V4-Flash-Vision-Exp"
            }
          ]
        },
        {
          "group": "spike-gateway",
          "name": "Spike Gateway",
          "options": [
            {
              "value": "[\"spike-gateway\",\"deepseek-ai/DeepSeek-V4-Flash\"]",
              "name": "deepseek-ai/DeepSeek-V4-Flash"
            },
            {
              "value": "[\"spike-gateway\",\"deepseek-ai/DeepSeek-V3.2\"]",
              "name": "deepseek-ai/DeepSeek-V3.2"
            }
          ]
        }
      ]
    }
  ],
  "raw": {
    "sessionId": "f531abc8-98e5-430a-9a15-815c2abd6361",
    "configOptions": [
      {
        "id": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": "[\"spike-gateway\",\"deepseek-ai/DeepSeek-V4-Flash\"]",
        "options": [
          {
            "group": "deepseek-official",
            "name": "DeepSeek",
            "options": [
              {
                "value": "[\"deepseek-official\",\"deepseek-v4-flash\"]",
                "name": "DeepSeek-V4-Flash",
                "description": "Fast, efficient, and economical; suited to focused, routine, or parallel tasks."
              },
              {
                "value": "[\"deepseek-official\",\"deepseek-v4-pro\"]",
                "name": "DeepSeek-V4-Pro",
                "description": "Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost."
              },
              {
                "value": "[\"deepseek-official\",\"deepseek-v4-flash-vision-exp\"]",
                "name": "DeepSeek-V4-Flash-Vision-Exp"
              }
            ]
          },
          {
            "group": "spike-gateway",
            "name": "Spike Gateway",
            "options": [
              {
                "value": "[\"spike-gateway\",\"deepseek-ai/DeepSeek-V4-Flash\"]",
                "name": "deepseek-ai/DeepSeek-V4-Flash"
              },
              {
                "value": "[\"spike-gateway\",\"deepseek-ai/DeepSeek-V3.2\"]",
                "name": "deepseek-ai/DeepSeek-V3.2"
              }
            ]
          }
        ]
      }
    ]
  }
}
```

### session/prompt streams updates (renderer coverage) — PASS

```json
{
  "stopReason": "end_turn",
  "updateKinds": {
    "agent_message_chunk": 2,
    "usage_update": 2,
    "tool_call": 1,
    "tool_call_update": 1
  },
  "rendererCoverage": {
    "assistantText": true,
    "reasoning": false,
    "toolCards": true,
    "planPanel": false
  },
  "sawWorkspaceContent": true,
  "answerPreview": "I'll read NOTES.md in the working directory.\n\nThe magic number is **4172**."
}
```

### session/cancel stops a turn and leaves the runtime alive — PASS

```json
{
  "stopReason": "cancelled",
  "cancelledCleanly": true,
  "runtimeStillAlive": true,
  "cancelLatencyMs": 2542,
  "exited": null
}
```

### session/request_permission supports reject and allow — PASS

```json
{
  "stopReasons": ["end_turn", "end_turn"],
  "requestCounts": {
    "reject": 1,
    "allow": 1
  },
  "firstRequest": {
    "optionKinds": ["allow_once", "reject_once"]
  }
}
```

### session/set_config_option switches model without restart — PASS

```json
{
  "switchedTo": "[\"spike-gateway\",\"deepseek-ai/DeepSeek-V3.2\"]",
  "resultingState": {
    "configOptions": [
      {
        "id": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": "[\"spike-gateway\",\"deepseek-ai/DeepSeek-V3.2\"]",
        "options": [
          {
            "group": "deepseek-official",
            "name": "DeepSeek",
            "options": [
              {
                "value": "[\"deepseek-official\",\"deepseek-v4-flash\"]",
                "name": "DeepSeek-V4-Flash",
                "description": "Fast, efficient, and economical; suited to focused, routine, or parallel tasks."
              },
              {
                "value": "[\"deepseek-official\",\"deepseek-v4-pro\"]",
                "name": "DeepSeek-V4-Pro",
                "description": "Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost."
              },
              {
                "value": "[\"deepseek-official\",\"deepseek-v4-flash-vision-exp\"]",
                "name": "DeepSeek-V4-Flash-Vision-Exp"
              }
            ]
          },
          {
            "group": "spike-gateway",
            "name": "Spike Gateway",
            "options": [
              {
                "value": "[\"spike-gateway\",\"deepseek-ai/DeepSeek-V4-Flash\"]",
                "name": "deepseek-ai/DeepSeek-V4-Flash"
              },
              {
                "value": "[\"spike-gateway\",\"deepseek-ai/DeepSeek-V3.2\"]",
                "name": "deepseek-ai/DeepSeek-V3.2"
              }
            ]
          }
        ]
      }
    ]
  },
  "followupStopReason": "end_turn"
}
```

### two concurrent sessions, distinct cwds, one connection — PASS

```json
{
  "stopReasons": ["end_turn", "end_turn"],
  "cwdIsolationHeld": true,
  "updatesRoutedPerSession": {
    "a": 5,
    "b": 5
  },
  "bSawOwnWorkspace": true
}
```

### session/list excludes active sessions — PASS

```json
{
  "count": 0,
  "includesSessionA": false,
  "summaryShape": []
}
```

### session/close then session/resume restores the session — PASS

```json
{
  "resumed": true,
  "listedAfterClose": true,
  "updatesReplayedOnResume": 0,
  "historyReplayed": false,
  "result": {
    "configOptions": [
      {
        "id": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": "[\"spike-gateway\",\"deepseek-ai/DeepSeek-V3.2\"]",
        "options": [
          {
            "group": "deepseek-official",
            "name": "DeepSeek",
            "options": [
              {
                "value": "[\"deepseek-official\",\"deepseek-v4-flash\"]",
                "name": "DeepSeek-V4-Flash",
                "description": "Fast, efficient, and economical; suited to focused, routine, or parallel tasks."
              },
              {
                "value": "[\"deepseek-official\",\"deepseek-v4-pro\"]",
                "name": "DeepSeek-V4-Pro",
                "description": "Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost."
              },
              {
                "value": "[\"deepseek-official\",\"deepseek-v4-flash-vision-exp\"]",
                "name": "DeepSeek-V4-Flash-Vision-Exp"
              }
            ]
          },
          {
            "group": "spike-gateway",
            "name": "Spike Gateway",
            "options": [
              {
                "value": "[\"spike-gateway\",\"deepseek-ai/DeepSeek-V4-Flash\"]",
                "name": "deepseek-ai/DeepSeek-V4-Flash"
              },
              {
                "value": "[\"spike-gateway\",\"deepseek-ai/DeepSeek-V3.2\"]",
                "name": "deepseek-ai/DeepSeek-V3.2"
              }
            ]
          }
        ]
      }
    ]
  }
}
```

### resumed session still accepts a prompt with prior context — PASS

```json
{
  "stopReason": "end_turn",
  "contextSurvivedResume": true,
  "tail": "4172"
}
```

### teardown: stdin EOF reaps the process on Windows — PASS

```json
{
  "ms": 46,
  "exited": {
    "code": 0,
    "signal": null
  },
  "cleanEofExit": true,
  "stderrTail": ""
}
```
