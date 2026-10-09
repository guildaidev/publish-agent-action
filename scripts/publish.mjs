// Copyright 2026 Guild.ai
// SPDX-License-Identifier: Apache-2.0
import { appendFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const env = process.env;
const key = env.GUILD_API_KEY?.trim();

// Build diagnostics are untrusted log text, not GitHub workflow commands.
function log(text) {
  for (const secret of [key, key?.split(':').slice(1).join(':')]) {
    if (secret) text = text.split(secret).join('***');
  }
  for (const line of text.replaceAll('\r', '').split('\n')) {
    if (line) console.error('guild: ' + line.replaceAll('##[', '##\\['));
  }
}

async function main() {
  if (!key) {
    await appendFile(env.GITHUB_OUTPUT, 'failure-reason=missing-api-key\n');
    throw new Error('Set GUILD_API_KEY to an account API key with Agents: Write. Browser login is not used.');
  }
  if (!env.GUILD_PUBLISH_PATH?.trim() || !env.GUILD_PUBLISH_AGENT?.trim()) {
    throw new Error('path and agent are required.');
  }
  // Values must not become options, including the CLI's global environment flags.
  for (const name of ['GUILD_PUBLISH_AGENT', 'GUILD_PUBLISH_VERSION', 'GUILD_PUBLISH_AGENT_TYPE']) {
    if (env[name]?.trimStart().startsWith('-')) throw new Error(name + ' must not start with "-".');
  }
  for (const name of ['GUILD_PUBLISH_OVERWRITE', 'GUILD_PUBLISH_CREATE_IF_MISSING']) {
    if (!['true', 'false'].includes(env[name] || 'false')) throw new Error(name + ' must be true or false.');
  }
  const workspace = await realpath(env.GITHUB_WORKSPACE);
  const source = await realpath(path.resolve(workspace, env.GUILD_PUBLISH_PATH));
  const relative = path.relative(workspace, source);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('path must stay inside the checked-out repository.');
  }
  const args = ['--mode', 'json', 'agent', 'save', env.GUILD_PUBLISH_AGENT, '--path', source,
    '--no-bump', '--publish', '--message',
    `GitHub Actions release from ${env.GITHUB_REPOSITORY}@${env.GITHUB_SHA}`];
  if (env.GUILD_PUBLISH_VERSION) args.push('--version-number', env.GUILD_PUBLISH_VERSION);
  if (env.GUILD_PUBLISH_CREATE_IF_MISSING === 'true') args.push('--create-if-missing');
  if (env.GUILD_PUBLISH_AGENT_TYPE) args.push('--agent-type', env.GUILD_PUBLISH_AGENT_TYPE);
  if (env.GUILD_PUBLISH_OVERWRITE === 'true') args.push('--force');

  const state = await mkdtemp(path.join(env.RUNNER_TEMP, 'guild-publish-'));
  try {
    const cliEnv = { ...env, GUILD_API_KEY: key, GUILDCORE_URL: 'https://app.guild.ai/api',
      GUILD_STATE_DIR: state, GUILD_CONFIG_DIR: state, CI: 'true', NO_COLOR: '1' };
    delete cliEnv.GUILD_USE_SHARED;
    delete cliEnv.GUILD_USE_LOCAL;
    // One CLI call owns resolution, creation, versioning, validation and publish.
    const result = spawnSync('guild', args, { cwd: workspace, env: cliEnv, encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, timeout: 11 * 60 * 1000 });
    log(result.stderr || '');
    if (result.error) throw result.error;
    if (result.status !== 0) {
      log(result.stdout || '');
      process.exitCode = result.status || 1;
      return;
    }
    const { version } = JSON.parse(result.stdout);
    const outputs = { 'agent-id': version?.agent?.id, 'version-id': version?.id, version: version?.version_number };
    if (Object.values(outputs).some(value => typeof value !== 'string' || !value || /[\r\n]/.test(value))) {
      throw new Error('CLI returned no version identifiers. Inspect Guild before retrying.');
    }
    await appendFile(env.GITHUB_OUTPUT, Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`).join(''));
    log(`Published ${env.GUILD_PUBLISH_AGENT}@${version.version_number} (${version.id}).`);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}

main().catch(error => {
  log(error.message);
  process.exitCode = 1;
});
