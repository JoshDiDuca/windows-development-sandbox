# Roadmap

What is still open. Each release is built, tested in a sandbox and documented before its version number goes up. What
has shipped is in the [changelog](../CHANGELOG.md).

Status: **planned** (decided, not started), **idea** (needs a design decision or a test on a real PC first).

## Waiting for a test on a real PC

These shipped, but have only been tested inside a Windows Sandbox.

| Item | What to check |
| --- | --- |
| VPN (alpha, 1.7.0 and 1.8.0): NordVPN, your own OpenVPN or WireGuard file, the kill switch | [vpn.md](vpn.md#what-is-not-tested-yet): the driver in Windows Sandbox, traffic through the tunnel, nothing leaks with the tunnel down |
| Contained storage (beta, 1.9.0) | `scripts/experiments/Test-ContainedStorage.ps1`, then the checklist in [design/engines.md](design/engines.md) |
| HCS engine (alpha, 1.9.0; starting it is disabled) | `scripts/experiments/hcs/Test-Hcs.ps1` and the go/no-go test in [design/engines.md](design/engines.md) |

## Open work

### Sandbox engines and storage

- **HCS engine, next phases** (planned, after the go/no-go test passes): the writable layer and layer import, running the
  logon command in the container, the control channel over Hyper-V sockets, networking, our own image importer. What is
  built and what is missing: [design/engines.md](design/engines.md#phase-3-status-hcs-engine-built-start-disabled).
- **Storage helper** (planned): a small service installed by the all-users installer, so contained storage needs no
  admin prompt per launch. Spec: task R2 in [design/roadmap-tasks.md](design/roadmap-tasks.md).
- **Mounting folders into a running sandbox** (idea): Windows Sandbox cannot add a folder while it runs, so a project
  outside its mapped folders restarts the sandbox. The HCS engine can add folders live; Windows Sandbox would need a
  different approach. See [projects.md](projects.md).
- **NordLynx** (NordVPN over WireGuard, later): only after NordVPN has been tried on a real PC. Spec: task R5 in
  [design/roadmap-tasks.md](design/roadmap-tasks.md).

### Release and install

- **Code signing** (built, waiting for the signing account): the release workflow signs `install.ps1` with Azure
  Artifact Signing once its six secrets exist, and does nothing until then. Setup and checks:
  [development.md](development.md#signing-releases). Spec: task R3 in [design/roadmap-tasks.md](design/roadmap-tasks.md).

### Web UI

- **Plain shell sessions** (planned): PowerShell and other shells through ptyhost, so terminals you open show in the web
  UI too, and closing them from there.
- **Other Windows users** (planned): their own `sandbox web` shows the sandbox you shared, under the same rules as the
  command line.
- **Phone access** (planned): opt-in HTTPS, pairing per device (QR code), revocable devices, a private-network firewall
  rule. Design and security model: [web-ui.md](web-ui.md#phases).
- **Audit log in the web UI** (planned): browse what `sandbox audit` shows.
- **Sandbox desktop in the browser** (idea): mouse and keyboard for the sandbox's desktop from another device. Needs a
  security review first ([web-ui.md](web-ui.md#phases)).

### Terminal input

- **Raw mouse input for agents** (idea, backlog): programs that need motion and drag reports get none of them today.
  Investigate first. Spec: task R4 in [design/roadmap-tasks.md](design/roadmap-tasks.md).

## Recently shipped

Details are in the [changelog](../CHANGELOG.md).

- **1.11.x**: the web UI rebuilt on the shared core, with every area of the command line and the menu in it; the
  `sandbox engine clean` command; the HCS engine workflow for GitHub Actions; no sandbox process left running when an
  agent session ends.
- **1.9.0**: the engine layer, contained storage (beta) and the HCS engine (alpha, start disabled), all opt-in.
