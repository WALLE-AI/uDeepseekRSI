# S0-2 — GO

> Do dsh's koffi-backed packages (Windows sandbox, session persistence, subprocess) load and work under Electron's runtime, so phase 4 can use ELECTRON_RUN_AS_NODE instead of shipping a second Node?

- Ran: 2026-09-04T15:49:52.573Z → 2026-09-04T15:50:17.107Z
- Platform: win32/x64, Node v24.14.0
- Blocking checks: 2/2 passed

## Environment

- **dshVersion**: `0.1.2-rc.1`
- **hostNode**: `v24.14.0`
- **electronBin**: `D:\llm\uDeepseekRSI\spikes\node_modules\electron\dist\electron.exe`
- **electronVersion**: `37.10.3`

## Checks

| Result  | Kind         | Check                                                            | Time    |
| ------- | ------------ | ---------------------------------------------------------------- | ------- |
| ✅ PASS | **blocking** | baseline: koffi + dsh native packages under plain Node           | 170ms   |
| ✅ PASS | **blocking** | ELECTRON_RUN_AS_NODE: koffi + dsh native packages under Electron | 24356ms |
| ✅ PASS | info         | ABI comparison Node vs Electron                                  | 0ms     |

## Detail

### baseline: koffi + dsh native packages under plain Node — PASS

```json
{
  "runtime": {
    "execPath": "C:\\Program Files\\nodejs\\node.exe",
    "node": "24.14.0",
    "v8": "13.6.233.17-node.41",
    "modules": "137",
    "electron": null,
    "runAsNode": false,
    "arch": "x64",
    "platform": "win32"
  },
  "koffiLoaded": true,
  "koffiError": null,
  "win32CallOk": true,
  "win32CallError": null,
  "packagesOk": [
    "@deepseek-ai/dsh-win32-process",
    "@deepseek-ai/dsh-sandbox-windows-acl",
    "@deepseek-ai/dsh-subprocess-local",
    "@deepseek-ai/dsh-session-persistence-jsonl",
    "@deepseek-ai/dsh-fs-local",
    "@deepseek-ai/dsh-host-directory-picker-native"
  ],
  "packagesBroken": [],
  "packagesNotInstalled": []
}
```

### ELECTRON_RUN_AS_NODE: koffi + dsh native packages under Electron — PASS

```json
{
  "runtime": {
    "execPath": "D:\\llm\\uDeepseekRSI\\spikes\\node_modules\\electron\\dist\\electron.exe",
    "node": "22.21.1",
    "v8": "13.8.258.32-electron.0",
    "modules": "136",
    "electron": "37.10.3",
    "runAsNode": true,
    "arch": "x64",
    "platform": "win32"
  },
  "koffiLoaded": true,
  "koffiError": null,
  "win32CallOk": true,
  "win32CallError": null,
  "packagesOk": [
    "@deepseek-ai/dsh-win32-process",
    "@deepseek-ai/dsh-sandbox-windows-acl",
    "@deepseek-ai/dsh-subprocess-local",
    "@deepseek-ai/dsh-session-persistence-jsonl",
    "@deepseek-ai/dsh-fs-local",
    "@deepseek-ai/dsh-host-directory-picker-native"
  ],
  "packagesBroken": [],
  "packagesNotInstalled": []
}
```

### ABI comparison Node vs Electron — PASS

```json
{
  "nodeModulesAbi": "137",
  "electronModulesAbi": "136",
  "abiDiffers": true,
  "nodeVersionUnderElectron": "22.21.1",
  "electronVersion": "37.10.3",
  "satisfiesDshEngines": true,
  "packagesOkUnderBoth": [
    "@deepseek-ai/dsh-win32-process",
    "@deepseek-ai/dsh-sandbox-windows-acl",
    "@deepseek-ai/dsh-subprocess-local",
    "@deepseek-ai/dsh-session-persistence-jsonl",
    "@deepseek-ai/dsh-fs-local",
    "@deepseek-ai/dsh-host-directory-picker-native"
  ],
  "packagesRegressedUnderElectron": []
}
```
