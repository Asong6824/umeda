// 包名称与兼容存储身份的跨入口合同。
//
// 背景:packages/maker-shared/src/brandIdentity.ts 是标识符层身份的单一事实源,
// restart / userData 镜像继续匹配 TS 单点;个人包可执行名由 packaging.json
// 独立提供,通过生产 CI 查询与 smoke CLI 验证,避免改名顺带搬迁用户数据。
//
// 存储静态合同仍读源码;smoke 使用唯一临时空目录,不启动实际客户端。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { packagedAppName } from '../../apps/desktop/scripts/ci/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/** 从源码里抽取形如 `<key>: '<value>'` 或 `const <key> = '<value>'` 的单引号字面量。 */
function extractLiteral(source, regex, label) {
  const match = regex.exec(source);
  assert.ok(match, `pattern not found: ${label} (${regex})`);
  return match[1];
}

const brandIdentitySource = readSource('packages/maker-shared/src/brandIdentity.ts');
const USER_DATA_DIR_NAME = extractLiteral(
  brandIdentitySource,
  /userDataDirName:\s*'([^']+)'/,
  'brandIdentity.ts userDataDirName',
);
/**
 * 从源码里抽取形如 `<mapName>: Object.freeze({ cn: '...', ... })` 的区域映射。
 * 锚定到 `Object.freeze({` 赋值处:字段名可能还出现在 interface 声明里。
 */
function extractRegionMap(source, mapName, label) {
  const blockRe = new RegExp(`${mapName}\\s*[:=]\\s*Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\)`);
  const block = blockRe.exec(source);
  assert.ok(block, `pattern not found: ${label} (${blockRe})`);
  const map = {};
  for (const [, key, , value] of block[1].matchAll(
    /(cn|global|dev):\s*(['"])([^'"]+)\2/g,
  )) {
    map[key] = value;
  }
  assert.deepEqual(Object.keys(map).sort(), ['cn', 'dev', 'global'], `${label} 缺区域键`);
  return map;
}

// Package names are now independent from the compatibility storage identity.
// Production entry: CI artifact lookup and the smoke CLI. Previous literal
// mirrors enforced Cindy names and missed the personal-fork output. Minimal
// input: default Global package lookup; tier: root integration/contract checks.
test('package lookup uses Umeda names while preserving explicit dev naming', () => {
  assert.equal(packagedAppName(), 'Umeda');
  assert.equal(packagedAppName('cn'), 'Umeda');
  assert.equal(packagedAppName('dev'), 'UmedaDev');
  assert.throws(() => packagedAppName('invalid'), /unknown region/);
});

test('smoke CLI locates renamed apps and the compatible Linux executable', (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'umeda-smoke-name-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  for (const [platform, executable] of [
    ['win32', 'Umeda.exe'],
    ['darwin', path.join('Umeda.app', 'Contents', 'MacOS', 'Umeda')],
    ['linux', path.join(empty, 'Cindy')],
  ]) {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'apps/desktop/scripts/smoke-packaged.mjs'),
      `--platform=${platform}`, '--arch=arm64', `--out-dir=${empty}`,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(executable), result.stderr);
  }
});

test('restart-desktop-remote.mjs BRAND_USER_DATA_DIR_NAME mirrors brandIdentity.userDataDirName', () => {
  const restartSource = readSource('scripts/restart-desktop-remote.mjs');
  const value = extractLiteral(
    restartSource,
    /export const BRAND_USER_DATA_DIR_NAME = '([^']+)';/,
    'restart-desktop-remote.mjs BRAND_USER_DATA_DIR_NAME',
  );
  assert.equal(value, USER_DATA_DIR_NAME);
});

test('desktop dev userData region map mirrors brandIdentity.userDataDirNameByRegion', () => {
  const expected = extractRegionMap(
    brandIdentitySource,
    'userDataDirNameByRegion',
    'brandIdentity.ts userDataDirNameByRegion',
  );
  const regionSource = readSource('scripts/shared/desktop-dev-region.mjs');
  const actual = extractRegionMap(
    regionSource,
    'DESKTOP_USER_DATA_DIR_NAME_BY_REGION',
    'desktop-dev-region.mjs DESKTOP_USER_DATA_DIR_NAME_BY_REGION',
  );
  assert.deepEqual(actual, expected);
});

test('desktop package.json productName mirrors brandIdentity.userDataDirName', () => {
  // Electron userData 目录名默认派生自 productName;brandIdentity.userDataDirName
  // 的注释也声明二者同源——两边漂移会让主进程 <userData>-dev 沙箱与 restart 脚本
  // 的 XDT_USER_DATA_DIR 落在不同目录。
  const pkg = JSON.parse(readSource('apps/desktop/package.json'));
  assert.equal(pkg.productName, USER_DATA_DIR_NAME);
});
