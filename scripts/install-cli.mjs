// Copyright 2026 Guild.ai
// SPDX-License-Identifier: Apache-2.0
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const env = process.env;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function supported(version) {
  if (typeof version !== 'string' || !stableVersion.test(version)) return false;
  const [major, minor] = version.split('.').map(BigInt);
  return major > 0n || minor >= 26n;
}

function run(command, args, installEnv, cwd) {
  const result = spawnSync(command, args, { cwd, env: installEnv, encoding: 'utf8',
    timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });
  // Do not replay npm output, which can contain untrusted workflow commands.
  if (result.error || result.status !== 0) throw new Error('Guild CLI installation or version verification failed. No publication was attempted.');
  return result.stdout;
}

async function main() {
  const requested = env.GUILD_PUBLISH_CLI_VERSION || '0.26.0';
  if (requested !== 'latest' && !supported(requested)) {
    throw new Error('CLI version must be an exact stable MAJOR.MINOR.PATCH >= 0.26.0, or latest.');
  }
  if (!env.RUNNER_TEMP || !env.GITHUB_OUTPUT) throw new Error('Run the CLI installer through GitHub Actions.');
  const dir = await realpath(await mkdtemp(path.join(env.RUNNER_TEMP, 'guild-publish-cli-')));
  try {
    if (/[\r\n]/.test(dir)) throw new Error('CLI installation path must be a single-line value.');
    const userconfig = path.join(dir, 'user.npmrc');
    const globalconfig = path.join(dir, 'global.npmrc');
    await writeFile(userconfig, '');
    await writeFile(globalconfig, '');
    // An allowlist removes npm auth/config, Guild credentials, NODE_OPTIONS,
    // cloud tokens and all other runner secrets from every install subprocess.
    const installEnv = { PATH: env.PATH, HOME: dir, CI: 'true', NO_COLOR: '1' };
    const config = ['--registry=https://registry.npmjs.org', `--userconfig=${userconfig}`,
      `--globalconfig=${globalconfig}`, `--cache=${path.join(dir, 'cache')}`];
    const resolved = JSON.parse(run('npm', ['view', `@guildai/cli@${requested}`, 'version', '--json', ...config], installEnv, dir));
    if (!supported(resolved) || (requested !== 'latest' && resolved !== requested)) {
      throw new Error('Registry did not resolve the requested supported CLI version.');
    }
    run('npm', ['install', '--prefix', dir, ...config, '--ignore-scripts', '--no-audit',
      '--no-fund', '--save-exact', '--package-lock=false', `@guildai/cli@${resolved}`], installEnv, dir);
    const packageDir = path.join(dir, 'node_modules', '@guildai', 'cli');
    const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
    if (manifest.name !== '@guildai/cli' || manifest.version !== resolved) {
      throw new Error('Installed Guild CLI package does not match the resolved version.');
    }
    const entrypoint = await realpath(path.join(packageDir, 'bin', 'guild.js'));
    const relative = path.relative(dir, entrypoint);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || /[\r\n]/.test(entrypoint)) {
      throw new Error('Installed CLI entrypoint must stay inside its isolated directory.');
    }
    const reported = run(process.execPath, [entrypoint, '--version'], installEnv, dir).trim();
    if (reported !== resolved) throw new Error('Guild CLI executable did not report the resolved version.');
    await appendFile(env.GITHUB_OUTPUT, `entrypoint=${entrypoint}\ncli-version=${resolved}\n`);
    console.log(`Installed Guild CLI ${resolved}.`);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

main().catch(error => {
  const message = String(error.message).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.error(`::error::${message}`);
  process.exitCode = 1;
});
