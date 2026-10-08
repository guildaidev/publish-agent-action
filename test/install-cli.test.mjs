// Copyright 2026 Guild.ai
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../scripts/install-cli.mjs', import.meta.url));

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'guild-install-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const callsFile = path.join(root, 'calls');
  const npm = path.join(bin, 'npm');
  // Keep the real installer and filesystem; replace only the external npm process.
  await writeFile(npm, `#!${process.execPath}
    import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    const options = ${JSON.stringify(options)};
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, env: process.env, cwd: process.cwd() }) + '\\n');
    if (args[0] === 'view') {
      console.log(JSON.stringify(options.resolved ?? (args[1].endsWith('@latest') ? '0.28.0' : args[1].split('@').at(-1))));
    } else if (args[0] === 'install') {
      if (options.installFailure) { console.error('::warning::untrusted npm output'); process.exit(1); }
      const dir = args[args.indexOf('--prefix') + 1];
      const pkg = path.join(dir, 'node_modules', '@guildai', 'cli');
      mkdirSync(path.join(pkg, 'bin'), { recursive: true });
      const version = options.installed ?? args.at(-1).split('@').at(-1);
      writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: options.name ?? '@guildai/cli', version }));
      writeFileSync(path.join(pkg, 'bin', 'guild.js'), 'console.log(' + JSON.stringify(options.reported ?? version) + ');');
    } else { process.exit(3); }
  `);
  await chmod(npm, 0o755);
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: '/must-not-use-inherited-home',
    RUNNER_TEMP: root,
    GITHUB_OUTPUT: path.join(root, 'output'),
    GUILD_PUBLISH_CLI_VERSION: options.requested ?? '',
    GUILD_API_KEY: 'synthetic-id:synthetic-secret',
    NODE_AUTH_TOKEN: 'synthetic-node-token',
    NPM_TOKEN: 'synthetic-npm-token',
    npm_config_registry: 'https://must-not-use.invalid',
    npm_config_userconfig: '/must-not-use.npmrc',
    NODE_OPTIONS: '--trace-warnings',
    PRIVATE_SERVICE_TOKEN: 'synthetic-private-token',
  };
  return {
    root, env,
    run: () => spawnSync(process.execPath, [script], { env, encoding: 'utf8' }),
    output: () => readFile(env.GITHUB_OUTPUT, 'utf8').catch(() => ''),
    calls: async () => (await readFile(callsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse),
  };
}

for (const [requested, expected] of [['', '0.27.1'], ['0.27.2', '0.27.2'], ['0.28.0', '0.28.0'], ['1.0.0', '1.0.0'], ['latest', '0.28.0']]) {
  test(`installs ${requested || 'the default'} as the exact official CLI version ${expected}`, async t => {
    const f = await fixture(t, { requested });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = await f.calls();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args.slice(0, 4), ['view', `@guildai/cli@${requested || '0.27.1'}`, 'version', '--json']);
    assert.equal(calls[1].args[0], 'install');
    assert.equal(calls[1].args.at(-1), `@guildai/cli@${expected}`);
    const outputs = Object.fromEntries((await f.output()).trim().split('\n').map(line => line.split('=')));
    assert.equal(outputs['cli-version'], expected);
    assert.ok(outputs.entrypoint.startsWith(f.root + path.sep));
    assert.equal(spawnSync(process.execPath, [outputs.entrypoint, '--version'], { encoding: 'utf8' }).stdout.trim(), expected);
  });
}

for (const requested of ['0.25.9', '0.26.0', '0.26.99', '0.27.0', '0.27.1-beta.1', './cli', 'https://example.invalid/cli.tgz', '^0.27.1', '>=0.27.1', '--help', '@other/cli@0.27.1', '01.27.1', '0.27.1\nentrypoint=injected']) {
  test(`rejects unsafe or unsupported CLI selector ${JSON.stringify(requested)} before npm`, async t => {
    const f = await fixture(t, { requested });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLI version/);
    assert.deepEqual(await f.calls(), []);
    assert.equal(await f.output(), '');
  });
}

for (const [name, options] of [
  ['latest below the supported floor', { requested: 'latest', resolved: '0.27.0' }],
  ['latest prerelease', { requested: 'latest', resolved: '0.27.0-beta.1' }],
  ['mismatched registry version', { requested: '0.27.1', resolved: '0.27.2' }],
  ['malformed registry output', { resolved: { version: '0.26.0' } }],
  ['newline registry output', { resolved: '0.26.0\nentrypoint=injected' }],
  ['mismatched installed package', { installed: '0.25.9' }],
  ['wrong installed package name', { name: '@other/cli' }],
  ['mismatched executable version', { reported: '0.25.9' }],
  ['installation failure', { installFailure: true }],
]) {
  test(`reports no outputs for ${name}`, async t => {
    const f = await fixture(t, options);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /::error::/);
    assert.equal(await f.output(), '');
    assert.ok(!result.stderr.includes('synthetic-secret'));
    assert.ok(!result.stderr.split('\n').some(line => line.startsWith('::warning::')));
  });
}

test('isolates npm configuration and cache and removes credential-bearing environment', async t => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  const calls = await f.calls();
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.env.GUILD_API_KEY, undefined);
    assert.equal(call.env.NODE_AUTH_TOKEN, undefined);
    assert.equal(call.env.NPM_TOKEN, undefined);
    assert.equal(call.env.PRIVATE_SERVICE_TOKEN, undefined);
    assert.equal(call.env.NODE_OPTIONS, undefined);
    assert.equal(call.env.npm_config_registry, undefined);
    assert.equal(call.env.npm_config_userconfig, undefined);
    assert.ok(call.env.HOME.startsWith(f.root + path.sep));
    assert.equal(call.cwd, call.env.HOME);
    assert.ok(call.args.includes('--registry=https://registry.npmjs.org'));
    for (const setting of ['userconfig', 'globalconfig', 'cache']) {
      const value = call.args.find(arg => arg.startsWith(`--${setting}=`))?.slice(setting.length + 3);
      assert.ok(value?.startsWith(call.env.HOME + path.sep), setting);
      if (setting !== 'cache') assert.equal(await readFile(value, 'utf8'), '');
    }
  }
  for (const flag of ['--ignore-scripts', '--no-audit', '--no-fund']) assert.ok(calls[1].args.includes(flag));
});
