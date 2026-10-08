// Copyright 2026 Guild.ai
// SPDX-License-Identifier: Apache-2.0
import { appendFile, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const env = process.env;
const key = env.GUILD_API_KEY?.trim();
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function redact(text) {
  let result = String(text);
  for (const secret of [key, key?.split(':').slice(1).join(':')]) {
    if (secret) result = result.split(secret).join('***');
  }
  return result;
}

function annotation(text) {
  return redact(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function sourceFile(source, name) {
  const file = path.join(source, name);
  let resolved;
  try { resolved = await realpath(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!inside(source, resolved)) throw new Error(`${name} must stay inside the source directory.`);
  return readFile(resolved, 'utf8');
}

async function sourceVersion(source, explicit) {
  const file = await sourceFile(source, 'VERSION');
  const manifest = await sourceFile(source, 'package.json');
  const values = [explicit, file?.trim(), manifest === null ? null : JSON.parse(manifest).version]
    .filter(value => value !== null && value !== undefined && value !== '');
  if (!values.length) throw new Error('Provide a VERSION file, package.json version, or the version input. No automatic version bump is performed.');
  if (values.some(value => typeof value !== 'string' || !stableVersion.test(value))) {
    throw new Error('Version must be stable MAJOR.MINOR.PATCH (for example 1.2.3).');
  }
  if (new Set(values).size !== 1) throw new Error('The version input, VERSION file, and package.json version must agree when present.');
  return values[0];
}

function runCli(cli, args, cliEnv, cwd) {
  // Pass arguments directly, never through a shell. No source code or lifecycle
  // script from the customer's checkout is executed by this wrapper.
  const result = spawnSync(process.execPath, [cli, '--mode', 'json', ...args], {
    cwd, env: cliEnv, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    timeout: 11 * 60 * 1000,
  });
  // Modern commands must start a line; legacy ##[...] commands can appear
  // anywhere. Neutralize both before replaying untrusted CLI/build output.
  for (const line of redact(result.stderr || '').replaceAll('\r', '').split('\n')) {
    if (line) console.error(`guild: ${line.replaceAll('##[', '##\\[')}`);
  }
  if (result.error || result.status !== 0) {
    throw new Error(`Guild CLI ${args.slice(0, 2).join(' ')} failed${result.signal ? ` (${result.signal})` : ''}. Inspect the logs and Guild version before retrying; this Action does not retry publication.`);
  }
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('Guild CLI did not return a JSON result. Publication is not confirmed. Inspect Guild before retrying.'); }
}

async function main() {
  if (!key) throw Object.assign(new Error('Set GUILD_API_KEY to a Guild account API key with Agents: Write. Browser login is not used by this Action.'), { code: 'MISSING_API_KEY' });
  const cliVersion = env.GUILD_PUBLISH_CLI_VERSION;
  if (!cliVersion || !stableVersion.test(cliVersion)) throw new Error('The Action must supply the verified installed CLI version.');
  const agent = env.GUILD_PUBLISH_AGENT?.trim();
  if (!agent || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*~[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(agent)) {
    throw new Error('agent must be an explicit owner~name for an existing Guild agent.');
  }
  const overwrite = env.GUILD_PUBLISH_OVERWRITE || 'false';
  if (!['true', 'false'].includes(overwrite)) throw new Error('overwrite must be true or false.');
  if (!env.GUILD_PUBLISH_PATH?.trim()) throw new Error('path must name the agent source directory.');
  if (!env.GITHUB_WORKSPACE || !env.RUNNER_TEMP || !env.GITHUB_OUTPUT || !env.GITHUB_STEP_SUMMARY || !env.GUILD_PUBLISH_CLI) {
    throw new Error('Run this script through the Guild publishing Action in GitHub Actions.');
  }
  const workspace = await realpath(env.GITHUB_WORKSPACE);
  const source = await realpath(path.resolve(workspace, env.GUILD_PUBLISH_PATH));
  if (!inside(workspace, source)) throw new Error('path must stay inside the checked-out repository, including symlinks (checkout boundary).');
  if (!(await stat(source)).isDirectory()) throw new Error('path must be a directory.');
  const version = await sourceVersion(source, env.GUILD_PUBLISH_VERSION?.trim());
  const releaseSource = `${env.GITHUB_REPOSITORY || 'local-source'}@${env.GITHUB_SHA || 'unknown'}`;
  // Metadata is one line and passed as an argument, not interpolated in shell.
  if (/[\r\n]/.test(releaseSource)) throw new Error('Source repository and commit metadata must be single-line values.');
  const stateDir = await mkdtemp(path.join(env.RUNNER_TEMP, 'guild-publish-state-'));
  try {
    const cliEnv = { ...env, GUILD_API_KEY: key, GUILDCORE_URL: 'https://app.guild.ai/api',
      GUILD_STATE_DIR: stateDir, GUILD_CONFIG_DIR: stateDir, CI: 'true', NO_COLOR: '1' };
    delete cliEnv.GUILD_USE_SHARED;
    delete cliEnv.GUILD_USE_LOCAL;
    const before = runCli(env.GUILD_PUBLISH_CLI, ['agent', 'get', agent], cliEnv, workspace);
    if (before.full_name !== agent || !uuid.test(before.id || '') || typeof before.is_public !== 'boolean') {
      throw new Error('Guild returned an unexpected target agent; nothing was published.');
    }
    const args = ['agent', 'save', agent, '--path', source, '--version-number', version,
      '--no-bump', '--publish', '--message', `GitHub Actions release from ${releaseSource}`];
    if (overwrite === 'true') args.push('--force');
    const result = runCli(env.GUILD_PUBLISH_CLI, args, cliEnv, workspace).version;
    if (!result || result.status !== 'PUBLISHED' || result.validation_status !== 'PASSED' ||
        result.version_number !== version || !uuid.test(result.id || '') ||
        result.agent?.id !== before.id || result.agent.full_name !== agent ||
        result.agent.is_public !== before.is_public) {
      throw new Error('Guild did not confirm the requested published version, validation, target, and unchanged visibility. Inspect Guild before retrying.');
    }
    await appendFile(env.GITHUB_OUTPUT, `agent-id=${before.id}\nversion-id=${result.id}\nversion=${version}\n`);
    const summary = `### Published ${agent}@${version}\n\n` +
      `- Version ID: \`${result.id}\`\n- Target: Guild prod\n` +
      `- Visibility: ${before.is_public ? 'public' : 'private'} (unchanged)\n` +
      `- Validation: passed\n- Overwrite consent: ${overwrite}\n- Guild CLI: \`${cliVersion}\`\n` +
      `- Source: \`${releaseSource}\`\n`;
    await appendFile(env.GITHUB_STEP_SUMMARY, summary);
    console.log(`Published ${agent}@${version} (${result.id}).`);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

main().catch(async error => {
  if (error.code === 'MISSING_API_KEY' && env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, 'failure-reason=missing-api-key\n');
  }
  console.error(`::error::${annotation(error.message)}`);
  process.exitCode = 1;
});
