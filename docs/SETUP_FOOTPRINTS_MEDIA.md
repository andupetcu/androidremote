# Footprints Media - Production Setup

Deploy the MDM server and admin UI using PM2 on Ubuntu/Debian.

**Server:** `ip-10-0-1-219` as user `pixot`, repo at `/home/pixot/androidremote`
**Domains (via Nginx Proxy Manager):**

| Domain | Purpose | Internal Port |
|--------|---------|---------------|
| `proxymdm.footprints.media` | MDM API (Android devices connect here) | 7899 |
| `mdmadmin.footprints.media` | Admin Dashboard + API proxy | 7099 (static) + 7899 (API) |

```
Android Devices ──► proxymdm.footprints.media ──► :7899 (MDM Server)

Browser ──► mdmadmin.footprints.media ─┬─► :7099 (Static UI files)
                                       ├─► :7899 /api/* (API proxy)
                                       └─► :7899 /ws   (WebSocket proxy)
```

The admin dashboard uses relative paths (`/api/...`) so Nginx must proxy API and WebSocket requests from the admin domain to the server.

---

## 1. Install Prerequisites

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# Verify
node --version   # v18.x or higher
npm --version

# Install PM2 globally
npm install -g pm2

# Install build tools for native modules (better-sqlite3)
apt-get install -y build-essential python3
```

## 2. Build Server

```bash
cd /home/pixot/androidremote/server

# Install dependencies
npm install

# Build TypeScript
npm run build

# Create data directories
mkdir -p data/storage
```

## 3. Update Server CORS for Production

Edit `server/src/app.ts` and update the CORS config to allow the admin domain:

```bash
# Find the CORS block (around line 47-63) and add the production domain
nano /home/pixot/androidremote/server/src/app.ts
```

Change the `allowedPatterns` array to:

```typescript
const allowedPatterns = [
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
  /^http:\/\/192\.168\.\d+\.\d+:\d+$/,
  /^http:\/\/10\.\d+\.\d+\.\d+:\d+$/,
  /^https?:\/\/mdmadmin\.footprints\.media$/,
  /^https?:\/\/proxymdm\.footprints\.media$/,
];
```

Then rebuild:

```bash
cd /home/pixot/androidremote/server
npm run build
```

## 4. Build Web UI

```bash
cd /home/pixot/androidremote/web-ui

# Install dependencies
npm install

# Build for production (no .env needed - uses relative paths)
npm run build

