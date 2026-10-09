<!-- Copyright 2026 Guild.ai; SPDX-License-Identifier: Apache-2.0 -->
# Publish Agent to Guild

Publish an agent from a repository directory. This Action installs the Guild CLI
and runs `guild agent save --publish`. Guild handles source validation and publication.
No prior clone or `guild.json` is required.

## Usage

Store a Guild account API key with **Agents: Write** as the repository secret
`GUILD_API_KEY`. The key can write agents across that account, not just this agent.

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
        uses: guildaidev/publish-agent-action@v1 # Prefer a reviewed full commit SHA.
        with:
          path: agents/example
          agent: myorg~example
          overwrite: 'true'
        env:
          GUILD_API_KEY: ${{ secrets.GUILD_API_KEY }}
```

The `v1` alias will be available after the official release. Access to this
repository is required while it is private. Customers control release timing:
keep `push` for automatic releases, `workflow_dispatch` for manual releases, or
use `release: { types: [published] }` with a matching job condition.

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

## Inputs and outputs

| Input | Meaning |
| --- | --- |
| `path` | Required source directory inside the checkout, including symlinks. |
| `agent` | Required target in `owner~name` form. |
| `version` | Optional CLI `--version-number` override. Otherwise use the CLI's `--no-bump` behavior described below. |
| `overwrite` | Default `false`. `true` passes `--force`, making repo source authoritative over Guild editor changes. |
| `create-if-missing` | Default `false`. `true` permits private creation; requires `agent-type`. |
| `agent-type` | Only with creation: `GUILD_TYPESCRIPT`, `GUILD_NATIVE`, `GOOSE`, `OPENCLAW`, or `LANGGRAPH`, subject to the account's enabled types. |
| `cli-version` | Default `0.27.1`. An exact stable version >= `0.27.1`, or `latest`. Test overrides before production use. |

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
- Uses GitHub-hosted Ubuntu and Node.js 22. Installs the public npm CLI with lifecycle
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

Run `node --test test/*.test.mjs`. CI also installs the real CLI and confirms
the composite refuses a missing key.

Before an Action release, run the main-only `Authenticated smoke` workflow with a
dedicated unused `GUILD_TEST_AGENT` and test-account `GUILD_TEST_API_KEY` secret.
It verifies private `1.0.0` creation, same-agent `1.0.1` update, duplicate-version
rejection, and failed validation without replacing the working release.
Test artifacts remain for inspection. Use a new name for each run.

See [Maintaining the Action](MAINTAINING.md) for launch gates.
License: [Apache-2.0](LICENSE).
