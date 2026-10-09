// Copyright 2026 Guild.ai
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  if (!options.missingState) {
    await mkdir(path.join(root, '.smoke/invalid/.guild'), { recursive: true });
    await writeFile(path.join(root, '.smoke/invalid/.guild/state.json'), JSON.stringify({
      base_version_id: options.wrongState ? '77777777-7777-4777-8777-777777777777' : '55555555-5555-4555-8555-555555555555',
      files: {},
    }));
  }
  await writeFile(cli, `
    import { appendFileSync } from 'node:fs';
    const options = ${JSON.stringify(options)};
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
    const initial = { id: '44444444-4444-4444-8444-444444444444', version_number: '1.0.0',
      status: 'PUBLISHED', validation_status: 'PASSED' };
    const valid = { id: '22222222-2222-4222-8222-222222222222', version_number: '1.0.1',
      status: 'PUBLISHED', validation_status: 'PASSED' };
    const invalid = { id: '55555555-5555-4555-8555-555555555555', version_number: null,
      status: 'DRAFT', validation_status: 'FAILED' };
    if (options.validationPassed) invalid.validation_status = 'PASSED';
    const newer = { id: '33333333-3333-4333-8333-333333333333', version_number: '9.9.9',
      status: 'PUBLISHED', validation_status: 'PASSED' };
    if (args[3] === 'get') {
      if (options.lookupFailure) process.exit(1);
      const agent = { id: '11111111-1111-4111-8111-111111111111', full_name: 'myorg~example',
        is_public: options.public === true, latest_published_version: options.replaced ? newer : valid };
      if (options.wrongAgent) agent.id = '66666666-6666-4666-8666-666666666666';
      if (options.missingLatest) delete agent.latest_published_version;
      console.log(JSON.stringify(agent));
    } else if (args[3] === 'versions') {
      const items = [valid];
      if (!options.missingInitial) items.push(initial);
      if (!options.missingInvalid) items.push(invalid);
      if (options.unrelatedFailure) items.push({ ...invalid, id: '88888888-8888-4888-8888-888888888888', validation_status: 'FAILED' });
      if (options.replaced) items.push(newer);
      if (options.duplicate) items.push({ ...valid, id: newer.id });
      console.log(JSON.stringify({ items, pagination: { limit: 100, offset: 0, total: items.length } }));
    } else { process.exit(3); }
  `);
  return {
    root,
    run: () => spawnSync(process.execPath, ['--input-type=module'], {
      input: verification, encoding: 'utf8', cwd: root, env: {
        PATH: process.env.PATH, RUNNER_TEMP: root, GUILD_PUBLISH_CLI: cli,
        GUILD_API_KEY: 'synthetic-id:synthetic-secret', TEST_AGENT: 'myorg~example',
        VALID_VERSION_ID: '22222222-2222-4222-8222-222222222222',
        INITIAL_VERSION_ID: '44444444-4444-4444-8444-444444444444',
        INITIAL_AGENT_ID: '11111111-1111-4111-8111-111111111111',
        VALID_AGENT_ID: '11111111-1111-4111-8111-111111111111',
        VALID_VERSION: '1.0.1', INVALID_VERSION: '1.0.2',
      },
    }),
    calls: async () => (await readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse),
  };
}

test('duplicate smoke uploads changed source from a fresh directory, not the prior local save state', async t => {
  const f = await fixture(t);
  const setup = workflow.match(/name: Require dedicated smoke[\s\S]*?<<'JS'\n([\s\S]*?)\n\s+JS/)?.[1];
  assert.ok(setup);
  const validPath = workflow.match(/name: Update the same agent[\s\S]*?path: (\S+)/)?.[1];
  const duplicatePath = workflow.match(/name: Reject duplicate[\s\S]*?path: (\S+)/)?.[1];
  assert.ok(validPath && duplicatePath);
  await mkdir(path.join(f.root, 'test/fixtures'), { recursive: true });
  await copyFile(new URL('./fixtures/recipe.yaml', import.meta.url), path.join(f.root, 'test/fixtures/recipe.yaml'));
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    input: setup, encoding: 'utf8', cwd: f.root, env: { TEST_AGENT: 'myorg~example' },
  });
  assert.equal(result.status, 0, result.stderr);
  const valid = path.resolve(f.root, validPath);
  const duplicate = path.resolve(f.root, duplicatePath);
  await mkdir(path.join(valid, '.guild'));
  await writeFile(path.join(valid, '.guild/state.json'), '{"base_version_id":"previous-save"}');
  assert.equal((await readFile(path.join(duplicate, 'VERSION'), 'utf8')).trim(), '1.0.1');
  assert.notEqual(await readFile(path.join(duplicate, 'recipe.yaml'), 'utf8'), await readFile(path.join(valid, 'recipe.yaml'), 'utf8'));
  await assert.rejects(readFile(path.join(duplicate, '.guild/state.json')), { code: 'ENOENT' });
});

test('smoke verifies publication and the exact failed draft with no published version number', async t => {
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
  ['public target after private creation', { public: true }],
  ['different agent after updating', { wrongAgent: true }],
  ['missing initial publication', { missingInitial: true }],
  ['missing failed validation evidence', { missingInvalid: true }],
  ['missing local attempt state', { missingState: true }],
  ['unrelated failed draft instead of this attempt', { wrongState: true }],
  ['successful validation with an unrelated older failure', { validationPassed: true, unrelatedFailure: true }],
  ['duplicate published version', { duplicate: true }],
]) {
  test(`smoke refuses ${name}`, async t => {
    const f = await fixture(t, options);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes('Valid publication confirmed'));
    assert.ok(!result.stderr.includes('synthetic-secret'));
  });
}
