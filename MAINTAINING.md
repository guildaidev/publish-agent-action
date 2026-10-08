<!-- Copyright 2026 Guild.ai; SPDX-License-Identifier: Apache-2.0 -->
# Maintaining the Action

Before merging or releasing, review changes to subprocess arguments, npm inputs,
credential isolation, workflow-command neutralization, and success verification.
Keep third-party Actions pinned to reviewed full SHAs. Use the same root composite
in examples and smoke tests. Creation is delegated to the shipped CLI 0.27.1+
resolver, never a second create implementation or a parsed error-message heuristic.

Run:

```sh
node --test test/*.test.mjs
actionlint
ruby -e 'require "yaml"; ARGV.each { |file| YAML.safe_load(File.read(file), aliases: true) }' action.yml .github/workflows/ci.yml .github/workflows/smoke.yml
git diff --check
gitleaks git --redact
```

The `CI` workflow must pass its `test` job on the reviewed commit, including the
credential-free composite invocation. Required checks and repository governance
must be configured through the owning Terraform configuration with maintainer
review, rather than ad hoc repository-setting changes. The workflow file does
not configure branch protection.

Authenticated smoke can run only after its trusted workflow is on `main`. Obtain
approval before configuring a dedicated test-account key and unused target name;
never use a customer agent. Dispatch it on `main` with creation/update consent.
Require private `1.0.0` creation, a same-agent `1.0.1` update, duplicate rejection,
failed `1.0.2` validation, and read-only proof that `1.0.1` is still selected.
Use another unused test name for each fresh run; inspect retained artifacts and
arrange cleanup separately. Record the run and commit being tested. Until
then, mark authenticated smoke as pending and do not claim launch readiness.

For an Action release, require passing CI and authenticated smoke for the exact
reviewed commit. Create an immutable semantic release tag such as `v1.0.0` and a
GitHub Release, then deliberately move the `v1` major alias to that tested commit.
Publish release notes covering behavior, validation, and CLI compatibility.
Customers who require immutable dependencies should use a full commit SHA;
the major alias intentionally rolls forward. Test CLI-version overrides before
changing the default CLI pin.

Public visibility requires explicit owner approval and a reviewed Terraform
change. Keep the repository private until that change is approved. Marketplace
listing requires the approved public repository, root `action.yml`, the owner's
applicable agreement, available Action name, and a tested release. Verify
cross-repository use and Marketplace publication after public-launch approval;
neither is established by private-repository CI. Do not automate visibility
changes or advertise a Marketplace listing before it exists.
