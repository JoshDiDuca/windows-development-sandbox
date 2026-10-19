# Development

```powershell
npm install               # dependencies + build
npm test                  # offline, security and live ConPTY/daemon/git tests; ends with ALL TESTS PASSED
npm run install:global    # install this checkout globally as a COPY
npm run lint              # ESLint (typescript-eslint): the coding standard and the architecture boundaries
npm run format            # Prettier (120 columns); npm run format:check only checks
```

`npm run lint` and `npm run format:check` must pass before a pull request. ESLint also enforces the layers: guest code
never imports host, CLI or sync code, core and shared import neither, and only the CLI, `api.ts` and `bin/` sit on top.
C# (`sandbox/csharp`, `native/csharp`) is C# 5 and must compile with
`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`; `.ps1` and `.cmd` files are CRLF.

The self-test refuses to run on a normal PC: it only runs inside a Windows Sandbox (run `sandbox start`, then `npm test`
in it) or on GitHub Actions, because the live tests create files, links and processes. `sandbox self-test` is the same
thing. While it runs, `AGENT_SANDBOX_SELFTEST=1` makes host code refuse outward actions and any write or delete outside
the test's temp folder (`src/shared/test-guard.ts`, `src/host/test-guard.ts`); the `test-guard` suite checks that.

## Tests

`npm test` runs every suite and ends with `ALL TESTS PASSED` (or `N TEST(S) FAILED`). Run part of it:

```powershell
npm test -- config                                    # one suite (builds first)
node dist/bin/agent-sandbox.js self-test cli,sync     # several, without building
node dist/bin/agent-sandbox.js self-test nope         # prints the list of suite names
```

- One file per area in `src/selftest/`, named `<area>.test.ts`, exporting a `Suite` (`support/suite.ts`). `index.ts`
  lists the suites in run order. A suite that throws or hangs (default 2 minutes, `timeoutMs`) fails alone; the rest
  still run.
- `support/harness.ts`: `t.equal(actual, expected, name)` (failures show both), `t.includes`, `t.excludes`, `t.matches`,
  `t.throws(fn, 'text' | /regex/, name)` (message and fix hint), `t.check(ok, name, detail)`, `t.waitFor(read, ms)`,
  `t.touch(file)` (make a change clearly newer instead of sleeping), temp helpers `t.at`, `t.dir`, `t.write`,
  `t.writeJson`, `t.readJson`.
- `support/fixtures.ts`: a fake PC (Node, Claude Code, a profile, workspaces) with `f.makeConfig()`, `f.run()`,
  `f.launch()` (resolve + generate), `f.runGuest()` and `f.runBin()` (a built command as its own process).
- Live suites (`live-*.test.ts`, helpers in `support/live.ts`) start the real daemon, ptyhost and git shim, and
  compile SandboxTools and HostTools. They never sleep for a
  fixed time: they poll until the condition holds, with long deadlines, and print the viewer's screen and the daemon log
  when a check fails. Keep it that way; a flaky test is a bug in the test or the product.
- The `layout` suite checks the compiled imports: guest code reaches only the portable core, nothing imports an entry
  point, there are no import cycles, and the pure guest files host code and tests may load never pull in the guest
  runtime's side effects.
- Slowest suites: `host-sim` (every command as its own Node process, two at a time), then the live ones.

CI builds on Node 22 and on the official Node 22.0.0 zip (the oldest Node users run it on, so dependencies must not
need newer), and runs the self-test as information only. Releases and `npm run publish:npm` run no tests.

To work on this tool with an agent in its own sandbox, install it as a copy (`npm run install:global`), not with
`npm install -g .`. A linked install would let the sandboxed agent edit the code your PC runs. With a copy, the
agent's changes only reach your PC when you review them and install again.

`npm run install:global` refuses when this PC has a managed install (`%ProgramFiles%\WindowsDevelopmentSandbox` or
`%LOCALAPPDATA%\WindowsDevelopmentSandbox`). The copy would go first on the PATH and hide it, the installed one would stop
getting updates, and a fix patched into the installed one would not be the one you run. To test a checkout anyway, run
`npm run install:global -- --force`; it prints how to undo it (`npm uninstall -g windows-development-sandbox`).
`sandbox doctor` lists every copy on the PATH, and `sandbox --version` says where the running one is.

## HCS engine workflow

`.github/workflows/hcs-engine.yml` tests the alpha HCS engine on GitHub-hosted `windows-2022` and `windows-2025`
runners. It runs only by hand: Actions tab > "HCS engine (alpha)" > Run workflow (never on push or pull request). The
`require_hyperv` input makes the job fail when the Hyper-V utility VM cannot be started; by default that is reported
only. No secrets are used.

