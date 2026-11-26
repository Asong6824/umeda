/**
 * Dev Codex 只用开发者本机已装的 Codex 运行包，不下载。
 * 候选顺序与判据须与 apps/desktop/src/main/agent-binaries/dev-fallback.ts 一致：
 * CINDY_DEV_CODEX_PACKAGE 指定的包目录，其次 macOS 上 ChatGPT 自带的 codex-cli；
 * 包目录须含 codex-package.json，入口在包内且可执行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOCAL_CODEX_ENV = 'CINDY_DEV_CODEX_PACKAGE';

export function localCodexPackageCandidates(env = process.env, platform = process.platform, home = os.homedir()) {
  const candidates = env[LOCAL_CODEX_ENV] ? [path.resolve(env[LOCAL_CODEX_ENV])] : [];
  if (platform === 'darwin') {
    const bundled = path.join('ChatGPT.app', 'Contents', 'Resources', 'codex-cli');
    candidates.push(path.join('/Applications', bundled), path.join(home, 'Applications', bundled));
  }
  return candidates;
}

export function resolveCodexPackageEntry(root) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'codex-package.json'), 'utf8'));
    const entry = path.resolve(root, typeof manifest.entrypoint === 'string' ? manifest.entrypoint : path.join('bin', 'codex'));
    if (path.relative(root, entry).startsWith('..')) return null;
    fs.accessSync(entry, fs.constants.X_OK);
    return entry;
  } catch {
    return null;
  }
}

export function findLocalCodexPackage(candidates = localCodexPackageCandidates()) {
  for (const root of candidates) {
    const entry = resolveCodexPackageEntry(root);
    if (entry) return { root, entry };
  }
  return null;
}
