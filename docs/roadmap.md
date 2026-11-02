# Roadmap

What is still open. Each release is built, tested in a sandbox and documented before its version number goes up. What
has shipped is in the [changelog](../CHANGELOG.md).

Status: **planned** (decided, not started) or **idea** (needs a design decision or a test on a real PC first).

## Waiting for a test on a real PC

These shipped, but have only been tested inside a Windows Sandbox or on GitHub Actions.

| Item                                                                      | What to check                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VPN (alpha, 1.7.0 and 1.8.0): NordVPN, your own OpenVPN or WireGuard file | [vpn.md](vpn.md#what-is-not-tested-yet): the driver in Windows Sandbox, traffic through the tunnel, nothing leaks with the tunnel down                                                                                       |
| Contained storage (beta, 1.9.0)                                           | `scripts/experiments/Test-ContainedStorage.ps1`, then the checklist in [design/engines.md](design/engines.md)                                                                                                                |
| Storage helper (beta, 1.14.0)                                             | an all-users install with `-ContainedStorageHelper`: a launch mounts with no prompt, a second user's launch, the log, uninstall dismounts ([design/engines.md](design/engines.md))                                           |
| Remote access (beta, 1.12.0)                                              | `sandbox web lan-on` and the firewall rule, a phone signing in with a device code, a second Windows user with `sandbox remote` ([web-ui.md](web-ui.md#remote-access))                                                        |
| Live folders through HCS (alpha, 1.15.0)                                  | the PC tests in [design/hcs-live-folders.md](design/hcs-live-folders.md#test-plan) on Windows 10 22H2 and Windows 11 23H2. Only then does it replace the restart ([projects.md](projects.md#live-folders-through-hcs-alpha)) |
| HCS engine (alpha, 1.9.0; starting it is disabled)                        | `scripts/experiments/hcs/Test-Hcs.ps1` and the go/no-go test in [design/engines.md](design/engines.md)                                                                                                                       |

## Open work

- **HCS engine, next phases** (planned, after the go/no-go test passes): the writable layer and layer import, running the
  logon command in the container, the control channel over Hyper-V sockets, networking, our own image importer. What is
  built and what is missing: [design/engines.md](design/engines.md#phase-3-status-hcs-engine-built-start-disabled).
- **NordLynx** (NordVPN over WireGuard, later): only after NordVPN has been tried on a real PC. Spec: task R5 in
  [design/roadmap-tasks.md](design/roadmap-tasks.md).
- **The sandbox's desktop in the browser** (idea): mouse and keyboard for the sandbox's desktop from another device.
  Needs a security review first ([web-ui.md](web-ui.md#phases)).

## Recently shipped

Details are in the [changelog](../CHANGELOG.md).

- **1.17.0**: the Unreal Engine toolchain (Visual Studio Community with the C++ game workload, the DirectX runtime, an
  offline copy of the install files).
- **1.16.1**: fast account switching; browsers in the sandbox off the GPU.
- **1.16.0**: a redesigned web UI; errors no longer close the menu or the web server.
- **1.15.0**: live folders through HCS (alpha).
- **1.14.0**: the storage helper (contained storage with no prompt per launch, spec: task R2 in
  [design/roadmap-tasks.md](design/roadmap-tasks.md)); drag and motion for agents (DECSET 1002 / 1003 with conpty.dll; findings: task R4); Backspace right
  from the first key; a killed session host's programs ended.
- **1.13.1 to 1.13.3**: the default account applies at once and to every agent; a fast menu; the web UI stays while a
  page is open.
- **1.13.0**: plain shell sessions, and closing a session from the command line, the menu and the web UI.
- **1.12.0**: remote access (beta) for devices on your network and other Windows users; agent add-ons (rtk, Headroom,
  ccusage, MCP servers); the audit log on by default, with the Activity page.
- **1.11.x**: the web UI rebuilt on the shared core; `sandbox engine clean`; the HCS engine workflow for GitHub Actions;
  no sandbox process left running when an agent session ends.
- **1.9.0**: the engine layer, contained storage (beta) and the HCS engine (alpha, start disabled), all opt-in.
