// Copyright 2026 Guild.ai
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = new URL('../', import.meta.url).pathname;
const parsed = spawnSync('ruby', ['-ryaml', '-rjson', '-e',
  'puts JSON.generate(YAML.safe_load(File.read("action.yml"), aliases: true))'], { cwd: root, encoding: 'utf8' });
assert.equal(parsed.status, 0, parsed.stderr);
const step = JSON.parse(parsed.stdout).runs.steps.find(step => step.id === 'cli');

async function fixture(t, version = '0.27.1', fail = false) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'guild-install-test-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'bin'));
  for (const [name, code] of [
    ['npm', `require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'npm-call'))},
      JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), key: process.env.GUILD_API_KEY }));
      process.exit(${fail ? 9 : 0});`],
    ['guild', `console.log(${JSON.stringify(version)});`],
  ]) {
    const file = path.join(dir, 'bin', name);
    await writeFile(file, `#!${process.execPath}\n${code}\n`);
    await chmod(file, 0o755);
  }
  await writeFile(path.join(dir, 'output'), '');
  return {
    dir,
    run: (selector = '0.27.1') => spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
      cwd: root, encoding: 'utf8', env: {
        PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH, HOME: dir,
        GITHUB_OUTPUT: path.join(dir, 'output'), RUNNER_TEMP: dir,
        GUILD_PUBLISH_CLI_VERSION: selector,
        GUILD_API_KEY: step.env.GUILD_API_KEY, NODE_AUTH_TOKEN: step.env.NODE_AUTH_TOKEN,
      },
    }),
    call: async () => JSON.parse(await readFile(path.join(dir, 'npm-call'), 'utf8')),
    output: () => readFile(path.join(dir, 'output'), 'utf8'),
  };
}

for (const [selector, version] of [['0.27.1', '0.27.1'], ['latest', '0.28.0'], ['1.0.0', '1.0.0']]) {
  test('standard npm install: ' + selector, async t => {
    const f = await fixture(t, version);
    const result = f.run(selector);
    assert.equal(result.status, 0, result.stderr);
    const call = await f.call();
    assert.deepEqual(call.args, ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund',
      '--registry=https://registry.npmjs.org', '@guildai/cli@' + selector]);
    assert.equal(call.key, '');
    assert.equal(call.cwd, f.dir);
    assert.equal(await f.output(), 'cli-version=' + version + '\n');
  });
}

for (const selector of ['^0.27.1', 'next', '0.27.1-beta.1', 'file:../payload', '0.27.1; echo nope']) {
  test('rejects non-stable selector: ' + selector, async t => {
    const f = await fixture(t);
    assert.notEqual(f.run(selector).status, 0);
    await assert.rejects(f.call(), { code: 'ENOENT' });
  });
}
for (const version of ['0.26.0', '0.27.0', '0.28.0-beta.1', 'not-a-version']) {
  test('enforces installed stable CLI floor: ' + version, async t => {
    const f = await fixture(t, version);
    assert.notEqual(f.run().status, 0);
    assert.equal(await f.output(), '');
  });
}
test('npm failure stops before reporting an installed CLI', async t => {
  const f = await fixture(t, '0.27.1', true);
  assert.equal(f.run().status, 9);
  assert.equal(await f.output(), '');
});
