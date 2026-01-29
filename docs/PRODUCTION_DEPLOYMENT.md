# Production Deployment Guide

Deploy the MDM server and admin UI on a production server using PM2.

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
│ proxymdm.footprints   │             │ mdmadmin.footprints   │
│ .media (port 7899)    │             │ .media (port 7099)    │
│                       │             │                       │
│   MDM Server API      │             │   Admin Dashboard     │
│   + WebSocket         │             │   (Static React App)  │
└───────────────────────┘             └───────────────────────┘
```

## Prerequisites

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

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
git clone https://github.com/andupetcu/androidremote.git
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
chmod 755 data
```

## 3. Build Web UI

```bash
cd /opt/androidremote/web-ui

# Create production environment file
cat > .env.production << 'EOF'
VITE_API_URL=https://proxymdm.footprints.media
VITE_WS_URL=wss://proxymdm.footprints.media
EOF

# Install dependencies
npm install

# Build for production
npm run build

# Install static file server
npm install serve
```

## 4. Create PM2 Ecosystem File

```bash
cat > /opt/androidremote/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'mdm-server',
      cwd: '/opt/androidremote/server',
      script: 'dist/app.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 7899,
        HOST: '0.0.0.0',
        DB_PATH: '/opt/androidremote/server/data/mdm.db',
        STORAGE_PATH: '/opt/androidremote/server/data/storage',
        CORS_ORIGIN: 'https://mdmadmin.footprints.media'
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

## 5. Start Services

```bash
cd /opt/androidremote

# Start all apps
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Enable PM2 to start on boot
pm2 startup
# Follow the instructions printed (copy/paste the sudo command)
```

## 6. Configure Nginx Proxy Manager

### Proxy Host 1: MDM Server API

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
# Long timeout for WebSocket connections (24 hours)
proxy_read_timeout 86400s;
proxy_send_timeout 86400s;

# WebSocket upgrade headers
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";

# Increase buffer sizes for large payloads (APK uploads)
client_max_body_size 500M;
proxy_buffer_size 128k;
proxy_buffers 4 256k;
proxy_busy_buffers_size 256k;
```

### Proxy Host 2: Admin Dashboard

| Setting | Value |
|---------|-------|
| **Domain Names** | `mdmadmin.footprints.media` |
| **Scheme** | `http` |
| **Forward Hostname/IP** | `127.0.0.1` |
| **Forward Port** | `7099` |
| **Cache Assets** | ON |
| **Websockets Support** | OFF |
| **Block Common Exploits** | ON |
| **SSL** | Request new Let's Encrypt certificate, Force SSL |

## 7. Verify Deployment

```bash
# Check PM2 status
pm2 status

# Expected output:
# ┌─────┬──────────────────┬─────────────┬─────────┬─────────┬──────────┐
# │ id  │ name             │ namespace   │ version │ mode    │ pid      │
# ├─────┼──────────────────┼─────────────┼─────────┼─────────┼──────────┤
# │ 0   │ mdm-server       │ default     │ 1.0.0   │ fork    │ 12345    │
# │ 1   │ mdm-admin-ui     │ default     │ 1.0.0   │ fork    │ 12346    │
# └─────┴──────────────────┴─────────────┴─────────┴─────────┴──────────┘

# Test server health endpoint
curl http://localhost:7899/api/health

# Test admin UI
curl -I http://localhost:7099

# View logs
pm2 logs mdm-server --lines 50
pm2 logs mdm-admin-ui --lines 50
```

## 8. Firewall Configuration

```bash
# If using ufw, allow the ports (optional if nginx handles external traffic)
sudo ufw allow 7899/tcp  # MDM server
sudo ufw allow 7099/tcp  # Admin UI

# Or just allow nginx to handle external traffic on 80/443
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

## PM2 Management Commands

```bash
# View all processes
pm2 list

# Restart all apps
pm2 restart all

# Restart specific app
pm2 restart mdm-server

# Zero-downtime reload
pm2 reload mdm-server

# Stop an app
pm2 stop mdm-admin-ui

# Delete an app from PM2
pm2 delete mdm-server

# View real-time logs
pm2 logs

# View logs for specific app
pm2 logs mdm-server --lines 100

# Real-time monitoring dashboard
pm2 monit

# Show app details
pm2 show mdm-server

# Flush logs
pm2 flush
```

## Updating the Application

```bash
cd /opt/androidremote

# Pull latest changes
git pull origin master

# Rebuild server
cd server
npm install
npm run build

# Rebuild web UI
cd ../web-ui
npm install
npm run build

# Reload applications (zero-downtime)
pm2 reload all
```

## Backup Database

```bash
# Create backup
cp /opt/androidremote/server/data/mdm.db /opt/androidremote/server/data/mdm.db.backup.$(date +%Y%m%d)

# Automated daily backup (add to crontab)
# crontab -e
# 0 2 * * * cp /opt/androidremote/server/data/mdm.db /opt/androidremote/server/data/backups/mdm.db.$(date +\%Y\%m\%d)
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
```

### WebSocket connection issues
```bash
# Verify WebSocket support in nginx proxy manager is enabled
# Check nginx error logs
sudo tail -f /var/log/nginx/error.log
```
