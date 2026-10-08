// Copyright 2026 Guild.ai
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/smoke.yml', import.meta.url), 'utf8');
// Execute the actual verification heredoc; replace only its external CLI process.
const verification = workflow.match(/name: Confirm the working publication[\s\S]*?<<'JS'\n([\s\S]*?)\n\s+JS/)?.[1];
assert.ok(verification, 'The smoke verification script must be executable.');

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'guild-smoke-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const callsFile = path.join(root, 'calls');
  const cli = path.join(root, 'cli.mjs');
  await writeFile(cli, `
    import { appendFileSync } from 'node:fs';
    const options = ${JSON.stringify(options)};
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
    const valid = { id: '22222222-2222-4222-8222-222222222222', version_number: '1.2.3',
      status: 'PUBLISHED', validation_status: 'PASSED' };
    const newer = { id: '33333333-3333-4333-8333-333333333333', version_number: '9.9.9',
      status: 'PUBLISHED', validation_status: 'PASSED' };
    if (args[3] === 'get') {
      if (options.lookupFailure) process.exit(1);
      const agent = { id: '11111111-1111-4111-8111-111111111111', full_name: 'myorg~example',
        is_public: false, latest_published_version: options.replaced ? newer : valid };
      if (options.missingLatest) delete agent.latest_published_version;
      console.log(JSON.stringify(agent));
    } else if (args[3] === 'versions') {
      console.log(JSON.stringify({ items: options.replaced ? [newer, valid] : [valid],
        pagination: { limit: 100, offset: 0, total: options.replaced ? 2 : 1 } }));
    } else { process.exit(3); }
  `);
  return {
    run: () => spawnSync(process.execPath, ['--input-type=module'], {
      input: verification, encoding: 'utf8', env: {
        PATH: process.env.PATH, RUNNER_TEMP: root, GUILD_PUBLISH_CLI: cli,
        GUILD_API_KEY: 'synthetic-id:synthetic-secret', TEST_AGENT: 'myorg~example',
        VALID_VERSION_ID: '22222222-2222-4222-8222-222222222222',
        VALID_VERSION: '1.2.3', INVALID_VERSION: '1.2.4',
      },
    }),
    calls: async () => (await readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse),
  };
}

test('smoke verifies current selection and published history for the working version', async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await f.calls(), [
    ['--mode', 'json', 'agent', 'get', 'myorg~example'],
    ['--mode', 'json', 'agent', 'versions', 'myorg~example', '--limit', '100'],
  ]);
});

for (const [name, options] of [
  ['working version replaced by an unexpected newer published version', { replaced: true }],
  ['missing current published selection', { missingLatest: true }],
  ['failed read-only agent lookup', { lookupFailure: true }],
]) {
  test(`smoke refuses ${name}`, async t => {
    const f = await fixture(t, options);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes('Valid publication confirmed'));
    assert.ok(!result.stderr.includes('synthetic-secret'));
  });
}
