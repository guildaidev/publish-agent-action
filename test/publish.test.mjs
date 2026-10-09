// Copyright 2026 Guild.ai
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = new URL('../scripts/publish.mjs', import.meta.url);
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'publish-action-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source with spaces');
  await mkdir(source);
  await mkdir(path.join(root, 'bin'));
  // Deliberately conflicting sources: the Action must not interpret these.
  await writeFile(path.join(source, 'VERSION'), '9.9.9\n');
  await writeFile(path.join(source, 'package.json'), '{"version":"1.0.0"}');
  const cli = path.join(root, 'bin/guild');
  await writeFile(cli, `#!${process.execPath}
    import { appendFileSync } from 'node:fs';
    const options = ${JSON.stringify(options)};
    appendFileSync(${JSON.stringify(path.join(root, 'calls'))}, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + '\\n');
    if (options.stderr) process.stderr.write(options.stderr);
    if (options.stdout) process.stdout.write(options.stdout);
    if (options.exit) process.exit(options.exit);
    console.log(JSON.stringify({ version: { id: 'version-id', version_number: '1.0.1', agent: { id: 'agent-id' } } }));
  `);
  await chmod(cli, 0o755);
  await writeFile(path.join(root, 'output'), '');
  return {
    root, source,
    run: (overrides = {}) => spawnSync(process.execPath, [script.pathname], { encoding: 'utf8', env: {
      PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH, HOME: root,
      RUNNER_TEMP: root, GITHUB_WORKSPACE: root, GITHUB_OUTPUT: path.join(root, 'output'),
      GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: '123abc', GUILD_API_KEY: 'test-id:test-secret',
      GUILD_PUBLISH_PATH: 'source with spaces', GUILD_PUBLISH_AGENT: 'owner~agent',
      GUILD_PUBLISH_OVERWRITE: 'false', GUILD_PUBLISH_CREATE_IF_MISSING: 'false',
      GUILDCORE_URL: 'https://untrusted.invalid', GUILD_USE_SHARED: '1', GUILD_USE_LOCAL: '1', ...overrides,
    } }),
    calls: async () => {
      try { return (await readFile(path.join(root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse); }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    },
    output: () => readFile(path.join(root, 'output'), 'utf8'),
  };
}

test('one save delegates version selection to CLI without preflight or VERSION policy', async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const calls = await f.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--mode', 'json', 'agent', 'save', 'owner~agent', '--path', f.source,
    '--no-bump', '--publish', '--message', 'GitHub Actions release from owner/repo@123abc']);
  assert.equal(await f.output(), 'agent-id=agent-id\nversion-id=version-id\nversion=1.0.1\n');
  assert.equal(calls[0].env.GUILD_API_KEY, 'test-id:test-secret');
  assert.equal(calls[0].env.GUILDCORE_URL, 'https://app.guild.ai/api');
  assert.equal(calls[0].env.GUILD_USE_SHARED, undefined);
  assert.equal(calls[0].env.GUILD_USE_LOCAL, undefined);
});

test('explicit version, private creation and overwrite are passed to CLI', async t => {
  const f = await fixture(t);
  const result = f.run({ GUILD_PUBLISH_VERSION: '1.0.1', GUILD_PUBLISH_CREATE_IF_MISSING: 'true',
    GUILD_PUBLISH_AGENT_TYPE: 'GOOSE', GUILD_PUBLISH_OVERWRITE: 'true' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await f.calls())[0].args.slice(11), [
    '--version-number', '1.0.1', '--create-if-missing', '--agent-type', 'GOOSE', '--force']);
});

test('package-free source may use CLI defaults', async t => {
  const f = await fixture(t);
  await rm(path.join(f.source, 'package.json'));
  await rm(path.join(f.source, 'VERSION'));
  assert.equal(f.run().status, 0);
});

for (const reason of ['invalid source', 'duplicate version', 'unauthorized key', 'wrong type', 'conflicting edit']) {
  test('propagates CLI failure without retry: ' + reason, async t => {
    const f = await fixture(t, { exit: 7, stderr: reason });
    const result = f.run();
    assert.equal(result.status, 7);
    assert.match(result.stderr, new RegExp(reason));
    assert.equal((await f.calls()).length, 1);
    assert.equal(await f.output(), '');
  });
}

test('missing key cannot fall back to browser login', async t => {
  const f = await fixture(t);
  assert.notEqual(f.run({ GUILD_API_KEY: '' }).status, 0);
  assert.deepEqual(await f.calls(), []);
  assert.equal(await f.output(), 'failure-reason=missing-api-key\n');
});

test('CLI diagnostics cannot expose keys or inject workflow commands', async t => {
  const f = await fixture(t, { exit: 1, stderr: '::warning::test-secret\n##[error]test-id:test-secret\r::error::injected',
    stdout: '::warning::test-id:test-secret\n' });
  const result = f.run();
  const logs = result.stdout + result.stderr;
  assert.ok(!logs.includes('test-secret'));
  assert.ok(!logs.split(/\r?\n/).some(line => line.startsWith('::')));
  assert.ok(!logs.includes('##['));
});

test('inputs stay literal arguments, never shell code', async t => {
  const f = await fixture(t);
  const value = '1.0.1; touch SHOULD_NOT_EXIST';
  assert.equal(f.run({ GUILD_PUBLISH_VERSION: value }).status, 0);
  assert.ok((await f.calls())[0].args.includes(value));
  await assert.rejects(readFile(path.join(f.root, 'SHOULD_NOT_EXIST')), { code: 'ENOENT' });
});

for (const [input, value] of [['GUILD_PUBLISH_PATH', ''], ['GUILD_PUBLISH_AGENT', ''],
  ['GUILD_PUBLISH_OVERWRITE', 'yes'], ['GUILD_PUBLISH_CREATE_IF_MISSING', 'yes']]) {
  test('rejects missing or ambiguous input ' + input, async t => {
    const f = await fixture(t);
    assert.notEqual(f.run({ [input]: value }).status, 0);
    assert.deepEqual(await f.calls(), []);
  });
}

test('source symlink cannot escape checkout', async t => {
  const f = await fixture(t);
  await symlink(path.dirname(f.root), path.join(f.root, 'outside'));
  assert.notEqual(f.run({ GUILD_PUBLISH_PATH: 'outside' }).status, 0);
  assert.deepEqual(await f.calls(), []);
});

for (const input of ['GUILD_PUBLISH_AGENT', 'GUILD_PUBLISH_VERSION', 'GUILD_PUBLISH_AGENT_TYPE']) {
  for (const value of ['--force', '--shared', '--local']) {
    test('rejects option-shaped ' + input + ': ' + value, async t => {
      const f = await fixture(t);
      assert.notEqual(f.run({ [input]: value }).status, 0);
      assert.deepEqual(await f.calls(), []);
    });
  }
}

test('malformed success result cannot emit publication outputs', async t => {
  const f = await fixture(t, { stdout: 'not json\n' });
  assert.notEqual(f.run().status, 0);
  assert.equal(await f.output(), '');
});
