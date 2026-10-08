<!-- Copyright 2026 Guild.ai; SPDX-License-Identifier: Apache-2.0 -->
# Publish Agent to Guild

Publish a Guild agent from a repository directory. This Action uploads
source, waits for Guild validation, and confirms the exact published version and
visibility. It uses the Guild CLI and production API. Missing agents can be
created privately with explicit opt-in.

Put a stable version in the source
directory's `VERSION` file or `package.json`, and store an **Agents: Write** account
API key as the repository secret `GUILD_API_KEY`. That key can write agents across
the account; it is not restricted to the target agent.

## Usage

This complete workflow supports merges to `main`, manual runs on `main`, and
published GitHub Releases. Replace the directory and target with your agent.
Pin the Action to a reviewed full commit SHA; `v1` below denotes the intended
major release alias, available after the official Action release. Access to this
repository is required while it remains private.

```yaml
name: Publish agent
on:
  push:
    branches: [main]
    paths: ['agents/example/**', '.github/workflows/publish-agent.yml']
  workflow_dispatch:
  release:
    types: [published]

permissions:
  contents: read

concurrency:
  group: guild-publish-myorg-example
  cancel-in-progress: false

jobs:
  publish:
    if: github.event_name == 'release' || github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          persist-credentials: false
      - name: Publish the source version
        id: publish
        uses: guildaidev/publish-agent-action@v1 # Prefer a reviewed full commit SHA.
        with:
          path: agents/example
          agent: myorg~example
          overwrite: 'true'
        env:
          GUILD_API_KEY: ${{ secrets.GUILD_API_KEY }}
```

For a single trigger, keep only the desired `push`, `workflow_dispatch`, or
`release` entry. Release runs check out the release tag. Manual and merge runs
use the selected source commit. Commit a new source version before each release;
enabling multiple triggers for the same version can cause duplicate-version
failures. Use the same per-agent concurrency group in other publishing workflows
in this repository. Separate repositories must coordinate releases themselves.

`overwrite: 'true'` deliberately makes repository source authoritative over
independent Guild editor changes. It maps to CLI `--force`, which can be needed
for a fresh checkout. It cannot replace an already published version number.

### First release without creating the agent beforehand

Add these inputs to the publishing step and set `VERSION` to `1.0.0` (or set the
package version / `version` input). Use the type that matches your package:

```yaml
with:
  path: agents/example
  agent: myorg~example
  create-if-missing: 'true'
  agent-type: GOOSE
  overwrite: 'true' # Explicit repo-authoritative updates on subsequent releases.
```

The CLI resolves the target, creates it **privately only on a 404**, and publishes
the specified version. Other lookup errors are not permission to create an agent.
If it already exists, it must have the specified type and ordinary save conflict
checks apply. Creation consent alone does not enable `--force`. For later releases,
keep the same target and bump the source version, for example to `1.0.1`.

Creation and publication are not transactional. Failed validation can leave a
private, unpublished agent; inspect it before retrying. The Action does not delete
it, retry publication, generate version numbers, or change visibility. Double-check
the target spelling before enabling creation.

## Inputs and outputs

| Input | Meaning |
| --- | --- |
| `path` | Required agent source directory inside the checkout, including symlinks. |
| `agent` | Required `owner~name` agent; must exist unless creation is explicitly enabled. |
| `version` | Optional stable `MAJOR.MINOR.PATCH`. Otherwise read `VERSION` or `package.json`. All supplied values must agree. |
| `overwrite` | `false` by default. Explicit `true` permits CLI `--force`. |
| `create-if-missing` | `false` by default. Explicit `true` delegates private creation to the CLI; requires `agent-type` and a lowercase target. |
| `agent-type` | Only with `create-if-missing`: `GUILD_TYPESCRIPT`, `GUILD_NATIVE`, `GOOSE`, `OPENCLAW`, or `LANGGRAPH`. Must match an existing target. |
| `cli-version` | `0.27.1` by default. An exact stable version at least `0.27.1`, or the explicit tag `latest`. |

Outputs after confirmed publication are `agent-id`, `version-id`, and `version`.
`cli-version` reports the verified installed CLI version, including when later
publication fails. `failure-reason` is `missing-api-key` when the key is absent
and the publishing step fails before contacting Guild; it is empty otherwise.
No successful-publication outputs are emitted on failure.

The **Action release** (`v1` or a commit SHA), **CLI version** (`0.27.1`), and
**agent source version** (for example `1.2.3`) are separate values. To override
the CLI, set `cli-version` to another published stable version or `latest`. `latest`
resolves once and installs that exact stable version. Ranges, prereleases, URLs,
paths, and alternative packages are rejected. The minimum version does not
guarantee compatibility with future CLI releases; test overrides before using
them for production releases.

## Behavior and limits

- Publishes without requiring a prior clone or `guild.json`. Missing agents are
  an error unless `create-if-missing` and `agent-type` are provided. Every release,
  including the first, requires a source version or explicit `version` input.
- Uses one-way publication and preserves visibility. The Action issues no
  workspace upgrades; existing Guild auto-update settings still apply and may
  move workspace installations to the newly published version.
- Adds no publication retries. After failure or timeout, inspect Guild and the
  logs before retrying; publication may have progressed before a connection failed.
- Checks the existing target's ID and visibility before publishing. If lookup
  fails with creation enabled, the CLI's save resolver decides whether creation
  is permitted. Without preflight evidence, the Action only confirms a private
  result; inspect Guild if that final check fails after publication.
- Uses the CLI's file filtering, including the source directory's `.gitignore`
  and mandatory local-file exclusions. Review the selected source directory.
- Supports GitHub-hosted Ubuntu runners with Node.js 22. The wrapper does not
  execute source scripts or install agent dependencies; Guild builds and validates
  the uploaded source through its existing pipeline.

## Authentication

Give the key only to trusted release workflows. PR CI must not receive it, and
`pull_request_target` must not run PR source with the key. Anyone able to modify a
credential-bearing workflow can exercise the key's account permissions.

The Action installs the official CLI from public npm in a fresh directory with
lifecycle scripts disabled and a sanitized, credential-free environment. Setup
and installation suppress the publishing key. Publication uses isolated CLI
state and the fixed `https://app.guild.ai/api` endpoint, without browser-login
fallback. CLI logs are redacted and neutralized before replay to GitHub Actions.

## Validation

Run `node --test test/*.test.mjs` locally. Tests exercise the real scripts against
controlled external npm and Guild CLI boundaries. PR CI also invokes the complete
composite without a key and separately checks installation and authentication
rejection.

The `Authenticated smoke` workflow is a post-merge test on `main`. It requires a
dedicated **unused** `owner~name` in `GUILD_TEST_AGENT`, a test account key in the
`GUILD_TEST_API_KEY` secret, and explicit creation/update consent. It creates a
private Goose agent at `1.0.0`, updates the same agent to `1.0.1`, rejects duplicate
`1.0.1` and invalid `1.0.2` releases, then verifies private visibility, both valid
versions, failed validation evidence, and the unchanged working publication.
Use a new unused test name for each fresh run. Test artifacts are left in Guild
for inspection, not automatically deleted. Missing configuration fails visibly. Authenticated
validation remains pending until a
successful configured run; credential-free tests do not establish it.

License: [Apache-2.0](LICENSE).
