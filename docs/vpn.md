# VPN (NordVPN first) — alpha

> **Alpha.** Built and tested inside a sandbox, but not yet tried on a real PC: the tunnel driver, the kill switch and
> attaching with the tunnel on still need checking ([what is not tested yet](#what-is-not-tested-yet)). Keep using it
> only where a broken tunnel would not hurt.

The sandbox can send all its traffic through a VPN. Only the sandbox: your PC's own connection is untouched. NordVPN
works with the login you already have; you do not need a NordVPN app on your PC. You can also use your own OpenVPN
profile (`.ovpn`) or WireGuard config (`.conf`), for example from your company.

**Status: built and tested without a VPN.** The parts that need a real PC and a real VPN account (the network driver
inside Windows Sandbox, the tunnel, the kill switch with the attach channel) are listed under
[what is not tested yet](#what-is-not-tested-yet). Try it with the kill switch on, on a PC where nothing depends on the
sandbox, and read that list first.

## Set it up (NordVPN, five minutes)

You need your normal NordVPN login (e-mail and password). The sandbox does **not** use that password: NordVPN has
separate **service credentials** for apps that cannot sign in on a web page, and you can revoke them at any time.

1. Sign in at <https://my.nordaccount.com> with your usual NordVPN e-mail and password.
2. Open **NordVPN**, scroll to **Advanced settings** and choose **Set up NordVPN manually**. Confirm with the code sent
   to your e-mail if it asks.
3. Copy the **Service credentials**: a user name and a password (long strings of letters and digits).
4. On your PC run:

   ```
   sandbox vpn login
   ```

   It prints these steps, then asks for the two values. What you type is not shown. They are saved encrypted for your
   Windows user ([security](security.md#your-own-logins-and-keys)) and never printed again. In the menu: **Settings >
   Network > Set NordVPN login...**.
5. Turn the VPN on, and optionally pick a country:

   ```
   sandbox config set vpn.enabled true
   sandbox config set vpn.country uk
   ```

6. Start a sandbox as usual (`sandbox claude`). The launch says which server it uses, repeats the warnings below, waits
   for the tunnel and tells you whether it is up and what address the sandbox appears from.

`sandbox vpn status` shows whether the VPN is on, whether a login is saved (never the values) and, while a sandbox runs,
whether its tunnel is up and whether its public address differs from your PC's. `sandbox vpn logout` deletes the saved
login; to make the credentials themselves useless, generate new ones on Nord Account.

To use your own profile instead: `sandbox config set vpn.provider openvpn-file`, `sandbox config set vpn.configFile
C:\path\work.ovpn`, then `sandbox vpn login` for the user name and password your VPN gave you (certificates stay inside the
profile; a profile that needs no user name is not supported yet).

## Your own WireGuard file

For a business VPN that gives you a WireGuard config (a `.conf` file):

```
sandbox config set vpn.provider wireguard-file
sandbox config set vpn.configFile C:\path\office.conf
sandbox config set vpn.enabled true
```

There is no `sandbox vpn login`: the keys are in the file. What happens at launch:

1. On your PC the file is read (at most 16 KB) and **checked**. Only `PrivateKey`, `Address`, `DNS`, `MTU`,
   `ListenPort` and, in each `[Peer]`, `PublicKey`, `PresharedKey`, `AllowedIPs`, `Endpoint` and
   `PersistentKeepalive` are accepted. `PreUp`, `PostUp`, `PreDown`, `PostDown` (they run programs), `Table`,
   `SaveConfig` and anything unknown stop the launch before anything is written. It needs an IPv4 `Address` and an
   `Endpoint` that is a name or an IPv4 address (IPv6 endpoints and names in `DNS` are refused). The config is then
   written again from the checked values.
2. The private and preshared keys travel only in the one-shot file the sandbox reads and deletes at once: never in
   `session.json`, the launch folder or the shared run folder.
3. In the sandbox: the config is checked again, WireGuard for Windows is downloaded from download.wireguard.com
   (checked against a SHA-256 stored in this program) and installed silently, the endpoint name is looked up (so
   WireGuard needs no DNS once the kill switch is on) and **the kill switch is applied first**, with the endpoint's
   address and UDP port as the one hole. The config goes in a file for `wireguard.exe /installtunnelservice` and is
   deleted as soon as the service runs (or has failed). Then the tunnel's own address (`Address`) is let through and
   the sandbox waits (30 seconds) for the server to answer (the first handshake).
4. The sandbox reports `up` or `failed` the same way as for OpenVPN. A failed tunnel is removed again.

Things to know: put a `DNS` line in the config, or names cannot be looked up through the tunnel. With the kill switch
on, only traffic that goes through the tunnel leaves the sandbox, so an `AllowedIPs` that is not `0.0.0.0/0` (a split
tunnel) leaves the rest of the internet unreachable; the sandbox warns about that in its log. Use a key you can
revoke on the VPN server: the agent in the sandbox can read it. `sandbox doctor` checks that the file is readable and
plain and that download.wireguard.com answers.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `vpn.enabled` | `false` | the VPN is on for new sandboxes |
| `vpn.provider` | `nordvpn` | `nordvpn`, `openvpn-file` or `wireguard-file` |
| `vpn.protocol` | `udp` | `udp` or `tcp` (tcp passes networks that block udp) |
| `vpn.country` | empty | NordVPN: `uk`, `us`, `Germany` ...; empty = the best server |
| `vpn.configFile` | empty | `openvpn-file`: your `.ovpn`; `wireguard-file`: your `.conf` |
| `vpn.killSwitch` | `true` | nothing leaves the sandbox except through the tunnel |

A project's `.sandbox-config.json` can turn `killSwitch` on, never off, and can never choose a VPN, a server, a profile
or a login ([configuration](configuration.md#vpn)).

## What happens at launch

1. On your PC: the login is decrypted for this launch only; NordVPN's public server list gives a recommended server for
   your country and protocol; its OpenVPN profile is downloaded (at most 256 KB) and **checked**: it is accepted only if
   it consists of harmless settings. Anything that runs a program (`script-security`, `up`, `down`, `plugin`,
   `route-up`, `ipchange`, `tls-verify`, `client-connect` ...), names a file on the PC or is not on the list of known
   settings stops the launch before anything is written. (This is done on your PC, not in the sandbox, so the sandbox's
   firewall needs no hole for these sites.)
2. The profile goes in the launch folder; the login goes in a one-shot file that the sandbox reads and deletes at once. It
   is never in `session.json`.
3. In the sandbox, after the tools and before the agent: the profile is checked again, OpenVPN Community is downloaded
   (checked against a SHA-256 stored in this program) and installed silently, then **the kill switch is applied first**:
   everything that goes out is blocked except loopback, the VPN server, DHCP and the channel your terminal uses to attach
   to the sandbox. OpenVPN starts with the login in a file that is deleted as soon as the tunnel is up (or has failed). A
   second rule then lets through what leaves from the tunnel's own address, which is all the sandbox's traffic.
4. The sandbox reports `up` or `failed` and its public address; the launch prints it.

If the tunnel fails: with the kill switch on (the default) the sandbox **stays offline** and the launch says so in red,
with the reason (login refused, server unreachable, driver). Fix it and start again. With the kill switch off the sandbox
keeps your normal connection and the launch warns in yellow.

## Know this before you trust it

- The agent in the sandbox can read the VPN login (a service login you can revoke) and can turn the tunnel off, because it
  is the administrator there. The VPN keeps a well-behaved agent and its tools off your normal connection and hides your
  address from what they visit; it is not a cage for a hostile agent.
- Tool downloads in the first minutes of a boot (before the tunnel is up) go through your normal connection.
- The login file is deleted once the tunnel is up, so a tunnel that drops does not come back by itself: with the kill
  switch the sandbox goes offline until you restart it.
- Free VPNs see all your traffic. Use one you trust.
- Windows Sandbox needs a network driver for the tunnel; OpenVPN installs its own (Wintun).

## If it does not work

| You see | Likely cause |
| --- | --- |
| `no NordVPN login is saved` | run `sandbox vpn login` |
| `the VPN refused the login` | you typed your account password: use the **service credentials** (steps above) |
| `it could not reach the VPN server` | the network blocks it: try `sandbox config set vpn.protocol tcp` |
| `the network driver for the tunnel could not be used` | the driver did not install in Windows Sandbox: see below |
| `a profile ... was refused` | the profile has a line that could run a program; use a plain one |
| the sandbox has no internet and the VPN failed | the kill switch is doing its job; `logs\openvpn.log` in the data folder says why |

`sandbox doctor` checks that the login is saved and can be decrypted by your Windows user, and that the OpenVPN download
site answers.

## What is not tested yet

Everything here was built and tested on the logic side (profile checks, firewall rules as text, login storage,
settings rules, secrets kept out of files). It has not been run against a real tunnel. On a real PC, check:

- **The driver inside Windows Sandbox.** The OpenVPN MSI installs Wintun (and ovpn-dco); whether the driver installs and
  a tunnel adapter appears inside Windows Sandbox is unknown. If not, no VPN is possible there (the kill switch keeps the
  sandbox offline and says so).
- **A tunnel carries traffic** and the address `sandbox vpn status` shows is NordVPN's, not yours; DNS answers through the
  tunnel (NordVPN's DNS servers are public addresses, so the LAN block does not get in the way).
- **The kill switch:** with the tunnel failing on purpose (wrong credentials) the sandbox has no internet; after
  `taskkill /f /im openvpn.exe` inside, traffic stops; with the tunnel up, nothing leaves except through it.
- **Attach still works** (`sandbox claude -t` from the PC) and so do `forwardPorts`, while the kill switch is on. The
  rules assume return traffic of connections your PC opens is allowed by Windows' firewall state, as it is for the LAN
  block.
- **WireGuard (your own file)**, all of it, as nothing here ran against a real tunnel:
  - the MSI installs quietly (`DO_NOT_LAUNCH=1`) and `wireguard.exe /installtunnelservice` starts the service inside
    Windows Sandbox (the WireGuard network driver must install there);
  - the service has read the config before the file is deleted (it reads it once at start), and the key is gone from
    disk afterwards (`C:\Windows\Temp\sbx-wg-*` is empty);
  - the first handshake shows in `wg.exe show sandbox latest-handshakes`, and the sandbox appears from the server's
    address, not yours;
  - the kill switch rules do not get in the way of WireGuard's own firewall rules for `AllowedIPs 0.0.0.0/0`, and
    with the tunnel stopped (`wireguard.exe /uninstalltunnelservice sandbox`) nothing leaves;
  - attach (`sandbox claude -t`) and `forwardPorts` work with the kill switch on, a `DNS` line answers through the
    tunnel, and a wrong key or endpoint fails cleanly (offline with the kill switch, normal connection without);
  - the pinned MSI hashes (version 1.1.1) match what the publisher serves. When they were computed they differed from
    the list in `latest.sig` on the same site, though both files carry a valid WireGuard LLC signature: compare again
    before a release.
- **OpenVPN's installer options.** It is installed with its default features; check that the install finishes quietly.
- **IPv6** is blocked by the default outbound rule; check that nothing leaks.
- **Restarting the sandbox's agent session** after a VPN failure behaves (the agent cannot install itself offline).
