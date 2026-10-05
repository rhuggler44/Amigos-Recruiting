# Deploying Amigos Outreach

The app needs three things from wherever it runs:

1. **To stay on 24/7**, because it sends on a schedule and checks inboxes for replies every few minutes.
2. **A disk that persists**, because contacts, campaigns and send history live in one SQLite file.
3. **Outgoing access to mail servers** on ports 465/587 (sending) and 993 (reading replies).

| Where | Works? | Notes |
|---|---|---|
| **Your existing VPS** | ✅ Best option | One command installs it next to whatever else is running. Uses ~100 MB of RAM. |
| Shared hosting with cPanel "Setup Node.js App" | ⚠️ Sometimes | Only if the host offers Node 22.13+ and allows outgoing mail ports. See option B. |
| Cloudflare Workers / Pages (free) | ❌ Not as-is | Workers can't keep a database file, run a background scheduler, or log into mailboxes the way this app does. It would need a rewrite. |
| Cloudflare **Tunnel** (free) | ✅ As an add-on | Puts the app on a web address without opening ports or touching an existing web server. Pairs with A or B. See option C. |

---

## Option A: existing VPS (recommended)

Works on Ubuntu or Debian. It doesn't touch your existing sites: it installs its own private copy of Node.js,
runs as its own user, listens only on `127.0.0.1`, and adds one site entry to whichever web server you already use
(nginx, Apache, or Caddy). If no web server is installed, it sets up Caddy.

**1. Pick a web address and point it at the server.**
In your DNS (wherever the domain is managed), add an **A record**, for example:

| Type | Name | Value |
|---|---|---|
| A | `go` | your server's IP address |

Use a subdomain of your outreach domain (`go.amigoshiring.com`) once you've bought it. Until then, a subdomain of any
domain you own works. You can change it later by re-running the installer with the new name.

**2. Put the code on the server** (SSH in first):

```bash
sudo git clone https://github.com/rhuggler44/Amigos-Recruiting.git /opt/amigos-outreach
```

The repository is private, so git will ask for a username and password. Use your GitHub username and a
[personal access token](https://github.com/settings/tokens) (classic, `repo` scope) as the password.
No git? Download the ZIP from GitHub, upload it, and unzip it into `/opt/amigos-outreach`.

**3. Run the installer:**

```bash
cd /opt/amigos-outreach
sudo bash deploy/install.sh go.amigoshiring.com you@amigosrecruiting.com
```

It prints the dashboard address and a generated admin password. The email address is only used for the
HTTPS certificate expiry notices.

**4. Read the "Mail ports" section of the output.** If it says **BLOCKED**, your provider blocks outgoing email
ports. DigitalOcean, Linode, Vultr and some others do this on new accounts. Open a support ticket asking them
to allow outbound SMTP on ports 465 and 587 for sending business email. Until then, the app works in dry-run mode.

**5. Log in, do the setup in the dashboard** (README → "Going live"), then switch to live sending:

```bash
sudo nano /opt/amigos-outreach/.env        # SEND_MODE=live, and add ANTHROPIC_API_KEY if you want Claude-written copy
sudo systemctl restart amigos-outreach
```

**Day-to-day**

| Task | Command |
|---|---|
| See logs | `journalctl -u amigos-outreach -f` |
| Restart | `sudo systemctl restart amigos-outreach` |
| Update to the latest version | `sudo bash /opt/amigos-outreach/deploy/update.sh` |
| Backups | Daily at 3:15 AM into `/var/lib/amigos-outreach/backups` (14 kept). Copy them off the server now and then. |

If the server runs **cPanel/WHM or Plesk**, the installer still installs and runs the app, but leaves the web server alone.
Panels overwrite manual configs. Either add a reverse proxy for the subdomain to `http://127.0.0.1:3100`
in the panel (Plesk: *Apache & nginx Settings → Additional nginx directives*), or use option C.

---

## Option B: shared hosting with "Setup Node.js App" (cPanel)

Only try this if your host's Node.js selector offers **version 22.13 or newer**. Ask their support whether
**outgoing connections to smtp.gmail.com:465 and imap.gmail.com:993** are allowed. Many shared hosts block them.

1. Upload the code (ZIP from GitHub) to a folder outside `public_html`, such as `~/amigos-outreach`.
2. cPanel → **Setup Node.js App** → *Create application*:
   - Node.js version: 22.x
   - Application root: `amigos-outreach`
   - Application URL: your chosen subdomain
   - Application startup file: `app.cjs`
3. Add environment variables in the same screen (copy from `.env.example`): `ADMIN_PASSWORD`, `APP_SECRET`
   (32+ random characters), `PUBLIC_URL` (`https://` + the subdomain), `SEND_MODE=dry-run`, `DATA_DIR`
   (a folder in your home directory, e.g. `/home/USERNAME/amigos-data`) and `CRON_KEY` (another random string).
4. Click **Run NPM Install**, then **Restart**.
5. Shared hosts put idle apps to sleep, which would pause the scheduler. In cPanel → **Cron Jobs**, add one that runs every minute:

   ```
   curl -fsS "https://go.yourdomain.com/cron/tick?key=YOUR_CRON_KEY" >/dev/null
   ```

   Each request wakes the app and runs one round of queueing, sending and inbox checking.

---

## Option C: Cloudflare Tunnel (free, no ports or web server changes)

Use this with option A or B when you don't want to touch the server's web server config, or when the domain is
already on Cloudflare. The `cloudflared` program keeps an outgoing connection to Cloudflare, and Cloudflare serves your
subdomain through it with HTTPS. Nothing on the server needs to accept incoming connections.

1. Add the domain to a free Cloudflare account (Cloudflare becomes its DNS).
2. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** (type *Cloudflared*). Name it `amigos`.
3. Copy the install command it shows for Debian/Ubuntu and run it on the server.
4. Under **Public hostname**, add `go` . `yourdomain.com` → Service `HTTP` → `127.0.0.1:3100`
   (the port from `/opt/amigos-outreach/.env`).
5. Set `PUBLIC_URL=https://go.yourdomain.com` in `.env` and restart the app.

To run the installer without it setting up a web server, give it no domain: `sudo bash deploy/install.sh`.
Then set `PUBLIC_URL` by hand.

---

## Not sure what your hosting is?

SSH into it and run `cat /etc/os-release; ls -d /usr/local/cpanel /usr/local/psa 2>/dev/null; free -m`.

- **Ubuntu or Debian, no cPanel/Plesk:** option A.
- **cPanel or Plesk listed:** option A for the app, then the panel's proxy setting or option C for the web address.
- **No SSH access at all, just a hosting control panel:** option B. If the host can't offer Node 22.13+, the
  cheapest fallback is a $4–6/month VPS (Hetzner, DigitalOcean, Vultr) with option A.
