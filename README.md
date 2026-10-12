<!-- Copyright 2026 Guild.ai; SPDX-License-Identifier: Apache-2.0 -->
# Publish Agent to Guild

Publish an agent from a repository directory. This Action installs the Guild CLI
and runs `guild agent save --publish`. Guild handles source validation and publication.
No prior clone or `guild.json` is required.

[Setup guide](https://docs.guild.ai/cli/github-actions) ·
[GitHub Marketplace](https://github.com/marketplace/actions/publish-agent-to-guild) ·
[Release v1.0.0](https://github.com/guildaidev/publish-agent-action/releases/tag/v1.0.0)

Your source repository can be private. The workflow sends files to Guild;
you do not need to grant Guild access to your GitHub repository.

The Action pins Guild CLI **0.27.2**. CLI upgrades are reviewed pin-update PRs
and ship with a new Action release, not automatic updates to `latest`.

## Usage

Store a [Guild account API key](https://docs.guild.ai/platform/api-keys) with
**Agents: Read & write** (`agents:write`) as the repository secret `GUILD_API_KEY`.
Use the full `<api_key_id>:<api_key_secret>` value. The key can write agents across
that account, not just this agent. Never commit it or paste it into a coding-agent chat.

**Publishing locally instead?** The CLI also supports browser OAuth through
`guild auth login`, with no API key required. See the
[local publishing instructions](https://docs.guild.ai/cli/github-actions#publish-locally-with-browser-login).
This Action uses an account API key only, not browser OAuth or your local login.

Save the workflow below as `.github/workflows/publish-agent.yml`. Replace the
source path and `myorg~example` with your existing agent's directory and target.
For a new target, also add the [first-release inputs](#first-release).

```yaml
name: Publish agent
on:
  push:
    branches: [main]
    paths: ['agents/example/**', '.github/workflows/publish-agent.yml']
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: guild-publish-myorg-example
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
          path: agents/example
          agent: myorg~example
          overwrite: 'true'
        env:
          GUILD_API_KEY: ${{ secrets.GUILD_API_KEY }}
```

For an immutable pin, use `@d5f1dc7abe6bab172653d1ab16f4d5f68ea54e0c`, the commit
for `v1.0.0`. Keep `push` for automatic releases, `workflow_dispatch` for manual
releases, or use `release: { types: [published] }` with a matching job condition.

The example sets `overwrite: 'true'`: repository source replaces Guild editor
changes in the new version. Omit it unless the repository is your source of truth.
It does not replace an already-published version or change visibility.

The [setup guide](https://docs.guild.ai/cli/github-actions) includes a complete
manual-release walkthrough, versioning, multiple agents, troubleshooting, and a
copy-paste prompt for Claude Code, Codex, or another coding agent.

### First release

To create a missing agent privately, add:

```yaml
with:
  path: agents/example
  agent: myorg~example
  version: '1.0.0'
  create-if-missing: 'true'
  agent-type: GOOSE
  overwrite: 'true' # Also consent to repo-authoritative updates on later runs.
```

The CLI creates only when the target returns HTTP 404. Other errors do not
authorize creation. Existing targets must match the requested type. Creation is
opt-in and does not imply overwrite consent; double-check the target name.
Failed validation can leave a private unpublished agent for inspection.
After a successful first release, increase the explicit version for the next
release, for example to `1.0.1`. Do not leave `1.0.0` in an automatic workflow.

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
`cli-version` reports the installed CLI, even when a later save fails.
`failure-reason` is `missing-api-key` only when that key is absent.

## Boundaries

- One-way release only. No visibility changes, automatic deletion, publication
  retries, or direct workspace upgrades. Existing workspace autoupdate settings apply.
- `overwrite` does not replace a published version number. Bump the version
  before another release. Avoid triggering the same version twice.
- The CLI owns target resolution, versioning, creation, file filtering, validation,
  conflict detection, and publication. This Action does not duplicate those policies.
- Uses GitHub-hosted Ubuntu, its Bash and jq, and Node.js 22. Installs the public npm CLI with lifecycle
  scripts disabled and without the publishing key. It does not install agent dependencies
  or run agent code on the runner.
- Publication uses isolated CLI login state and the fixed production API endpoint,
  with no browser-login fallback. Diagnostics are redacted and treated as log text.
- Give the key only to trusted release workflows. Do not expose it to untrusted PR
  source, including through `pull_request_target`. Anyone who can change a workflow
  receiving the key can exercise its account permissions.
- After a timeout or failure, inspect Guild before retrying: publication may have
  progressed before a connection failed.

## Validation and release

Run `node --test test/*.test.mjs`. Tests execute the inline install and publish
steps in `action.yml`, substituting npm and Guild CLI calls. CI also installs the
real CLI and confirms the composite refuses a missing key.

Before an Action release, run the main-only `Authenticated smoke` workflow with a
dedicated unused `GUILD_TEST_AGENT` and test-account `GUILD_TEST_API_KEY` secret.
It verifies private `1.0.0` creation, same-agent `1.0.1` update, duplicate-version
rejection, and failed validation without replacing the working release.
Test artifacts remain for inspection. Use a new name for each run.

See [Maintaining the Action](MAINTAINING.md) for the release checklist.
License: [Apache-2.0](LICENSE).