# Install static file server
npm install serve
```

## 5. Create PM2 Ecosystem File

```bash
cat > /home/pixot/androidremote/ecosystem.config.js << 'PMEOF'
module.exports = {
  apps: [
    {
      name: 'mdm-server',
      cwd: '/home/pixot/androidremote/server',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 7899
      }
    },
    {
      name: 'mdm-admin-ui',
      cwd: '/home/pixot/androidremote/web-ui',
      script: 'node_modules/.bin/serve',
      args: '-s dist -l 7099',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
PMEOF
```

## 6. Start Services

```bash
cd /home/pixot/androidremote

# Start all apps
pm2 start ecosystem.config.js

# Verify both are running
pm2 status

# Test locally
curl -s http://localhost:7899/api/health
curl -s -o /dev/null -w "%{http_code}" http://localhost:7099

# Save PM2 state and enable boot startup
pm2 save
pm2 startup
# If running as root, PM2 auto-detects. Otherwise follow the printed instructions.
```

## 7. Configure Nginx Proxy Manager

### Proxy Host 1: `proxymdm.footprints.media` (MDM Server API)

This is the endpoint Android devices connect to.

| Setting | Value |
|---------|-------|
| **Domain Names** | `proxymdm.footprints.media` |
| **Scheme** | `http` |
| **Forward Hostname/IP** | `127.0.0.1` |
| **Forward Port** | `7899` |
| **Cache Assets** | OFF |
| **Websockets Support** | ON |
| **Block Common Exploits** | ON |
| **SSL** | Request new Let's Encrypt certificate, Force SSL |

**Advanced Tab - Custom Nginx Configuration:**
```nginx
# WebSocket long-lived connections (24 hours)
proxy_read_timeout 86400s;
proxy_send_timeout 86400s;

# WebSocket upgrade
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";

# APK upload support (500MB max)
client_max_body_size 500M;
proxy_buffer_size 128k;
proxy_buffers 4 256k;
proxy_busy_buffers_size 256k;
```

### Proxy Host 2: `mdmadmin.footprints.media` (Admin Dashboard)

This serves the React app and proxies API/WebSocket calls to the server.

| Setting | Value |
|---------|-------|
| **Domain Names** | `mdmadmin.footprints.media` |
| **Scheme** | `http` |
| **Forward Hostname/IP** | `127.0.0.1` |
| **Forward Port** | `7099` |
| **Cache Assets** | ON |
| **Websockets Support** | ON |
| **Block Common Exploits** | ON |
| **SSL** | Request new Let's Encrypt certificate, Force SSL |

**Advanced Tab - Custom Nginx Configuration:**
```nginx
# Proxy /api/* requests to the MDM server
location /api/ {
    proxy_pass http://127.0.0.1:7899;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # APK upload support
    client_max_body_size 500M;
    proxy_buffer_size 128k;
    proxy_buffers 4 256k;
    proxy_busy_buffers_size 256k;
}

# Proxy /ws WebSocket to the MDM server
location /ws {
    proxy_pass http://127.0.0.1:7899;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}

# Proxy /admin WebSocket (real-time dashboard updates)
location /admin {
    proxy_pass http://127.0.0.1:7899;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}

# Proxy /api/uploads (static APK files) to the MDM server
location /api/uploads/ {
    proxy_pass http://127.0.0.1:7899;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}
```

**Why this is needed:** The admin dashboard makes API calls to `/api/...` using relative paths. Without the location blocks, those requests would go to the static file server (port 7099) instead of the MDM server (port 7899).

## 8. Verify Deployment

```bash
# PM2 status
pm2 status

# Test API directly
curl http://localhost:7899/api/health

# Test admin UI static files
curl -s -o /dev/null -w "%{http_code}" http://localhost:7099

# Test external (after Nginx setup)
curl https://proxymdm.footprints.media/api/health
curl -s -o /dev/null -w "%{http_code}" https://mdmadmin.footprints.media

# View logs
pm2 logs mdm-server --lines 50
pm2 logs mdm-admin-ui --lines 50
```

## 9. Configure Android Devices

After deployment, set the server URL on Android devices to:

```
https://proxymdm.footprints.media
```

This is the URL used for:
- QR code enrollment
- Command polling
- Telemetry reporting
- APK downloads

---

## PM2 Commands Reference

```bash
pm2 status                    # Show all processes
pm2 logs                      # All logs (real-time)
pm2 logs mdm-server           # Server logs only
pm2 monit                     # Real-time monitoring dashboard

pm2 restart all               # Restart everything
pm2 restart mdm-server        # Restart server only
pm2 reload mdm-server         # Zero-downtime reload

pm2 stop mdm-admin-ui         # Stop admin UI
pm2 delete mdm-server         # Remove from PM2

pm2 save                      # Save current state
pm2 resurrect                 # Restore saved state
```

## Updating

```bash
cd /home/pixot/androidremote

# Pull latest
git pull origin master

# Rebuild server
cd server && npm install && npm run build && cd ..

# Rebuild web UI
cd web-ui && npm install && npm run build && cd ..

# Reload
pm2 reload all
```

## Backup

```bash
# Manual backup
cp /home/pixot/androidremote/server/data/mdm.db \
   /home/pixot/androidremote/server/data/mdm.db.backup.$(date +%Y%m%d)

# Automated daily backup (add to crontab -e)
0 2 * * * cp /home/pixot/androidremote/server/data/mdm.db /home/pixot/androidremote/server/data/backups/mdm.db.$(date +\%Y\%m\%d)
```

## Troubleshooting

```bash
# Server won't start
pm2 logs mdm-server --lines 100
lsof -i :7899                        # Check port conflict

# Admin UI shows blank / API errors
# Check that Nginx location blocks are proxying /api/ and /ws
curl -v https://mdmadmin.footprints.media/api/health

# WebSocket not connecting
# Verify "Websockets Support" is ON in Nginx Proxy Manager
# Check the Advanced config has proxy_set_header Upgrade

# Database issues
ls -la /home/pixot/androidremote/server/data/
# Fix permissions if needed:
chown -R pixot:pixot /home/pixot/androidremote/server/data/

# Check native module (better-sqlite3)
cd /home/pixot/androidremote/server && npm rebuild better-sqlite3
```
