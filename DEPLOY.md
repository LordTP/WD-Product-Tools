# Deploy — wanderdoll.truepathgroup.co.uk

DigitalOcean droplet + Docker Compose. The stack runs the **app** (internal) behind
**Caddy**, which auto-provisions Let's Encrypt HTTPS. SQLite persists on a volume.

## 0. DNS (do this first)
In the DNS for `truepathgroup.co.uk`, add an **A record**:
- Host: `wanderdoll`
- Value: the droplet's public IP (from step 1)

Caddy can't get a cert until this resolves, so set it as early as possible.

## 1. Create the droplet
DigitalOcean → Create → Droplet:
- **Ubuntu 24.04 LTS**
- **Basic → Regular SSD → 2 GB RAM / 1 vCPU / 50 GB** (~$12/mo)
- Region **London (LON1)**
- Auth: SSH key (preferred) or password

Copy the public IP and put it in the DNS A record (step 0).

## 2. Log in + install Docker + firewall
```bash
ssh root@<droplet-ip>
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

## 3. Get the code (private repo)
Use a GitHub Personal Access Token (classic, `repo` scope):
```bash
git clone https://<YOUR_GH_TOKEN>@github.com/LordTP/WD-Product-Tools.git
cd WD-Product-Tools
```

## 4. Configure secrets
```bash
cp .env.example .env
nano .env
```
Set:
```
APP_PASSWORD=<your real team password>     # the login password
SHIPHERO_REFRESH_TOKEN=<your refresh token> # from local .env.local
```
Leave `SHIPHERO_ACCESS_TOKEN` and `SHIPHERO_WAREHOUSE_ID` blank (auto-handled).
Save: Ctrl-O, Enter, Ctrl-X.

## 5. Build + start
```bash
docker compose up -d --build
```
First build takes a few minutes. Caddy then fetches the TLS cert automatically.

## 6. Port your existing data (optional)
Skip if you'd rather start empty and Sync from ShipHero. To bring your current
data over, from your **local machine** create + copy the snapshot:
```bash
# local: in the product-tool dir, make a clean snapshot
node -e "const D=require('better-sqlite3');const db=new D('data.db');const fs=require('fs');if(fs.existsSync('live-seed.db'))fs.unlinkSync('live-seed.db');db.exec(\"VACUUM INTO 'live-seed.db'\");db.close();"
# local: copy it up
scp live-seed.db root@<droplet-ip>:~/WD-Product-Tools/
```
Then on the **droplet**:
```bash
docker compose cp live-seed.db app:/data/data.db
docker compose restart app
rm live-seed.db
```

## 7. Verify
```bash
docker compose ps                # app + caddy both "running"
docker compose logs -f caddy     # look for "certificate obtained"; Ctrl-C to exit
```
Visit **https://wanderdoll.truepathgroup.co.uk** → login with `APP_PASSWORD` →
Dashboard. If you didn't port data, click **Sync** to pull POs.

## Updating after new commits
```bash
cd WD-Product-Tools && git pull && docker compose up -d --build
```
Data is safe on the `po-data` volume; certs on `caddy-data`.

## Cheaper 1 GB droplet? Add swap first (before step 5)
```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## Troubleshooting
- **No cert / Caddy retrying:** DNS isn't pointing at the droplet yet, or 80/443 are
  blocked. Fix DNS / `ufw`, Caddy self-heals.
- **Build killed (OOM) on 1 GB:** add the swap file above, re-run `up --build`.
- **Logs:** `docker compose logs -f app` and `docker compose logs -f caddy`.
