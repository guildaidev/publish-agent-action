// Copyright 2026 Guild.ai
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../scripts/publish.mjs', import.meta.url));
const key = 'test-id:synthetic-secret';

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'guild-action-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'agents', 'example with spaces');
  await mkdir(source, { recursive: true });
  if (options.packageVersion) {
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ version: options.packageVersion }));
  }
  if (options.fileVersion !== null) {
    await writeFile(path.join(source, 'VERSION'), options.fileVersion ?? '1.2.3\n');
  }
  const cli = path.join(root, 'fake-cli.mjs');
  // The only test double is the remote CLI boundary. Run the real Action
  // script and inspect its exit status, invocation contract, and outputs.
  await writeFile(cli, `
    import { appendFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    appendFileSync(process.env.TEST_CALLS, JSON.stringify({ args,
      api: process.env.GUILDCORE_URL, shared: process.env.GUILD_USE_SHARED,
      local: process.env.GUILD_USE_LOCAL, state: process.env.GUILD_STATE_DIR,
      config: process.env.GUILD_CONFIG_DIR, key: process.env.GUILD_API_KEY
    }) + '\\n');
    const agent = { id: '11111111-1111-4111-8111-111111111111',
      full_name: 'myorg~example', is_public: process.env.TEST_PUBLIC === 'true', agent_type: 'GOOSE' };
    if (args.includes('get')) {
      if (process.env.TEST_FAILURE === 'target-null') { console.log('null'); process.exit(0); }
      if (process.env.TEST_MISSING === 'true') { console.error('Target unavailable'); process.exit(1); }
      if (process.env.TEST_FAILURE === 'lookup') { console.error('Target unavailable'); process.exit(1); }
      if (process.env.TEST_FAILURE === 'target') agent.full_name = 'myorg~other';
      if (process.env.TEST_FAILURE === 'target-id') agent.id = 'bad-id';
      if (process.env.TEST_FAILURE === 'target-visibility') delete agent.is_public;
      console.log(JSON.stringify(agent));
    }
    else if (args.includes('save')) {
      if (process.env.TEST_MISSING === 'true' && !args.includes('--create-if-missing')) process.exit(1);
      if (process.env.TEST_RESOLVE_FAILURE) { console.error(process.env.TEST_RESOLVE_FAILURE); process.exit(1); }
      if (process.env.TEST_FAILURE === 'command') {
        console.error('##[warning]untrusted annotation');
        console.error('::warning::untrusted annotation');
      }
      if (process.env.TEST_FAILURE === 'save') {
        console.error('Validation failed ' + process.env.GUILD_API_KEY);
        process.exit(1);
      }
      if (process.env.TEST_FAILURE === 'json') { console.log('not-json'); process.exit(0); }
      if (process.env.TEST_FAILURE === 'duplicate') { console.error('Version already published'); process.exit(1); }
      const version = { id: '22222222-2222-4222-8222-222222222222',
        version_number: args[args.indexOf('--version-number') + 1], status: 'PUBLISHED', validation_status: 'PASSED', agent };
      if (process.env.TEST_FAILURE === 'status') version.status = 'DRAFT';
      if (process.env.TEST_FAILURE === 'validation') version.validation_status = 'FAILED';
      if (process.env.TEST_FAILURE === 'version') version.version_number = '9.9.9';
      if (process.env.TEST_FAILURE === 'agent') version.agent.id = 'wrong-agent';
      if (process.env.TEST_FAILURE === 'visibility') version.agent.is_public = true;
      if (process.env.TEST_FAILURE === 'type') version.agent.agent_type = 'GUILD_TYPESCRIPT';
      console.log(JSON.stringify({ version }));
    } else { process.exit(3); }
  `);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GITHUB_WORKSPACE: root,
    RUNNER_TEMP: root,
    GITHUB_OUTPUT: path.join(root, 'output'),
    GITHUB_STEP_SUMMARY: path.join(root, 'summary'),
    GITHUB_REPOSITORY: 'myorg/agent-source',
    GITHUB_SHA: 'abc123',
    GUILD_API_KEY: key,
    GUILD_PUBLISH_CLI: cli,
    GUILD_PUBLISH_CLI_VERSION: '0.27.1',
    GUILD_PUBLISH_PATH: 'agents/example with spaces',
    GUILD_PUBLISH_AGENT: 'myorg~example',
    GUILD_PUBLISH_VERSION: '',
    GUILD_PUBLISH_OVERWRITE: 'false',
    GUILD_PUBLISH_CREATE_IF_MISSING: 'false',
    GUILD_PUBLISH_AGENT_TYPE: '',
    GUILDCORE_URL: 'https://should-not-receive-key.invalid/api',
    GUILD_USE_SHARED: '1',
    GUILD_USE_LOCAL: '1',
    GUILD_STATE_DIR: '/must-not-reuse-state',
    GUILD_CONFIG_DIR: '/must-not-reuse-login',
    TEST_CALLS: path.join(root, 'calls'),
    ...options.env,
  };
  return {
    root, source, env,
    run: () => spawnSync(process.execPath, [script], { env, encoding: 'utf8' }),
    calls: async () => {
      try { return (await readFile(env.TEST_CALLS, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    output: async () => readFile(env.GITHUB_OUTPUT, 'utf8').catch(() => ''),
  };
}

test('publishes the source version, waits through CLI validation, and reports the exact result', async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const calls = await f.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ['--mode', 'json', 'agent', 'save', 'myorg~example',
    '--path', f.source, '--version-number', '1.2.3', '--no-bump', '--publish',
    '--message', 'GitHub Actions release from myorg/agent-source@abc123']);
  assert.equal(await f.output(), 'agent-id=11111111-1111-4111-8111-111111111111\nversion-id=22222222-2222-4222-8222-222222222222\nversion=1.2.3\n');
  assert.equal(await readFile(path.join(f.source, 'VERSION'), 'utf8'), '1.2.3\n');
});

test('uses package.json version when no VERSION file exists', async t => {
  const f = await fixture(t, { fileVersion: null, packageVersion: '1.2.3' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(await f.output(), /version=1\.2\.3/);
});

test('accepts an explicit version for a format without a version manifest', async t => {
  const f = await fixture(t, { fileVersion: null, env: { GUILD_PUBLISH_VERSION: '1.2.3' } });
  assert.equal(f.run().status, 0);
});

test('overwrite is opt-in and maps to the existing CLI force flag', async t => {
  const f = await fixture(t, { env: { GUILD_PUBLISH_OVERWRITE: 'true' } });
  assert.equal(f.run().status, 0);
  assert.equal((await f.calls())[1].args.at(-1), '--force');
});

test('uses prod with isolated CLI state instead of inherited login or environment selectors', async t => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  for (const call of await f.calls()) {
    assert.equal(call.api, 'https://app.guild.ai/api');
    assert.equal(call.shared, undefined);
    assert.equal(call.local, undefined);
    assert.ok(call.state.startsWith(f.root + path.sep));
    assert.ok(call.config.startsWith(f.root + path.sep));
    assert.equal(call.key, key);
  }
});

for (const [name, env, options] of [
  ['missing credential', { GUILD_API_KEY: '' }],
  ['missing target', { GUILD_PUBLISH_AGENT: '' }],
  ['malformed target', { GUILD_PUBLISH_AGENT: 'myorg~example; echo unsafe' }],
  ['ambiguous overwrite setting', { GUILD_PUBLISH_OVERWRITE: 'yes' }],
  ['ambiguous creation setting', { GUILD_PUBLISH_CREATE_IF_MISSING: 'yes' }],
  ['creation without a type', { GUILD_PUBLISH_CREATE_IF_MISSING: 'true' }],
  ['type without creation consent', { GUILD_PUBLISH_AGENT_TYPE: 'GOOSE' }],
  ['unsupported creation type', { GUILD_PUBLISH_CREATE_IF_MISSING: 'true', GUILD_PUBLISH_AGENT_TYPE: 'goose; echo unsafe' }],
  ['uppercase creation target', { GUILD_PUBLISH_CREATE_IF_MISSING: 'true', GUILD_PUBLISH_AGENT_TYPE: 'GOOSE', GUILD_PUBLISH_AGENT: 'MyOrg~example' }],
  ['missing version', {}, { fileVersion: null }],
  ['invalid version', {}, { fileVersion: 'not-a-version' }],
  ['mismatched explicit version', { GUILD_PUBLISH_VERSION: '2.0.0' }],
  ['conflicting source versions', {}, { packageVersion: '2.0.0' }],
  ['missing directory', { GUILD_PUBLISH_PATH: 'does-not-exist' }],
]) {
  test(`refuses ${name} before contacting Guild`, async t => {
    const f = await fixture(t, { ...options, env });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /::error::/);
    assert.deepEqual(await f.calls(), []);
    assert.equal(await f.output(), name === 'missing credential' ? 'failure-reason=missing-api-key\n' : '');
  });
}

test('refuses a source path outside the checkout', async t => {
  const f = await fixture(t);
  f.env.GUILD_PUBLISH_PATH = '..';
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /::error::.*checkout/);
  assert.deepEqual(await f.calls(), []);
});

