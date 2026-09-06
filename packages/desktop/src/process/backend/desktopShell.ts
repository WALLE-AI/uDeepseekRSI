import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { clipboard, shell } from 'electron';
import type { DesktopShellPort } from '@udeepseekrsi/dsh-bridge';

const execFileAsync = promisify(execFile);

function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'DEEPSEEK_API_KEY' || key === 'AIONUI_CDP_BRIDGE_TOKEN' || key.endsWith('_API_KEY')) delete env[key];
  }
  return env;
}

async function executable(name: string): Promise<string | null> {
  if (process.platform !== 'win32') return name;
  try {
    const { stdout } = await execFileAsync('where.exe', [name], { windowsHide: true });
    return (
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? null
    );
  } catch {
    return null;
  }
}

async function vscodeExecutable(): Promise<string | null> {
  const fromPath = await executable(process.platform === 'win32' ? 'Code.exe' : 'code');
  if (fromPath && extname(fromPath).toLocaleLowerCase() !== '.cmd') return fromPath;
  if (process.platform !== 'win32') return fromPath;
  const candidates = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const checked = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await access(candidate);
        return candidate;
      } catch {
        return null;
      }
    })
  );
  return checked.find((candidate): candidate is string => Boolean(candidate)) ?? null;
}

function launch(command: string, args: string[], cwd: string): void {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env: childEnvironment(),
    shell: false,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

async function openFolderWith(folderPath: string, tool: 'vscode' | 'terminal' | 'explorer'): Promise<void> {
  await access(folderPath);
  if (tool === 'explorer') {
    const result = await shell.openPath(folderPath);
    if (result) throw new Error('SHELL_OPEN_FAILED');
    return;
  }
  if (tool === 'terminal') {
    const windowsTerminal = await executable('wt.exe');
    if (windowsTerminal) launch(windowsTerminal, ['-d', folderPath], folderPath);
    else if (process.platform === 'win32') launch('powershell.exe', ['-NoLogo', '-NoExit'], folderPath);
    else launch(process.env.SHELL || '/bin/sh', [], folderPath);
    return;
  }

  const code = await vscodeExecutable();
  if (!code) throw new Error('TOOL_NOT_INSTALLED');
  launch(code, [folderPath], folderPath);
}

export function createDesktopShell(): DesktopShellPort {
  return {
    async checkToolInstalled(tool) {
      return tool === 'vscode' && Boolean(await vscodeExecutable());
    },
    openFolderWith,
    async openFile(filePath) {
      await access(filePath);
      const result = await shell.openPath(filePath);
      if (result) throw new Error('SHELL_OPEN_FAILED');
    },
    async showItemInFolder(filePath) {
      await access(filePath);
      shell.showItemInFolder(filePath);
    },
    async openExternal(url) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('URL_SCHEME_NOT_ALLOWED');
      await shell.openExternal(parsed.toString());
    },
    copyText(text) {
      clipboard.writeText(text);
    },
  };
}
