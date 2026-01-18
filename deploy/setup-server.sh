#!/bin/bash
# Run this on your VPS after SSH'ing in as root
# ssh root@YOUR_SERVER_IP

set -e

echo "=== Updating system ==="
apt update && apt upgrade -y

echo "=== Installing Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

echo "=== Installing PostgreSQL ==="
apt install -y postgresql postgresql-contrib

echo "=== Installing PM2 ==="
npm install -g pm2

echo "=== Installing Git ==="
apt install -y git

echo "=== Setting up PostgreSQL ==="
sudo -u postgres psql -c "CREATE USER bettr WITH PASSWORD 'bettr_prod_$(openssl rand -hex 8)';"
sudo -u postgres psql -c "CREATE DATABASE bettrbot OWNER bettr;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE bettrbot TO bettr;"

echo "=== Creating app directory ==="
mkdir -p /opt/bettr
cd /opt/bettr

echo "=== Cloning repository ==="
# You'll need to set up deploy key or use HTTPS with token
git clone git@github.com:YOUR_USERNAME/bettrbot.git .

echo "=== Installing dependencies ==="
npm install

echo "=== Building ==="
npm run build

echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
echo "1. Create /opt/bettr/.env with your environment variables"
echo "2. Run: npx prisma migrate deploy"
echo "3. Run: pm2 start dist/index.js --name bettr"
echo "4. Run: pm2 save && pm2 startup"
