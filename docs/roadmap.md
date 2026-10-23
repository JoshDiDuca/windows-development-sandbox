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
| Storage helper (beta, 1.14.0) | an all-users install with `-ContainedStorageHelper`: a launch with contained storage mounts with no prompt, a second user's launch, the log, uninstall dismounts; the checklist in [design/engines.md](design/engines.md) |
| Remote access (beta, 1.12.0) | `sandbox web lan-on` and the firewall rule, a phone signing in with a device code, a second Windows user with `sandbox remote` ([web-ui.md](web-ui.md#remote-access)) |
| HCS engine (alpha, 1.9.0; starting it is disabled) | `scripts/experiments/hcs/Test-Hcs.ps1` and the go/no-go test in [design/engines.md](design/engines.md) |

## Open work

### Sandbox engines and storage

- **HCS engine, next phases** (planned, after the go/no-go test passes): the writable layer and layer import, running the
  logon command in the container, the control channel over Hyper-V sockets, networking, our own image importer. What is
  built and what is missing: [design/engines.md](design/engines.md#phase-3-status-hcs-engine-built-start-disabled).
- **Storage helper** (done, 1.14.0): a small service installed by the all-users installer, so contained storage
  needs no admin prompt per launch. Waits for a test on a real PC (above). Spec: task R2 in
  [design/roadmap-tasks.md](design/roadmap-tasks.md).
- **Mounting folders into a running sandbox** (idea): Windows Sandbox cannot add a folder while it runs, so a project
  outside its mapped folders restarts the sandbox. The HCS engine can add folders live; Windows Sandbox would need a
  different approach. See [projects.md](projects.md).
- **NordLynx** (NordVPN over WireGuard, later): only after NordVPN has been tried on a real PC. Spec: task R5 in
  [design/roadmap-tasks.md](design/roadmap-tasks.md).

### Web UI

- **Plain shell sessions** (done, 1.13.0): PowerShell and cmd through ptyhost (`sandbox shell`, New shell in the
  menu and the web UI), listed and attached like agents, and any session closed from every surface (`sandbox close`).
  See [web-ui.md](web-ui.md#shells-and-closing-sessions).
- **Other Windows users** (done, 1.12.0): remote access lets another Windows user of this PC use your web UI or menu
  (`sandbox remote`), with the role you gave them ([web-ui.md](web-ui.md#remote-access)).
- **Phone access** (done, 1.12.0, beta): HTTPS on your local network only, one-time device codes instead of a QR code,
  remembered and revocable devices, a private-network firewall rule ([web-ui.md](web-ui.md#remote-access)). Waiting for
  a test on a real PC (the firewall rule, a phone trusting the certificate).
- **Sandbox desktop in the browser** (idea): mouse and keyboard for the sandbox's desktop from another device. Needs a
  security review first ([web-ui.md](web-ui.md#phases)).

### Terminal input

- **Raw mouse input for agents** (done, 1.14.0): drag and motion reports reach a program while it asks for them
  (DECSET 1002 / 1003) in the sandbox's tab, `sandbox attach` and the web UI, with conpty.dll (the default). Reports it
  did not ask for are dropped, and leaving a session turns mouse tracking off in your terminal. Windows' own pseudo
  console (`provisioning.conpty.enabled: false`) still passes no mouse modes. Findings: task R4 in
  [design/roadmap-tasks.md](design/roadmap-tasks.md).

## Recently shipped

Details are in the [changelog](../CHANGELOG.md).

- **1.14.0**: the storage helper (contained storage with no prompt per launch); drag and motion for agents; Backspace
  right from the first key; a killed session host's programs ended.
- **1.13.1 to 1.13.3**: the default account applies at once and to every agent; a fast menu; the web UI stays while a
  page is open.
- **1.13.0**: plain shell sessions and closing a session from the command line, the menu and the web UI.
- **1.12.0**: remote access (beta) for devices on your network and other Windows users of this PC; agent add-ons
  (rtk, Headroom, ccusage, MCP servers); the audit log on by default with the Activity page.
- **1.11.x**: the web UI rebuilt on the shared core, with every area of the command line and the menu in it; the
  `sandbox engine clean` command; the HCS engine workflow for GitHub Actions; no sandbox process left running when an
  agent session ends.
- **1.9.0**: the engine layer, contained storage (beta) and the HCS engine (alpha, start disabled), all opt-in.