What it does, per runner: build; `self-test hcs,engine`; the read-only `Test-Hcs.ps1` probe; `engine check hcs` and
`engine --json`; build `HcsHost.exe` with csc; pull `mcr.microsoft.com/windows/servercore:ltsc2022`; run it with
Docker in process and in Hyper-V isolation (informational); then the go/no-go,
`scripts/experiments/hcs/Test-HcsLifecycle.ps1`: with the documents our code generates from the pulled image
(`export-documents.mjs`), HcsHost.exe creates the agent and scratch disks, grants the VM access, creates and starts the
Hyper-V utility VM, tries the container inside it (informational: the writable layer is not built yet), and terminates
both. A cleanup step always terminates leftovers, only ones HcsHost's guards accept (`agent-sandbox-*` ids with Owner
`agent-sandbox`). The job summary has a pass/fail table and says which isolation worked; logs are uploaded as the
`hcs-logs-<os>` artifacts.

What it cannot test: hosted runners are virtual machines, and Hyper-V isolation needs nested virtualization, which
GitHub does not document for them. If the utility VM step fails there, the summary says Hyper-V isolation still needs a
real PC. Process isolation (shares the host kernel) is not what the engine ships and is only run to show the image
works. Also not covered: the terminal bridge, Node and csc inside Server Core, VHDX formatting, networking.

Once a run confirms it works, make `release.yml` run it on version pushes by adding a job there and making the
publishing job wait for it:

```yaml
  hcs:
    uses: ./.github/workflows/hcs-engine.yml
    with:
      require_hyperv: true
```

plus `needs: [hcs]` on the job that publishes. It is not added yet on purpose.

## Inside the sandbox

Project scripts can check `AGENT_SANDBOX=1` to know they run in the sandbox, and `AGENT_SANDBOX_WORKSPACE` for the
project's path there (for example to skip installers or GPU checks).

## Releases

Releases are automatic. Bump `version` in `package.json` and push to master, and CI tags `v<version>` and publishes
a GitHub Release with:

- `windows-development-sandbox-<version>.tgz`
- `windows-development-sandbox.tgz` (the stable "latest" name)
- `install.ps1`

CI also publishes to GitHub Packages and to [npm](https://www.npmjs.com/package/windows-development-sandbox).
`npm run release:patch` bumps, tags and pushes in one go.

### npm

npm only lets CI publish a package that already exists, so the first version is published once from your PC:

```powershell
npm login
npm run publish:npm      # builds, packs like CI and publishes (no tests); asks for your 2FA code if you use one
```

Then add an npm automation token as the repository's `NPM_TOKEN` secret. From then on every release reaches npm. Without
the secret CI skips npm, and a failed npm publish is only a warning: the GitHub release still goes out. Until the first
publish, CI skips npm with a warning.

### Signing releases

CI signs `install.ps1` (the file in each GitHub release) with Azure Artifact Signing (called Trusted Signing before).
The step is in `.github/workflows/release.yml` and does nothing until the secrets below exist: without them it prints
`Code signing skipped: no ... secret yet` and the release goes out unsigned, as before. Once the secrets are set, a
signing failure fails the release before anything is published, so a half-signed release cannot go out.

Not signed, and not signable by us: `HostTools.exe`, `HcsHost.exe` and `memgov.exe`. The installer and the sandbox build
them on your PC from source, so they carry no signature from us. The npm package and the `.tgz` are not Authenticode
signed either; the `.tgz` is covered by `SHA256SUMS` and the build provenance attestation.

**Set up once (the owner):**

1. In the Azure portal, create an Artifact Signing account and a certificate profile (public trust), after the identity
   validation the portal asks for.
2. Create an app registration (a service principal) with a client secret, and give it the signer role on the signing
   account's certificate profile (the "Artifact Signing Certificate Profile Signer" role).
3. In the repository's Settings > Secrets and variables > Actions, add these six repository secrets:

   | Secret | Value |
   | --- | --- |
   | `AZURE_TENANT_ID` | the directory (tenant) ID of the app registration |
   | `AZURE_CLIENT_ID` | the application (client) ID of the app registration |
   | `AZURE_CLIENT_SECRET` | the client secret (it expires: add a new one before then) |
   | `TRUSTED_SIGNING_ENDPOINT` | the endpoint URL of the signing account, as the portal shows it (the region's) |
   | `TRUSTED_SIGNING_ACCOUNT` | the name of the signing account |
   | `TRUSTED_SIGNING_PROFILE` | the name of the certificate profile |

The next release after the secrets are set is signed. The action is `Azure/artifact-signing-action`, pinned to v2.0.0 by
commit, a composite action that runs PowerShell (it has no Node runtime to update).

**Check a signed file** (in PowerShell, on the downloaded `install.ps1`):

```powershell
Get-AuthenticodeSignature .\install.ps1 | Format-List Status, StatusMessage, SignerCertificate
```

`Status` must be `Valid`. The same is in the file's Properties > Digital Signatures tab. The release workflow runs this
check too and fails if the status is not `Valid`.

**What users see:**

- Before (unsigned): a downloaded `install.ps1` run as a file has no publisher to show, and PowerShell's RemoteSigned
  policy refuses it (see [security.md](security.md)). The one-line install (`irm ... | iex`) reads no file, so it is not
  affected either way.
- After (signed): the file's Digital Signatures tab names the publisher, and RemoteSigned runs it. Windows' reputation
  checks still start from zero for a new certificate, so a warning can appear for a while.

The code layout and the rules for contributors (and agents) are in [CLAUDE.md](../CLAUDE.md).
