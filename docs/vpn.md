# VPN (alpha)

> **Alpha.** The first real try (October 2026) found two bugs, now fixed: OpenVPN would not install in Windows Sandbox,
> and the kill switch did not hold. A tunnel carrying traffic is not confirmed yet ([what is not tested yet](#what-is-not-tested-yet)).
> Use it only where a broken tunnel would not hurt, with the kill switch on.

The sandbox can send all its traffic through a VPN. Only the sandbox: your PC's own connection is untouched. NordVPN
works with the account you already have, with no NordVPN app on your PC. You can also use your own OpenVPN profile
(`.ovpn`) or WireGuard config (`.conf`), for example from your company.

## Set it up (NordVPN, five minutes)

The sandbox does **not** use your NordVPN password. NordVPN has separate **service credentials** for apps that cannot
sign in on a web page, and you can revoke them at any time.

1. Sign in at <https://my.nordaccount.com> with your usual NordVPN e-mail and password.
2. Open **NordVPN**, scroll to **Advanced settings** and choose **Set up NordVPN manually**. Confirm with the code sent
   to your e-mail if it asks.
3. Copy the **Service credentials**: a user name and a password (long strings of letters and digits).
4. On your PC run:

   ```
   sandbox vpn login
   ```

   It prints these steps, then asks for the two values. What you type is not shown. They are saved encrypted for your
   Windows user ([security](security.md#your-own-logins-and-keys)) and never printed. In the menu: **Settings >
   Network > Set NordVPN login...**.

5. Turn the VPN on, and pick a country if you like:

   ```
   sandbox config set vpn.enabled true
   sandbox config set vpn.country uk
   ```

6. Start a sandbox as usual (`sandbox claude`). The launch says which server it uses, waits for the tunnel, and tells
   you whether it is up and which address the sandbox appears from.

`sandbox vpn status` shows whether the VPN is on, whether a login is saved (never the values) and, while a sandbox
runs, whether its tunnel is up and its public address differs from your PC's. `sandbox vpn logout` deletes the saved
login; to make the credentials useless, generate new ones on Nord Account.

## Your own OpenVPN profile

```
sandbox config set vpn.provider openvpn-file
sandbox config set vpn.configFile C:\path\work.ovpn
sandbox vpn login
sandbox config set vpn.enabled true
```

`sandbox vpn login` asks for the user name and password your VPN gave you. Certificates stay inside the profile. A
profile that needs no user name is not supported yet.

## Your own WireGuard file

For a business VPN that gives you a WireGuard config (a `.conf` file):

```
sandbox config set vpn.provider wireguard-file
sandbox config set vpn.configFile C:\path\office.conf
sandbox config set vpn.enabled true
```

There is no `sandbox vpn login`: the keys are in the file.

- **Put a `DNS` line in the config**, or names cannot be looked up through the tunnel.
- It needs an IPv4 `Address` and an `Endpoint` that is a name or an IPv4 address (IPv6 endpoints and names in `DNS` are
  refused).
- With the kill switch on, only traffic through the tunnel leaves the sandbox. So an `AllowedIPs` that is not
  `0.0.0.0/0` (a split tunnel) leaves the rest of the internet unreachable; the sandbox warns about this in its log.
- Use a key you can revoke on the VPN server: the agent in the sandbox can read it.
- `sandbox doctor` checks that the file is readable and plain, and that download.wireguard.com answers.

## Settings

| Setting          | Default   |                                                                                                                              |
| ---------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `vpn.enabled`    | `false`   | the VPN is on for new sandboxes. NordVPN and OpenVPN need a saved login (`sandbox vpn login`)                                |
| `vpn.provider`   | `nordvpn` | `nordvpn` (a recommended server is picked at every launch), `openvpn-file` or `wireguard-file`                               |
| `vpn.protocol`   | `udp`     | `udp` (faster) or `tcp` (gets through networks that block udp). WireGuard is always udp                                      |
| `vpn.country`    | empty     | NordVPN only: `uk`, `us`, `Germany` ...; empty = the best server anywhere                                                    |
| `vpn.configFile` | empty     | `openvpn-file`: your `.ovpn`. `wireguard-file`: your `.conf` (at most 16 KB). Files with lines that run programs are refused |
| `vpn.killSwitch` | `true`    | nothing leaves the sandbox except through the tunnel; if the tunnel cannot start, the sandbox stays offline                  |

A project's `.sandbox-config.json` can turn `killSwitch` on, never off, and can never choose a VPN, a server, a profile
or a login.

## What happens at launch

1. **On your PC.** The login is decrypted for this launch only. For NordVPN, its public server list gives a recommended
   server for your country and protocol, and its OpenVPN profile is downloaded (at most 256 KB). The profile (or your
   own file) is **checked**: anything that runs a program (`script-security`, `up`, `down`, `plugin`, `route-up`,
   `ipchange`, `tls-verify`, `client-connect` ...), names a file on your PC, or is not a known setting stops the launch.
   A WireGuard file may hold only `PrivateKey`, `Address`, `DNS`, `MTU`, `ListenPort` and, per `[Peer]`, `PublicKey`,
   `PresharedKey`, `AllowedIPs`, `Endpoint` and `PersistentKeepalive`; it is then written again from the checked values.
2. **Handing over.** The profile goes in the launch folder. The login (or the WireGuard keys) goes in a one-shot file
   that the sandbox reads and deletes at once: never in `session.json`, the launch folder or the shared run folder.
3. **In the sandbox**, after the tools and before the agent:
   - The profile is checked again, and OpenVPN Community (or WireGuard for Windows) is downloaded, checked against a
     SHA-256 stored in this program, and installed silently.
   - **The kill switch goes on first:** block rules for every public address except the VPN server, for global IPv6
     and for DNS. A direct connection is then tried, so the sandbox is reported offline only when it really is.
     Loopback, DHCP, private addresses and the channel your terminal uses to attach stay as they were.
   - The tunnel starts. The file with the login or config is deleted as soon as the tunnel is up (or has failed). The
     block rules are then narrowed so that traffic through the tunnel passes. WireGuard waits up to 30 seconds for the
     first handshake.
4. **The result.** The sandbox reports `up` or `failed` and its public address, and the launch prints it.

If the tunnel fails with the kill switch on (the default), the sandbox **stays offline** and the launch says so in red,
with the reason. Fix it and start again. With the kill switch off, the sandbox keeps your normal connection and the
launch warns in yellow.

## Know this before you trust it

- The agent in the sandbox can read the VPN login and can turn the tunnel off, because it is the administrator there.
  The VPN keeps a well-behaved agent and its tools off your normal connection and hides your address; it is not a cage
  for a hostile agent.
- Tool downloads in the first minutes of a boot, before the tunnel is up, use your normal connection.
- The login file is deleted once the tunnel is up, so a tunnel that drops does not come back by itself. With the kill
  switch on, the sandbox goes offline until you restart it.
- Free VPNs see all your traffic. Use one you trust.
- Windows Sandbox cannot answer the WMI queries the OpenVPN installer makes, so the sandbox first removes the one broken
  WMI class (`repair-wmi-services.ps1`).

## If it does not work

| You see                                               | Likely cause                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `no NordVPN login is saved`                           | run `sandbox vpn login`                                                          |
| `the VPN refused the login`                           | not your account e-mail or password: save the **service credentials** again (see below) |
| `it could not reach the VPN server`                   | the network blocks it: try `sandbox config set vpn.protocol tcp`                 |
| `the network driver for the tunnel could not be used` | the driver did not install in Windows Sandbox (see below)                        |
| `a profile ... was refused`                           | the profile has a line that could run a program; use a plain one                 |
| the sandbox has no internet and the VPN failed        | the kill switch is doing its job; `logs\openvpn.log` in the data folder says why |

`sandbox doctor` checks that the login is saved and can be decrypted by your Windows user, and that the download site
answers.

## Login refused (NordVPN)

The VPN page shows **Last attempt: login refused by the VPN** when NordVPN answered `AUTH_FAILED`. The server was reached
and the kill switch let the handshake through; only the login was wrong. NordVPN accepts only its **service
credentials** here: Nord Account > NordVPN > "Set up NordVPN manually" > Service credentials (a user name and a
password of letters and digits, about 24 each). Choose **Save the login again** on the VPN page and paste them. Spaces
around them are removed, and the tool warns when what you typed does not look like service credentials.

## What is not tested yet

The logic is tested (profile checks, firewall rules as text, login storage, settings rules, secrets kept out of
files). On a real PC, these still need checking:

- **The driver.** Checked: the OpenVPN MSI installs TAP-Windows and ovpn-dco in Windows Sandbox and both adapters
  appear. Still to check: that OpenVPN brings the tunnel up on one of them.
- **A tunnel carries traffic**, the address `sandbox vpn status` shows is the VPN's, and DNS answers through the tunnel.
- **The kill switch.** Checked: its rules refuse a direct connection and DNS while the VPN server stays reachable. Still
  to check: with the tunnel failing on purpose (wrong credentials) there is no internet; after
  `taskkill /f /im openvpn.exe` inside, traffic stops; with the tunnel up, nothing leaves except through it.
- **Attach and `forwardPorts`** still work (`sandbox claude -t` from your PC) while the kill switch is on.
- **WireGuard**, all of it:
  - the MSI installs quietly (`DO_NOT_LAUNCH=1`) and `wireguard.exe /installtunnelservice` starts the service in
    Windows Sandbox;
  - the service has read the config before the file is deleted, and the key is gone from disk afterwards
    (`C:\Windows\Temp\sbx-wg-*` is empty);
  - the first handshake shows in `wg.exe show sandbox latest-handshakes`, and the sandbox appears from the server's
    address;
  - the kill switch does not get in the way of WireGuard's own firewall rules, and with the tunnel stopped
    (`wireguard.exe /uninstalltunnelservice sandbox`) nothing leaves;
  - a wrong key or endpoint fails cleanly (offline with the kill switch, normal connection without);
  - the pinned MSI hashes (version 1.1.1) match what the publisher serves. When computed, they differed from the list
    in `latest.sig` on the same site, though both files carry a valid WireGuard LLC signature: compare again before a
    release.
- **OpenVPN's installer** finishes quietly with its default features.
- **IPv6** does not leak past the default outbound rule.
- **Restarting the agent session** after a VPN failure behaves (the agent cannot install itself offline).
