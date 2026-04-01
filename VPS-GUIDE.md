# OpenDescent VPS Operations Guide

## Server Details

- **Provider:** DigitalOcean
- **IP:** 188.166.151.203
- **Domain:** open-descent.com
- **SSH:** `ssh -i "C:\Users\AlanO\Validiti Server\validiti_id" root@188.166.151.203`

---

## Services Running

| Service | Port | PM2 Name | Purpose |
|---------|------|----------|---------|
| Relay Node | 6001 (TCP), 6002 (WS) | `index` | libp2p relay, DHT, P2P mesh |
| License Server | 9000 | `license-server` | Stripe checkout, license keys |
| Nginx | 80, 443 | system service | SSL, landing page, reverse proxy |
| CoTURN | 3478, 5349 | system service | TURN relay for voice/video calls |

---

## Common Operations

### Deploy Code Updates

```bash
cd /root/OpenDescent && git pull && npx tsc && pm2 restart index && pm2 restart license-server
```

### Update Landing Page

```bash
cd /root/OpenDescent && git pull && cp frontend/landing.html /var/www/open-descent/ && cp -r frontend/fonts /var/www/open-descent/
```

### Check All Services

```bash
pm2 list
systemctl status nginx
systemctl status coturn
```

### View Relay Logs

```bash
pm2 logs index --lines 50
```

### View Relay Errors Only

```bash
pm2 logs index --err --lines 30
```

### View License Server Logs

```bash
pm2 logs license-server --lines 30
```

### Restart Individual Services

```bash
pm2 restart index              # Relay node
pm2 restart license-server     # Stripe/license server
systemctl restart nginx        # Web server
systemctl restart coturn        # TURN server
```

### Restart Everything

```bash
pm2 restart all && systemctl restart nginx && systemctl restart coturn
```

### Stop Everything

```bash
pm2 stop all && systemctl stop nginx && systemctl stop coturn
```

---

## SSL Certificate

- **Provider:** Let's Encrypt (free, auto-renewing)
- **Cert location:** `/etc/letsencrypt/live/open-descent.com/fullchain.pem`
- **Key location:** `/etc/letsencrypt/live/open-descent.com/privkey.pem`
- **Expires:** Auto-renews via certbot timer
- **Domains covered:** open-descent.com, www, pay, relay1

### Check SSL Expiry

```bash
certbot certificates
```

### Force Renew SSL

```bash
systemctl stop nginx && certbot renew && systemctl start nginx
```

---

## Nginx Config

- **Config file:** `/etc/nginx/sites-available/open-descent`
- **Landing page root:** `/var/www/open-descent/`

### Test Config After Editing

```bash
nginx -t && systemctl restart nginx
```

### Edit Config

```bash
nano /etc/nginx/sites-available/open-descent
```

---

## Domains / DNS (Ionos)

| Subdomain | Type | Points to | Purpose |
|-----------|------|-----------|---------|
| @ | A | 188.166.151.203 | Landing page |
| www | A | 188.166.151.203 | Landing page |
| pay | A | 188.166.151.203 | Stripe checkout |
| relay1 | A | 188.166.151.203 | Relay hostname |

---

## Environment Variables (License Server)

Stored in `/root/OpenDescent/.env-license`:

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PRICE_ID=price_1TD93I13ZaqW84U7IIWJ4s1S
LICENSE_PRIVATE_KEY=MC4CAQAwBQYDK2VwBCIEICVMwf23HmX2IKCuZerMmPpr3aH0/1sPWj9TeOt9JFJR
LICENSE_PORT=9000
LICENSES_FILE=/root/OpenDescent/licenses.json
```

**Never commit this file.** It's only on the VPS.

---

## TURN Server (CoTURN)

- **Config:** `/etc/turnserver.conf`
- **Credentials:** username `opendescent`, password `Od3sc3nt2025!`
- **Ports:** 3478 (TCP/UDP), 5349 (TLS), 49152-65535 (media relay)

### Check TURN Status

```bash
systemctl status coturn
```

---

## Relay Storage

- **Data dir:** `/root/OpenDescent/data-relay/`
- **Store (LevelDB):** `/root/OpenDescent/data-relay/store/`
- **Max storage:** 512MB (configured in code)

### Check Storage Usage

```bash
du -sh /root/OpenDescent/data-relay/store/
```

### Clear Shard Storage (if full)

```bash
pm2 stop index && rm -rf /root/OpenDescent/data-relay/store && pm2 start index
```

**Warning:** This deletes all stored posts, shards, and peer data on the relay. The relay will rebuild from peer sync.

---

## Firewall (UFW)

### Check Rules

```bash
ufw status
```

### Current Open Ports

| Port | Purpose |
|------|---------|
| 22 | SSH |
| 80 | HTTP (redirects to HTTPS) |
| 443 | HTTPS (nginx) |
| 3478 | TURN (UDP/TCP) |
| 5349 | TURN TLS |
| 6001 | libp2p TCP |
| 6002 | libp2p WebSocket |
| 9000 | License server (proxied via nginx) |
| 49152-65535 | TURN media relay (UDP) |

---

## PM2 Startup (Auto-Start on Reboot)

```bash
pm2 save
pm2 startup
```

This ensures `index` and `license-server` restart automatically if the VPS reboots.

---

## Troubleshooting

### Relay keeps restarting

```bash
pm2 logs index --err --lines 50
```

Common causes: storage full, port conflict, code error after update.

### License server not responding

```bash
pm2 logs license-server --err --lines 20
curl http://localhost:9000/license?peerId=test
```

Should return `{"error":"No license found for this peer"}`.

### SSL not working

```bash
certbot certificates
nginx -t
systemctl status nginx
```

### Landing page not updating after deploy

```bash
cp /root/OpenDescent/frontend/landing.html /var/www/open-descent/
cp -r /root/OpenDescent/frontend/fonts /var/www/open-descent/
```

### TURN server not working

```bash
systemctl status coturn
ufw status | grep 3478
```

### Can't SSH in

The SSH key is at `C:\Users\AlanO\Validiti Server\validiti_id`. If the passphrase prompt appears, enter the key passphrase. If "Permission denied", the key may have changed — check DigitalOcean console access.

---

## Full Deploy Checklist (After Code Changes)

1. `git push` from local machine
2. SSH into VPS
3. `cd /root/OpenDescent && git pull && npx tsc`
4. `pm2 restart index && pm2 restart license-server`
5. `cp frontend/landing.html /var/www/open-descent/` (if landing page changed)
6. `cp -r frontend/fonts /var/www/open-descent/` (if fonts changed)
7. Verify: `pm2 list` (both online), `curl https://open-descent.com` (landing page loads)
