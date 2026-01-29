# Production Deployment Guide

Deploy the MDM server and admin UI using PM2 on Ubuntu/Debian.

## Architecture

```
                    ┌─────────────────────────┐
                    │   Nginx Proxy Manager   │
                    └───────────┬─────────────┘
                                │
            ┌───────────────────┴───────────────────┐
            │                                       │
            ▼                                       ▼
┌───────────────────────┐             ┌───────────────────────┐
│  proxymdm.example.com │             │  mdmadmin.example.com │
│  (port 7899)          │             │  (port 7099)          │
│                       │             │                       │
│   MDM Server API      │             │   Admin Dashboard     │
│   + WebSocket         │             │   (Static React App)  │
└───────────────────────┘             └───────────────────────┘
```

The admin dashboard uses relative paths (`/api/...`, `/admin`) so Nginx must
proxy API and WebSocket requests from the admin domain to the server on port 7899.

## Prerequisites

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install build tools for native modules (better-sqlite3)
sudo apt-get install -y build-essential python3

# Verify installation
node --version  # Should be v18.x or higher
npm --version

# Install PM2 globally
sudo npm install -g pm2

# Install git if not present
sudo apt install -y git
```

## 1. Clone Repository

```bash
# Create app directory
sudo mkdir -p /opt/androidremote
sudo chown -R $USER:$USER /opt/androidremote

# Clone the repository
cd /opt
git clone <your-repo-url> androidremote
cd androidremote
```

## 2. Build Server

```bash
cd /opt/androidremote/server

# Install dependencies
npm install

# Build TypeScript to JavaScript
npm run build

# Create data directories
mkdir -p data/storage
```

## 3. Update Server CORS for Production

Edit `server/src/app.ts` and add your production domains to the `allowedPatterns` array:

```typescript
const allowedPatterns = [
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
  /^http:\/\/192\.168\.\d+\.\d+:\d+$/,
  /^http:\/\/10\.\d+\.\d+\.\d+:\d+$/,
  /^https?:\/\/mdmadmin\.example\.com$/,   // Your admin domain
  /^https?:\/\/proxymdm\.example\.com$/,   // Your API domain
];
```

Then rebuild:

```bash
cd /opt/androidremote/server
npm run build
```

## 4. Build Web UI

```bash
cd /opt/androidremote/web-ui

# Install dependencies
npm install

# Build for production (no .env needed - uses relative paths)
npm run build

# Install static file server
npm install serve
```

## 5. Create PM2 Ecosystem File

```bash
cat > /opt/androidremote/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'mdm-server',
      cwd: '/opt/androidremote/server',
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
      cwd: '/opt/androidremote/web-ui',
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
EOF
```

## 6. Start Services

```bash
cd /opt/androidremote

# Start all apps
pm2 start ecosystem.config.js

# Verify both are running
pm2 status

# Test locally
curl -s http://localhost:7899/health
curl -s -o /dev/null -w "%{http_code}" http://localhost:7099

# Save PM2 state and enable boot startup
pm2 save
pm2 startup
# Follow the instructions printed (copy/paste the sudo command)
```

## 7. Configure Nginx Proxy Manager

> **Docker networking note:** If Nginx Proxy Manager runs in Docker, use the
> host's LAN IP (e.g. `10.0.1.x` or `192.168.x.x`) instead of `127.0.0.1`
> in both the Forward Hostname/IP field and any custom location blocks.
> `127.0.0.1` inside Docker refers to the container, not the host.

### Proxy Host 1: MDM Server API (`proxymdm.example.com`)

This is the endpoint Android devices connect to.

| Setting | Value |
|---------|-------|
| **Domain Names** | `proxymdm.example.com` |
| **Scheme** | `http` |
| **Forward Hostname/IP** | Your server IP |
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

# APK upload support (500MB max)
client_max_body_size 500M;
proxy_buffer_size 128k;
proxy_buffers 4 256k;
proxy_busy_buffers_size 256k;
```