test('refuses a VERSION symlink outside the source directory', async t => {
  const f = await fixture(t, { fileVersion: null });
  await writeFile(path.join(f.root, 'outside'), '1.2.3');
  await symlink(path.join(f.root, 'outside'), path.join(f.source, 'VERSION'));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /::error::.*source directory/);
  assert.deepEqual(await f.calls(), []);
});

test('publication failure is surfaced without retry, success outputs, or leaked credential', async t => {
  const f = await fixture(t, { env: { TEST_FAILURE: 'save' } });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Validation failed/);
  assert.ok(!result.stderr.includes(key));
  assert.ok(!result.stderr.includes('synthetic-secret'));
  assert.equal((await f.calls()).length, 2);
  assert.equal(await f.output(), '');
});

test('remote logs cannot inject legacy or modern GitHub workflow commands', async t => {
  const f = await fixture(t, { env: { TEST_FAILURE: 'command' } });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stderr.includes('##['));
  assert.ok(!result.stderr.split('\n').some(line => line.trimStart().startsWith('::')));
  assert.match(result.stderr, /untrusted annotation/);
});

for (const failure of ['json', 'status', 'validation', 'version', 'agent', 'visibility']) {
  test(`does not report success when CLI returns an unexpected ${failure}`, async t => {
    const f = await fixture(t, { env: { TEST_FAILURE: failure } });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /::error::/);
    assert.equal(await f.output(), '');
  });
}

