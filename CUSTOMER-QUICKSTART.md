<!-- Copyright 2026 Guild.ai; SPDX-License-Identifier: Apache-2.0 -->
# First release to Guild

Publish an agent from your repository into your Guild account. Guild does not
need access to your GitHub repository: your workflow uploads the selected files.

**Launch status (9 October 2026):** the Action has passed its hosted production
smoke test, but this repository is still private and has no release tag. This
guide is ready for review, not yet an externally runnable customer invitation.
Before handing it off, the Guild team must open distribution and verify the
Action from a separate repository. Marketplace listing is not required to use it.

## 1. Prepare your account and one agent folder

- Create a Guild account API key with **Agents: Write**. It covers all agents in
  that account, so use a dedicated evaluation account for a first trial.
- In your GitHub repository, add it as the Actions secret `GUILD_API_KEY`.
  You need permission to configure secrets and workflows, and your organization
  must allow this Action. Ask your repository owner if those controls are restricted.
- Choose a new target such as `your-account~hello`. The account must match the key.

For a minimal Goose trial, save this as `agents/hello/recipe.yaml`. Goose must be
enabled in your Guild account. This recipe is the fixture used by our hosted smoke.

```yaml
title: Publishing Action Example
description: A minimal Goose agent used to verify publication.
instructions: |
  Reply with a brief greeting. Do not request private information or use tools.
```

## 2. Add a manual release workflow

Save this as `.github/workflows/publish-agent.yml` on your default branch.
Replace `your-account~hello`. This example assumes the branch is `main`.
The pinned Action commit is tested; it becomes externally usable once the repo
is public. No `v1` alias is assumed to exist.

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
  group: guild-publish-hello
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
        uses: guildaidev/publish-agent-action@1ee48f8806754e238288b2558a28991bac7db175
        with:
          path: agents/hello
          agent: your-account~hello
          version: ${{ inputs.version }}
          create-if-missing: 'true'
          agent-type: GOOSE
          overwrite: 'true'
        env:
          GUILD_API_KEY: ${{ secrets.GUILD_API_KEY }}
```

`create-if-missing` explicitly permits creating a missing agent **privately**.
`overwrite` makes repository source authoritative over Guild editor changes; it
does not overwrite an already-published version. Double-check the target name.

## 3. Prove the first release and an update

1. Open **Actions → Publish agent → Run workflow**. Select `main` and `1.0.0`.
2. In Guild, find `your-account~hello` and confirm private, published version
   `1.0.0`. No initial agent or prior Guild clone is required.
3. Change the greeting instruction in a PR and merge it. Run the workflow with
   `1.0.1`; verify the same agent now has the new published version.

Publishing does not create a workspace or start the agent. Install it in a test
workspace and run it separately to check runtime behavior. Existing workspace
autoupdate settings determine whether an installation adopts a new version.

## More agents and automatic releases

One invocation publishes one directory to one agent. Repeat the step for another
agent; use sequential steps when one depends on another. A matrix works for
independent agents. There is no repo-wide discovery, dependency installation or
atomic batch: earlier successful publications remain if a later one fails.

For merge-triggered publishing, use the [README workflow](README.md#usage) and
manage a new version for each intended release. The Action does not edit your
source version. Explicit versions make manual retries predictable; publishing
the same version twice is an error, not a successful no-op. Inspect Guild after
a timeout before retrying.

## Bringing your own package

Start with a package supported by the selected Guild runtime. Accepting
`agent-type` is not a promise to run arbitrary source from that ecosystem.
Install required skills/integrations first. A private skill dependency also
requires **Skills: Read** on the publishing key; do not grant broader permissions
unless the package actually needs them.

Goose packages that rely on unsupported settings, extensions or application
orchestration need compatibility work. The Action reports Guild's validation
failure; it does not silently rewrite or discard unsupported behavior. Keep the
first pilot small and verify both publication and a real run.

Give the key only to trusted release workflows, never untrusted pull-request
source. Remove the secret and revoke the key when the trial ends unless you
intend to keep releasing. See [inputs, outputs and boundaries](README.md#inputs-and-outputs).