### Proxy Host 2: Admin Dashboard (`mdmadmin.example.com`)

This serves the React app and proxies API/WebSocket calls to the server.

| Setting | Value |
|---------|-------|
| **Domain Names** | `mdmadmin.example.com` |
| **Scheme** | `http` |
| **Forward Hostname/IP** | Your server IP |
| **Forward Port** | `7099` |
| **Cache Assets** | ON |
| **Websockets Support** | ON |
| **Block Common Exploits** | ON |
| **SSL** | Request new Let's Encrypt certificate, Force SSL |

**Advanced Tab - Custom Nginx Configuration:**

Replace `<SERVER_IP>` with your server's LAN IP (e.g. `10.0.1.219`):

```nginx
# Proxy /api/* requests to the MDM server
location /api/ {
    proxy_pass http://<SERVER_IP>:7899;
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
    proxy_pass http://<SERVER_IP>:7899;
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
    proxy_pass http://<SERVER_IP>:7899;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
```

**Why location blocks are needed:** The admin dashboard makes API calls to `/api/...` using relative paths. Without the location blocks, those requests would go to the static file server (port 7099) instead of the MDM server (port 7899).

## 8. Verify Deployment

```bash
# PM2 status
pm2 status

# Test API directly
curl http://localhost:7899/health

# Test admin UI static files
curl -s -o /dev/null -w "%{http_code}" http://localhost:7099

# Test external (after Nginx setup)
curl https://proxymdm.example.com/health
curl -s -o /dev/null -w "%{http_code}" https://mdmadmin.example.com

# View logs
pm2 logs mdm-server --lines 50
pm2 logs mdm-admin-ui --lines 50
```

## 9. Firewall Configuration

```bash
# If using ufw, allow the ports (optional if nginx handles external traffic)
sudo ufw allow 7899/tcp  # MDM server
sudo ufw allow 7099/tcp  # Admin UI

# Or just allow nginx to handle external traffic on 80/443
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

## 10. Configure Android Devices

After deployment, set the server URL on Android devices to:

```
https://proxymdm.example.com
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

## Updating the Application

```bash
cd /opt/androidremote

# Pull latest changes
git pull origin master

# Rebuild server
cd server && npm install && npm run build && cd ..

# Rebuild web UI
cd web-ui && npm install && npm run build && cd ..

# Reload applications (zero-downtime)
pm2 reload all
```

## Backup Database

```bash
# Manual backup
cp /opt/androidremote/server/data/mdm.db \
   /opt/androidremote/server/data/mdm.db.backup.$(date +%Y%m%d)

# Automated daily backup (add to crontab -e)
0 2 * * * cp /opt/androidremote/server/data/mdm.db /opt/androidremote/server/data/backups/mdm.db.$(date +\%Y\%m\%d)
```

## Troubleshooting

### Server won't start
```bash
# Check logs for errors
pm2 logs mdm-server --lines 100

# Check if port is in use
sudo lsof -i :7899

# Kill process using port
sudo kill -9 $(sudo lsof -t -i:7899)
```

### Database errors
```bash
# Check database file permissions
ls -la /opt/androidremote/server/data/

# Fix permissions
chmod 755 /opt/androidremote/server/data/
chmod 644 /opt/androidremote/server/data/mdm.db

# Rebuild native module if needed
cd /opt/androidremote/server && npm rebuild better-sqlite3
```

### Admin UI shows blank / API errors
```bash
# Check that Nginx location blocks are proxying /api/ and /ws and /admin
curl -v https://mdmadmin.example.com/api/devices
# If 502: the location blocks are missing or proxy_pass points to 127.0.0.1
# inside a Docker container. Use the host's LAN IP instead.
```

### WebSocket connection issues
```bash
# Verify "Websockets Support" is ON in Nginx Proxy Manager
# Check the Advanced config has proxy_set_header Upgrade
# If using Docker, check Nginx error logs:
docker logs <nginx-container-name> --tail 50
```
