import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isVaultPath, VAULT_FILE_MAX_BYTES, type VaultDisk } from '@cindy/device-link';

/** Filesystem adapter: the selected root may be redirected; links below it are never followed. */
export class VaultFolder implements VaultDisk {
  constructor(private readonly root: string, private readonly history: string) {}
  hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
  private async target(relative: string, createParents = false): Promise<string> {
    if (!isVaultPath(relative)) throw new Error('INVALID_VAULT_PATH');
    const root = await fs.realpath(this.root), parts = relative.split('/');
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      directory = path.join(directory, part);
      if (createParents) await fs.mkdir(directory).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('VAULT_UNSAFE_DIRECTORY');
    }
    return path.join(root, ...parts);
  }
  async read(relative: string): Promise<Uint8Array> {
    const target = await this.target(relative);
    const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > VAULT_FILE_MAX_BYTES) throw new Error('VAULT_FILE_TOO_LARGE_OR_UNSAFE');
      const root = await fs.realpath(this.root), physical = await fs.realpath(target);
      const inside = path.relative(root, physical);
      if (inside.startsWith(`..${path.sep}`) || inside === '..' || path.isAbsolute(inside)) throw new Error('VAULT_UNSAFE_DIRECTORY');
      const named = await fs.lstat(physical);
      if (named.dev !== before.dev || named.ino !== before.ino || !named.isFile()) throw new Error('VAULT_LOCAL_CHANGED');
      const bytes = await file.readFile(), after = await file.stat();
      if (bytes.length > VAULT_FILE_MAX_BYTES || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('VAULT_LOCAL_CHANGED');
      return bytes;
    } finally { await file.close(); }
  }
  /** Metadata enumeration for tools; listing must not hash/read every attachment. */
  async listPaths(): Promise<string[]> {
    const files: string[] = [];
    const walk = async (prefix: string): Promise<void> => {
      const directory = prefix ? path.dirname(await this.target(`${prefix}/entry`)) : await fs.realpath(this.root);
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!isVaultPath(relative) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(relative);
        else if (entry.isFile()) files.push(relative);
      }
    };
    await walk('');
    return files.sort();
  }
  async scan(): Promise<Record<string, string>> {
    const files: Record<string, string> = Object.create(null);
    for (const relative of await this.listPaths()) files[relative] = this.hash(await this.read(relative));
    return files;
  }
  async preserveConflict(relative: string, bytes: Uint8Array, hash: string): Promise<string> {
    const extension = path.posix.extname(relative);
    const name = `${relative.slice(0, extension ? -extension.length : undefined)}.sync-conflict-${hash.slice(0, 16)}${extension}`;
    const target = await this.target(name, true);
    try { await fs.writeFile(target, bytes, { flag: 'wx' }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || this.hash(await this.read(name)) !== hash) throw e;
    }
    return name;
  }
  async replace(relative: string, bytes: Uint8Array | null, expectedHash: string | null): Promise<void> {
    const target = await this.target(relative, bytes !== null);
    let backup: string | undefined;
    if (expectedHash !== null) {
      if (this.hash(await this.read(relative)) !== expectedHash) throw new Error('VAULT_LOCAL_CHANGED');
      await fs.mkdir(this.history, { recursive: true });
      backup = path.join(this.history, randomUUID());
      await fs.writeFile(`${backup}.json`, JSON.stringify({ path: relative, hash: expectedHash, savedAt: Date.now() }), { flag: 'wx', mode: 0o600 });
      // Retain every displaced version, including a writer racing our previous check.
      await fs.rename(target, backup);
      if (this.hash(await fs.readFile(backup)) !== expectedHash) {
        await fs.link(backup, target).catch(() => undefined);
        throw new Error('VAULT_LOCAL_CHANGED');
      }
    } else if (!bytes) return;
    if (bytes) {
      const temporary = path.join(path.dirname(target), `.umeda-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await fs.link(temporary, target);
      }
      catch (e) {
        if (backup) await fs.link(backup, target).catch(() => undefined);
        throw e;
      } finally { await fs.unlink(temporary).catch(() => undefined); }
    }
  }
}
