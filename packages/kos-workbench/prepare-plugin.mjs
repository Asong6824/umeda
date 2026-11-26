import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(root, '../..');
const raw = process.argv.find(value => value.startsWith('--relay-url='))?.slice('--relay-url='.length) ?? process.env.UMEDA_RELAY_URL;
if (!raw) throw new Error('Pass --relay-url=<your public HTTPS relay>. No endpoint is stored in source.');
const url = new URL(raw);
if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('A public HTTPS origin is required.');
const previous = process.argv.find(value => value.startsWith('--previous-relay-url='))?.slice('--previous-relay-url='.length);
const storageUrl = new URL(previous ?? url.origin);
if (storageUrl.protocol !== 'https:' || storageUrl.username || storageUrl.password || (storageUrl.port && storageUrl.port !== '443')) throw new Error('A public HTTPS storage origin is required.');
const directory = path.join(root, 'dist/plugin');
await fs.mkdir(directory, { recursive: true });
for (const file of ['index.html', 'theme.css', 'workbench.js', 'reader.js', 'THIRD_PARTY_NOTICES.txt']) await fs.copyFile(path.join(root, 'dist', file), path.join(directory, file));
await fs.copyFile(path.join(root, 'dist/plugin-main.js'), path.join(directory, 'main.js'));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin/ghost.json'), 'utf8'));
manifest.network.hosts = [url.hostname];
await fs.writeFile(path.join(directory, 'ghost.json'), JSON.stringify(manifest, null, 2));
await fs.writeFile(path.join(directory, 'host-config.json'), JSON.stringify({ baseUrl: url.origin, storageBaseUrl: storageUrl.origin }));
await fs.copyFile(path.join(root, 'LICENSE.kos-framework'), path.join(directory, 'LICENSE.kos-framework'));
await build({ entryPoints: [path.join(repo, 'apps/desktop/src/main/cindy-brain/forge.ts')], outfile: path.join(root, 'dist/forge.cjs'), bundle: true, platform: 'node', format: 'cjs',
  plugins: [{ name: 'forge-raw-assets', setup(builder) {
    builder.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'forge-raw' }));
    builder.onLoad({ filter: /.*/, namespace: 'forge-raw' }, async args => ({ contents: await fs.readFile(args.path, 'utf8'), loader: 'text' }));
  } }], logLevel: 'silent' });
const { packGhostDir } = createRequire(import.meta.url)(path.join(root, 'dist/forge.cjs'));
const result = await packGhostDir(directory, { sessionWorkdir: repo });
if (!result.ok) throw new Error(JSON.stringify(result));
console.log(JSON.stringify({ packaged: true, result }, (_, value) => Buffer.isBuffer(value) || (value && value.type === 'Buffer') ? '<binary>' : value));
