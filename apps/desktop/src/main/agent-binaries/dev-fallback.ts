/**
 * vendor/devFallback.ts
 *
 * 共享 dev-mode 本地二进制查找。约定路径：apps/<vendorBinDir>/<platform>/<binaryName>
 * dev 模式跳过 SHA256/解压/manifest，直接用 bundled binary；prod 永远不读这里。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app } from 'electron';
import { getPlatformKey } from '../manifestService.js';

export interface DevBinaryConfig {
  /** monorepo apps/ 下的子目录名，例如 'claude-code-bin' / 'codex-package-bin' */
  vendorBinDir: string;
  /** 平台目录下的入口相对路径，例如 'claude.exe' / 'bin/codex.exe' */
  binaryName: string;
}

/**
 * 在两个候选位置依次查找：
 *   1. <appPath>/../../apps/<vendorBinDir>/<platform>/<binary>   (forge dev: appPath = apps/desktop)
 *   2. <cwd>/apps/<vendorBinDir>/<platform>/<binary>             (monorepo 根 pnpm 调起时)
 * 命中后做 chmod 0o755（unix），返回路径；都未命中返回 null。
 */
/**
 * Dev 不下载 Codex：使用开发者本机已装的 Codex 运行包（与日常使用同一份程序）。
 * 候选：CINDY_DEV_CODEX_PACKAGE 指定的包目录，其次 macOS 上 ChatGPT 自带的 codex-cli。
 * 包目录须含 codex-package.json，入口留在包内且可执行。与 scripts/local-codex-package.mjs
 * 保持同一候选顺序与判据。
 */
export function localCodexPackageCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string[] {
  const candidates = env.CINDY_DEV_CODEX_PACKAGE ? [path.resolve(env.CINDY_DEV_CODEX_PACKAGE)] : [];
  if (platform === 'darwin') {
    const bundled = path.join('ChatGPT.app', 'Contents', 'Resources', 'codex-cli');
    candidates.push(path.join('/Applications', bundled), path.join(home, 'Applications', bundled));
  }
  return candidates;
}

export function resolveCodexPackageEntry(root: string): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'codex-package.json'), 'utf8')) as { entrypoint?: unknown };
    const entry = path.resolve(root, typeof manifest.entrypoint === 'string' ? manifest.entrypoint : path.join('bin', 'codex'));
    if (path.relative(root, entry).startsWith('..')) return null;
    fs.accessSync(entry, fs.constants.X_OK);
    return entry;
  } catch {
    return null;
  }
}

export function findLocalCodexBinary(candidates: readonly string[] = localCodexPackageCandidates()): string | null {
  for (const root of candidates) {
    const entry = resolveCodexPackageEntry(root);
    if (entry) return entry;
  }
  return null;
}

export function findDevBinary(config: DevBinaryConfig): string | null {
  const platformKey = getPlatformKey();
  const candidates = [
    path.join(app.getAppPath(), '..', '..', 'apps', config.vendorBinDir, platformKey, config.binaryName),
    path.join(process.cwd(), 'apps', config.vendorBinDir, platformKey, config.binaryName),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p);
      if (process.platform !== 'win32') {
        try { fs.chmodSync(p, 0o755); } catch { /* ignore */ }
      }
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}
