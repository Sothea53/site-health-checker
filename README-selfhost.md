# Self-hosting the site health checker (bare Node.js + PM2)

Migrated off Cloudflare Workers — this now runs a real headless Chromium via
plain Puppeteer, stores data in a local SQLite file instead of Workers KV,
and uses `node-cron` instead of a Workers cron trigger.

## 1. System dependencies (Ubuntu/Debian)

Puppeteer's bundled Chromium needs these system libraries to run headless:

```bash
sudo apt-get update
sudo apt-get install -y \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
  libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 \
  libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 \
  libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 \
  libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
  libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 \
  libxtst6 lsb-release wget xdg-utils
```

(If you're on a different distro, the equivalent package names will differ —
this is the standard list Puppeteer's own docs recommend.)

## 2. Set up MongoDB

Storage uses MongoDB instead of SQLite (matches ServerAvatar's Node stack,
which only provisions MongoDB, not MySQL). If you're using ServerAvatar,
create the MongoDB service from its dashboard and copy the connection string
it gives you — that's your `MONGODB_URI`. Deploying elsewhere, either run a
local `mongod` (`sudo apt-get install -y mongodb-org` — note this needs
MongoDB's own APT repo added first, see MongoDB's official install docs) or
point at a hosted Mongo instance (Atlas free tier, etc).

The app creates its own `kv` collection and TTL index automatically on first
connection — no manual schema setup needed.

## 3. Install Node dependencies

Requires Node.js 18+.

```bash
npm install
```

This also downloads a matching Chromium build via `puppeteer` (~200MB) —
that's expected and only happens once.

## 4. Configure

Edit the `SITES` array near the top of `server.js` with your site list (same
as before). Environment variables (set in `ecosystem.config.js` or your
shell):

| Variable         | Default                                        | Purpose                                  |
|-------------------|------------------------------------------------|-------------------------------------------|
| `PORT`            | `3000`                                         | HTTP port to listen on                   |
| `MONGODB_URI`     | `mongodb://127.0.0.1:27017/site_health_checker`| Mongo connection string                  |
| `CRON_SCHEDULE`   | `0 7 * * *`                                    | Daily check time (cron syntax, local tz) |
| `CRON_TIMEZONE`   | `Asia/Phnom_Penh`                              | Timezone the cron schedule is evaluated in |

## 5. Run it under PM2

```bash
npm install -g pm2   # if not already installed
pm2 start ecosystem.config.js
pm2 save              # persist the process list
pm2 startup           # prints a command to run so PM2 survives a reboot — run it
```

Useful commands:

```bash
pm2 logs site-health-checker     # tail logs (this is where the diag() lines go)
pm2 restart site-health-checker  # after deploying code changes
pm2 status                       # check it's up
```

## 6. Put it behind a reverse proxy (optional but recommended)

If you want a real domain + HTTPS instead of hitting the raw port, put nginx
or Caddy in front. Example nginx server block:

```nginx
server {
    listen 80;
    server_name health.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Then run `certbot --nginx` (or Caddy's automatic HTTPS) for TLS.

## What changed from the Cloudflare version

- **Browser**: `@cloudflare/puppeteer` (bound via `env.MYBROWSER`) → plain
  `puppeteer`, launched locally with `--no-sandbox` (needed on most bare
  Linux servers unless you've set up a dedicated sandboxing user).
- **Storage**: Workers KV (`env.SITE_HEALTH_KV`) → a small MongoDB-backed
  shim (`kv.js`) with the same `get`/`put`/`list` shape, including TTL
  support via a native Mongo TTL index — so almost none of the storage logic
  in `server.js` had to change. (Originally built against SQLite, switched
  to MongoDB since ServerAvatar's Node stack only provisions MongoDB.)
- **Scheduling**: `wrangler.toml`'s `[triggers] crons` → `node-cron`,
  configured directly in local time (Asia/Phnom_Penh) instead of UTC.
- **Routing**: Cloudflare's `export default { fetch, scheduled }` → a
  regular Express app, with every async route handler wrapped so a failure
  (e.g. Mongo unreachable) returns a real error response instead of hanging
  the request indefinitely — the same silent-hang failure mode debugged at
  length on the Cloudflare version, worth avoiding here too.
- No more Free-plan limits — 10 min/day browser budget and 2–3 concurrent
  session caps are gone. The overlap-guard and retry-with-backoff logic
  were kept anyway as general good practice for a long-running process.

## Files

- `server.js` — the whole app (routes, checks, HTML generation, cron)
- `kv.js` — MongoDB-backed KV shim
- `ecosystem.config.js` — PM2 process config (only needed if you're not
  using ServerAvatar's own process management)
- `package.json` — dependencies