for (const failure of ['lookup', 'target', 'target-id', 'target-visibility', 'target-null']) {
  test(`refuses ${failure} before saving and cleans up isolated state`, async t => {
    const f = await fixture(t, { env: { TEST_FAILURE: failure } });
    assert.notEqual(f.run().status, 0);
    const calls = await f.calls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['--mode', 'json', 'agent', 'get', 'myorg~example']);
    assert.equal(await f.output(), '');
    await assert.rejects(realpath(calls[0].state), { code: 'ENOENT' });
  });
}

test('duplicate published version fails once without success outputs or leftover state', async t => {
  const f = await fixture(t, { env: { TEST_FAILURE: 'duplicate', GUILD_PUBLISH_OVERWRITE: 'true' } });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Version already published/);
  const calls = await f.calls();
  assert.equal(calls.length, 2);
  assert.equal(await f.output(), '');
  await assert.rejects(realpath(calls[1].state), { code: 'ENOENT' });
});

test('summary reports the actual verified installed CLI version', async t => {
  const f = await fixture(t, { env: { GUILD_PUBLISH_CLI_VERSION: '0.27.2' } });
  assert.equal(f.run().status, 0);
  assert.match(await readFile(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /Guild CLI: `0\.27\.2`/);
});

test('unvalidated CLI version cannot inject summary content or reach Guild', async t => {
  const f = await fixture(t, { env: { GUILD_PUBLISH_CLI_VERSION: 'latest\ninjected' } });
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(await f.calls(), []);
  assert.equal(await f.output(), '');
});

const creation = { GUILD_PUBLISH_CREATE_IF_MISSING: 'true', GUILD_PUBLISH_AGENT_TYPE: 'GOOSE' };

test('opt-in first release delegates private creation and exact version to the CLI without overwrite', async t => {
  const f = await fixture(t, { fileVersion: '1.0.0', env: { ...creation, TEST_MISSING: 'true' } });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const calls = await f.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ['--mode', 'json', 'agent', 'save', 'myorg~example',
    '--path', f.source, '--version-number', '1.0.0', '--no-bump', '--publish',
    '--message', 'GitHub Actions release from myorg/agent-source@abc123', '--create-if-missing', '--agent-type', 'GOOSE']);
  assert.match(await f.output(), /version=1\.0\.0\n/);
  assert.match(await readFile(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /Visibility: private/);
  await assert.rejects(realpath(calls[1].state), { code: 'ENOENT' });
});

test('creation opt-in updates the same existing public agent without changing visibility', async t => {
  const f = await fixture(t, { fileVersion: '1.0.1', env: { ...creation, TEST_PUBLIC: 'true', GUILD_PUBLISH_OVERWRITE: 'true' } });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(await f.output(), /^agent-id=11111111-1111-4111-8111-111111111111\n/);
  assert.match(await f.output(), /version=1\.0\.1\n/);
  assert.match(await readFile(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /Visibility: public \(unchanged\)/);
  assert.ok((await f.calls())[1].args.includes('--force'));
});

test('missing agent without explicit creation opt-in never reaches save', async t => {
  const f = await fixture(t, { env: { TEST_MISSING: 'true' } });
  assert.notEqual(f.run().status, 0);
  assert.equal((await f.calls()).length, 1);
  assert.equal(await f.output(), '');
});

for (const failure of ['visibility', 'agent', 'type']) {
  test(`first release rejects unexpected ${failure} instead of reporting creation success`, async t => {
    const f = await fixture(t, { env: { ...creation, TEST_MISSING: 'true', TEST_FAILURE: failure } });
    assert.notEqual(f.run().status, 0);
    assert.equal((await f.calls()).length, 2);
    assert.equal(await f.output(), '');
  });
}

for (const failure of ['Forbidden', 'Unauthorized', 'Connection refused', 'Server error']) {
  test(`creation resolver ${failure} is surfaced without retry or an alternate mutation`, async t => {
    const f = await fixture(t, { env: { ...creation, TEST_MISSING: 'true', TEST_RESOLVE_FAILURE: failure } });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(failure));
    assert.equal((await f.calls()).length, 2);
    assert.equal(await f.output(), '');
  });
}

test('failed initial validation is not retried or automatically deleted', async t => {
  const f = await fixture(t, { env: { ...creation, TEST_MISSING: 'true', TEST_FAILURE: 'save' } });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Validation failed/);
  assert.equal((await f.calls()).length, 2);
  assert.equal(await f.output(), '');
});

test('creation consent does not bypass an existing target type mismatch', async t => {
  const f = await fixture(t, { env: { ...creation, GUILD_PUBLISH_AGENT_TYPE: 'GUILD_TYPESCRIPT' } });
  assert.notEqual(f.run().status, 0);
  assert.equal((await f.calls()).length, 1);
  assert.equal(await f.output(), '');
});

test('malformed successful lookup is not treated as absence when creation is enabled', async t => {
  const f = await fixture(t, { env: { ...creation, TEST_FAILURE: 'target-null' } });
  assert.notEqual(f.run().status, 0);
  assert.equal((await f.calls()).length, 1);
  assert.equal(await f.output(), '');
});
