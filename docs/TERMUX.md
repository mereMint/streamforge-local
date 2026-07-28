# Unrooted Android and Termux

This is the primary deployment guide. StreamForge runs directly in Termux, with
no root, Docker daemon, or Linux emulation layer.

## 1. Install the Android apps

Install a current Termux build from
[F-Droid or the official Termux releases](https://github.com/termux/termux-app#installation).
The old Play Store build should not be used for this setup. If you also install
Termux:Boot, obtain it from the same source as Termux; Android will reject or
misbehave with plugins signed by a different source.

Termux:Boot is optional but useful after a phone restart. Open the Termux:Boot
app once after installing it. The StreamForge installer creates
`~/.termux/boot/start-streamforge-services`; the file does nothing until the
Termux:Boot app is installed and opened once.

## 2. Run the public one-command installer

Paste this as one command:

```sh
pkg update -y && pkg install -y curl && set -o pipefail && curl -fsSL https://raw.githubusercontent.com/mereMint/streamforge-local/main/install.sh | bash
```

No GitHub login or access token is required to install or update. The installer
uses public HTTPS for the source checkout. GitHub CLI is installed so you can
optionally authenticate later when pushing your own phone-side edits.

The default install directory is `~/streamforge-local`. Advanced overrides are
available for a deliberate fork or location:

```sh
STREAMFORGE_REPO=OWNER/REPOSITORY STREAMFORGE_HOME="$HOME/my-streamforge" bash install.sh
```

On a rerun, the installer only fast-forwards a clean `main` checkout. It leaves
uncommitted or untracked work alone and stops if histories have diverged.
Before reporting success it verifies the local `/health` endpoint and runs
`npm run doctor -- --require-running`.

## 3. Add an SSH key without enabling a password

Termux OpenSSH listens on port `8022`. The installer enables it, but it does not
create or change a password. Add your PC's public key locally on the phone
before attempting the first login.

On the Windows PC, create a key if needed:

```powershell
ssh-keygen -t ed25519 -a 64
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

Copy the complete one-line output. In Termux, run this command, replacing the
example with that exact public line:

```sh
umask 077
mkdir -p ~/.ssh
printf '%s\n' 'ssh-ed25519 AAAA... your-pc' >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

Use the username, IP, and command printed by the installer:

```powershell
ssh -p 8022 TERMUX_USERNAME@PHONE_LAN_IP
```

If the IP changes, open Termux and run:

```sh
node -e 'for(const x of Object.values(require("node:os").networkInterfaces()).flat())if(x&&x.family==="IPv4"&&!x.internal)console.log(x.address)'
```

For convenience, add a PC entry to `$env:USERPROFILE\.ssh\config`:

```sshconfig
Host streamforge-phone
    HostName PHONE_LAN_IP
    Port 8022
    User TERMUX_USERNAME
    IdentityFile ~/.ssh/id_ed25519
```

Then connect with `ssh streamforge-phone`. A DHCP reservation in the router is
better than hard-coding an address that the router may reassign.

## 4. Keep it alive without wasting the phone

Android, not runit, has final control of Termux's process. Apply these settings:

1. Android Settings → Apps → Termux → Battery → choose **Unrestricted** or
   **Don't optimize**.
2. Allow background activity and disable vendor-specific auto-clean/sleep for
   Termux.
3. Keep Wi-Fi enabled while the screen is off. A stable 5 GHz connection is
   preferable when the phone is near the router.
4. Install and open Termux:Boot once if the service should return after a phone
   reboot.

For a live stream, take a wake lock before going live:

```sh
termux-wake-lock
```

Release it after the stream:

```sh
termux-wake-unlock
```

A permanent wake lock improves availability but consumes battery, so the boot
script intentionally does not take one. Keep the phone ventilated and use a
reliable low-heat charger; sustained charging, screen-on use, and high battery
temperature accelerate battery wear. The single Node process, uncompressed
WebSocket traffic, conservative polling, and bounded runit logs keep the server
light, but Android may still kill it under severe device memory pressure.

## 5. Service operation

The installer uses Termux's `runit` supervisor:

```sh
sv status streamforge
sv up streamforge
sv restart streamforge
sv down streamforge
svlogtail streamforge
```

SSH is managed the same way:

```sh
sv status sshd
sv restart sshd
```

If `sv` says it cannot open the service directory immediately after the first
installation, fully close and reopen Termux once. The next shell starts the
Termux service supervisor.

The app's runit logs are capped at about five 1 MB files. Application data lives
under `DATA_DIR` (default `~/streamforge-local/data`); secrets live in
`~/streamforge-local/.env`.

## 6. Work from the PC

Open an SSH session and edit files with your preferred remote editor. VS Code's
Remote - SSH extension can use the `streamforge-phone` host entry. Restart the
service after changing `.env` or server code:

```sh
cd ~/streamforge-local
sv restart streamforge
```

For a safer OAuth setup from the PC, create a loopback tunnel:

```powershell
ssh -N -L 8787:127.0.0.1:8787 streamforge-phone
```

While that session is open, `http://127.0.0.1:8787/` on the PC reaches the
phone. This is especially useful for exact loopback OAuth redirects. It does
not make the service public.

## 7. Troubleshooting

- **Dashboard works on the phone but not the PC:** confirm both devices are on
  the same non-guest Wi-Fi. Guest/client-isolation networks block peer traffic.
- **The address stopped working:** the router probably assigned a new IP.
  Recheck it or add a DHCP reservation.
- **`signal 9` / service disappears:** Android killed Termux. Recheck battery
  settings, reduce other apps, and use `termux-wake-lock` while streaming.
- **SSH refuses the key:** verify the public key is one physical line and the
  `.ssh`/`authorized_keys` permissions are `700`/`600`.
- **GitHub says 404 for `install.sh`:** confirm that
  `mereMint/streamforge-local` has been published and its default branch is
  `main`. A GitHub login is not required to read it.
- **Update is skipped:** run `git -C ~/streamforge-local status`. The installer
  intentionally will not overwrite local source changes.

Do not solve a LAN problem by forwarding ports `8787` or `8022` on the router.
See [SECURITY.md](SECURITY.md) for remote-access alternatives.
