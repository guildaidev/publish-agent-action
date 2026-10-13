<!-- Copyright 2026 Guild.ai; SPDX-License-Identifier: Apache-2.0 -->
# Publish Agent to Guild

Publish agents from your GitHub repository to [Guild](https://app.guild.ai).
Choose manual releases, releases on merge, or GitHub Release events. This Action
uploads the selected directory, waits for Guild validation, and publishes the version.
Your repository can be private: the workflow sends files to Guild, so Guild does
not need access to your GitHub repository.

[Official setup guide](https://docs.guild.ai/cli/github-actions) ·
[GitHub Marketplace](https://github.com/marketplace/actions/publish-agent-to-guild) ·
[Release v1.0.0](https://github.com/guildaidev/publish-agent-action/releases/tag/v1.0.0)

No prior `guild agent clone`, `guild.json`, or pre-created agent is required.
The walkthrough below creates a private Goose agent and then updates it.
For an existing agent, use its target, type, source format, and a higher version.

## Quick start

### 1. Configure the publishing key

1. Sign in to Guild and use the account switcher to select the personal account
   or organization that will own the agent.
2. Open **Access & setup > API keys**. [Create a key](https://docs.guild.ai/platform/api-keys)
   with **Agents: Read & write**
   (`agents:write`), leaving other permissions at **No access** for this example.
   Ask your Guild account admin if you cannot create keys.
3. In your GitHub repository, open **Settings > Secrets and variables > Actions**.
   Add a repository secret named `GUILD_API_KEY` with the full
   `<api_key_id>:<api_key_secret>` value shown by Guild.
4. Choose a target such as `myorg~hello`. Replace `myorg` with the account's
   URL name, not its display name or your email address. It must be the key's account.

The key can write **all agents in its account**, not just this target. Never
commit it, print it, or paste it into a coding-agent conversation. Use a dedicated
evaluation account for a trial if needed. The Action uses this key, not browser OAuth
or your local login. [Local OAuth publishing](#publish-locally-with-browser-login)
is also available.

You need permission to add workflows and store Actions secrets, and your
organization must allow this Action. Ask your repository owner if those controls
are restricted. No Guild GitHub App installation is needed.

### 2. Add an agent directory

Create `agents/hello/recipe.yaml` in your repository:

```yaml
description: A simple greeting agent
instructions: |
  Reply with a brief greeting. Do not request private information or use tools.
```

This example has no dependencies. For your own package, use the format expected
by its agent type and provision its required skills and integrations first.
Private skill dependencies also require **Skills: Read** on the key. The Action
does not convert agent formats or install those dependencies for you.

Point `path` at one agent folder, not the whole monorepo. Repository, parent-folder,
and nested `.gitignore` rules apply, including negation. `.git`, `.guild`,
`node_modules`, `dist`, `.env*`, `guild.json`, `.npmrc`, `.DS_Store`, and `Thumbs.db`
are always excluded. Parent ignore files are not uploaded; global Git excludes,
`.git/info/exclude`, and tracked-file status do not control collection.
Files must be UTF-8. Each save is a full source snapshot.

### 3. Add the workflow

Save this as `.github/workflows/publish-agent.yml`. Replace both `myorg~hello`
and the concurrency group with your target. Change the branch condition if your
default branch is not `main`. Merge the workflow and recipe onto that branch.

```yaml
name: Publish agent
on:
  workflow_dispatch:
    inputs:
      version:
        description: New agent version
        required: true
        default: '1.0.0'
        type: string

permissions:
  contents: read

concurrency:
  group: guild-publish-myorg-hello
  cancel-in-progress: false

jobs:
  publish:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          persist-credentials: false
      - name: Publish to Guild
        id: publish
        uses: guildaidev/publish-agent-action@v1.0.0
        with:
          path: agents/hello
          agent: myorg~hello
          version: ${{ inputs.version }}
          create-if-missing: 'true'
          agent-type: GOOSE
          overwrite: 'true'
        env:
          GUILD_API_KEY: ${{ secrets.GUILD_API_KEY }}
```

**Before running:** `create-if-missing` permits creating that name as a private
agent. Existing targets must match `agent-type`. `overwrite: 'true'` explicitly
makes repository source authoritative over Guild editor changes in the new version.
Omit `overwrite` if you want conflicting saves to stop for review. Neither option
replaces an already-published version or changes an existing agent's visibility.

Reuse the same concurrency group in other workflows in this repository that
publish this target. This prevents overlapping publications from those workflows.

### 4. Publish and verify

1. Open **Actions > Publish agent > Run workflow**, select `main`, and enter `1.0.0`
   for a new agent. For an existing agent, choose a version higher than its latest
   published version. Running this workflow publishes; it is not a dry run.
2. Wait for success, then find the agent in the selected Guild account and confirm
   its published version. A new agent is private; an existing agent keeps its visibility.
3. Change the instruction in a pull request and merge it. Run the workflow again
   with `1.0.1` (or the next version for your existing agent).
4. Confirm that the same agent has the new published version.

Validation failure fails the job and leaves the previously published version
unchanged. A first-release failure can leave an unpublished private agent for
inspection. Publishing does not create a workspace or start a session: add the
agent to a test workspace and run it separately to verify its runtime behavior.

## Choose release timing

The quick start uses manual releases. Choose one publishing trigger per release
to avoid trying to publish the same version twice.

### Automatically after merge

Replace the workflow's `on` block with:

```yaml
on:
  push:
    branches: [main]
    paths: ['agents/hello/**', '.github/workflows/publish-agent.yml']
```

Also replace `version: ${{ inputs.version }}` with an explicit source-controlled
value, such as `version: '1.0.2'` after both quick-start releases. Bump it in each
release PR. Keep the job's `main` condition. This runs after any matching push to
`main`, including a merged PR; repository protections determine who can push.

### On a GitHub Release

Instead, use this trigger and change the publish job's `if` condition to
`github.event_name == 'release'` (release events use a tag, not `refs/heads/main`):

```yaml
on:
  release:
    types: [published]
```

Replace `version: ${{ inputs.version }}` with the next agent version in source
before tagging the commit. The default checkout uses the release's tagged commit.
The Action does not infer an agent version from your GitHub Release tag.
Publish releases only from reviewed, trusted commits.

Never expose the publishing key to untrusted PR code, including through
`pull_request_target`. Keep PR validation separate from publishing after review.

## Publish multiple agents

One invocation maps one directory to one target. Repeat the publish step for each
agent, changing its `path`, `agent`, `version`, and step `id`. For example, a second
Goose agent in the same job can use:

```yaml
- name: Publish the second agent
  id: publish_second
  uses: guildaidev/publish-agent-action@v1.0.0
  with:
    path: agents/second
    agent: myorg~second
    version: '1.0.0'
    create-if-missing: 'true'
    agent-type: GOOSE
    overwrite: 'true'
  env:
    GUILD_API_KEY: ${{ secrets.GUILD_API_KEY }}
```

Create a supported package in `agents/second` first. Use sequential steps when
order matters, or a matrix with per-target concurrency for independent agents.
For a single job publishing several agents, use one concurrency group for that
release bundle and avoid overlapping workflows for the same targets.

Select only agents you intend to release, and give each existing target a new
version. The Action does not discover packages, publish dependencies automatically,
or provide an atomic batch release: an earlier successful publication remains if
a later one fails.

## Inputs and outputs

| Input | Meaning |
| --- | --- |
| `path` | Required source directory inside the checkout, including symlinks. |
| `agent` | Required target in `owner~name` form. |
| `version` | Optional CLI `--version-number` override. Otherwise use the CLI's `--no-bump` behavior described below. |
| `overwrite` | Default `false`. `true` passes `--force`, making repo source authoritative over Guild editor changes. |
| `create-if-missing` | Default `false`. `true` permits private creation; requires `agent-type`. |
| `agent-type` | Only with creation: `GUILD_TYPESCRIPT`, `GUILD_NATIVE`, `GOOSE`, `OPENCLAW`, or `LANGGRAPH`, subject to the account's enabled types. |

The Action passes `--no-bump`: it does not edit `package.json`. Without the
`version` input, the CLI uses the package version when present; for packages
without one (such as Goose), it derives the next patch, starting at `1.0.0`.
Use an explicit version for reproducible releases. A `VERSION` file is **not**
interpreted by this Action.

Outputs `agent-id`, `version-id`, and `version` come from a successful CLI save.
Read them as, for example, `steps.publish.outputs.version-id` in a later step.
`cli-version` reports the installed CLI, even when a later save fails.
`failure-reason` is `missing-api-key` only when that key is absent.

## Publish locally with browser login

For interactive use, the CLI supports browser OAuth without an API key:

```bash
npm install --global @guildai/cli@0.27.2
unset GUILD_API_KEY
guild auth login
guild auth status
guild agent save myorg~hello --path ./agents/hello \
  --create-if-missing --agent-type GOOSE \
  --version-number 1.0.0 --no-bump --publish
```

Complete the browser approval and confirm the signed-in identity before publishing.
Use an account where that user can write agents. For an existing agent, choose a
higher version. Review any overwrite prompt; use `--force` only with explicit
consent to replace Guild editor changes. `GUILD_API_KEY` takes precedence over
stored login, which is why the example unsets it. Do not put browser tokens in CI.

## Set up with a coding agent

Copy this into Claude Code, Codex, or another coding agent with repository access:

```text
Set up one-way agent publishing to Guild using this guide:
https://docs.guild.ai/cli/github-actions

Inspect the agent directories, formats, and dependencies. Report incompatibilities;
do not silently drop unsupported fields. Ask me to confirm each owner~name target,
private creation, overwrite consent, versions, and manual vs automatic releases.
Use guildaidev/publish-agent-action@v1.0.0, contents: read, checkout without persisted
credentials, and concurrency for each target or release bundle. Keep publishing
off pull_request and pull_request_target. Explain where I should store the scoped
GUILD_API_KEY secret; never ask for it in chat, read it back, print it, or commit it.
Validate the workflow and show the diff for review. Do not merge or publish without
my approval. After an approved test, verify the Guild agent and published version;
report runtime testing separately.
```

## Troubleshooting

| Problem | What to do |
| --- | --- |
| No **Run workflow** button | Merge the manual workflow onto the repository's default branch. Check Actions permissions and the branch condition. |
| Missing or rejected key | Check the secret name, full `id:secret` value, owning account, and `agents:write` permission. The Action cannot fall back to browser login. |
| Agent not found | Check `owner~name`. Use `create-if-missing` and `agent-type` only if creating that target is intended. Permission errors do not authorize creation. |
| Missing dependency or unsupported recipe field | Provision required dependencies and use Guild's supported package format. For example, Goose `extensions` and `sub_recipes` are not supported. The Action does not rewrite recipes. |
| Version already published | Choose a strictly higher version. Retrying the same version is not a successful no-op. |
| Conflicting Guild edits | Review the differences. Set `overwrite: 'true'` only if repository source should replace them. |
| Timeout or lost connection | Inspect the target's versions in Guild before retrying; publication may have progressed before the runner stopped waiting. |

For help, [open an issue](https://github.com/guildaidev/publish-agent-action/issues)
with the Action/CLI versions and a redacted error. Do not attach secrets or private
source. Revoke the Guild key and remove the GitHub secret when no longer needed.

## Compatibility and maintenance

- `v1.0.0` installs **Guild CLI 0.27.2**. Upgrades require a reviewed pin update and
  a new Action release; it does not install `latest` automatically. For an immutable
  Action pin, use `@d5f1dc7abe6bab172653d1ab16f4d5f68ea54e0c`.
- Use GitHub-hosted Ubuntu. The Action sets up Node.js 22 and uses Bash and jq.
  It installs the CLI without the publishing key or npm lifecycle scripts, then
  runs `guild agent save --publish` against `https://app.guild.ai` with isolated login state.
- This is one-way release, not two-way synchronization. It does not change visibility,
  delete agents, or directly upgrade workspace installations. Existing workspace
  autoupdate settings still apply.
- Package validation and runtime compatibility are separate from file transport.
  Not every upstream agent recipe is supported unchanged.

Maintainers: run `node --test test/*.test.mjs`; see
[Maintaining the Action](MAINTAINING.md) for the full validation and release checklist.
License: [Apache-2.0](LICENSE).
