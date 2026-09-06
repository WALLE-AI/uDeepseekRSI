# uworker

uworker is a Windows desktop workspace for running command-line AI agents through a unified chat interface. This fork integrates DeepSeek Harness (DSH), local agent workflows, file previews, WebUI access, and Windows packaging into the AionUi desktop foundation.

## Development

Requirements:

- Node.js 22+
- Bun
- Windows 10/11 for the Windows installer build

Install dependencies and start the desktop application:

```bash
bun install
bun run dev
```

Run the project checks:

```bash
bun run lint
bunx tsc --noEmit
bun run i18n:types
node scripts/check-i18n.js
bun run test
```

## Windows build

Build the x64 NSIS installer:

```bash
bun run build-win:x64
```

The installer and update metadata are written to `out/`. The installer filename follows `uworker-<version>-win-x64.exe`.

For a faster local package without executable metadata editing:

```bash
bun run build-win:x64:fast
```

## Project structure

- `packages/desktop/`: Electron main, preload, and renderer processes
- `packages/dsh-bridge/`: DeepSeek Harness integration bridge
- `packages/dsh-team/`: team-agent support
- `packages/web-host/`: browser-accessible WebUI host
- `mobile/`: mobile client
- `tests/`: unit, integration, regression, and end-to-end tests

See [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.

## Upstream and license

uworker is based on [AionUi](https://github.com/iOfficeAI/AionUi) and retains upstream copyright notices and compatibility identifiers where required. The project is distributed under the [Apache License 2.0](LICENSE).
