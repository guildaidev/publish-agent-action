// Copyright 2026 Guild.ai
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const parsed = spawnSync('ruby', ['-ryaml', '-rjson', '-e',
  'puts JSON.generate(YAML.safe_load(File.read("action.yml"), aliases: true))'], { cwd: root, encoding: 'utf8' });
assert.equal(parsed.status, 0, parsed.stderr);
const step = JSON.parse(parsed.stdout).runs.steps.find(step => step.id === 'cli');

async function fixture(t, { npmExit = 0, guildExit = 0 } = {}) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'guild-install-test-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'bin'));
  for (const [name, code] of [
    ['npm', `require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'npm-call'))},
      JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), key: process.env.GUILD_API_KEY }));
      process.exit(${npmExit});`],
    ['guild', `console.log('0.27.2'); process.exit(${guildExit});`],
  ]) {
    const file = path.join(dir, 'bin', name);
    await writeFile(file, `#!${process.execPath}\n${code}\n`);
    await chmod(file, 0o755);
  }
  await writeFile(path.join(dir, 'output'), '');
  return {
    dir,
    run: () => spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
      cwd: root, encoding: 'utf8', env: {
        PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH, HOME: dir,
        GITHUB_OUTPUT: path.join(dir, 'output'), RUNNER_TEMP: dir,
        GUILD_API_KEY: step.env.GUILD_API_KEY, NODE_AUTH_TOKEN: step.env.NODE_AUTH_TOKEN,
      },
    }),
    call: async () => JSON.parse(await readFile(path.join(dir, 'npm-call'), 'utf8')),
    output: () => readFile(path.join(dir, 'output'), 'utf8'),
  };
}

test('installs the pinned CLI with standard npm and without publishing credentials', async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const call = await f.call();
  assert.deepEqual(call.args, ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', '@guildai/cli@0.27.2']);
  assert.equal(call.key, '');
  assert.equal(call.cwd, f.dir);
  assert.equal(await f.output(), 'cli-version=0.27.2\n');
});

for (const [name, exits, status] of [
  ['npm', { npmExit: 9 }, 9], ['CLI version reporting', { guildExit: 7 }, 7],
]) {
  test(name + ' failure stops before reporting an installed CLI', async t => {
    const f = await fixture(t, exits);
    assert.equal(f.run().status, status);
    assert.equal(await f.output(), '');
  });
}
