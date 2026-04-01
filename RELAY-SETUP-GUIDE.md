# Running Your Own OpenDescent Relay Node

## What Is a Relay?

A relay node is a publicly reachable OpenDescent instance that helps other peers connect to each other. When two users are both behind NAT (home routers, firewalls), they can't connect directly — the relay acts as a bridge, forwarding encrypted data between them.

**The relay cannot read your data.** All messages, calls, and files are end-to-end encrypted between the sender and receiver. The relay just passes opaque encrypted packets — like a postal service carrying sealed envelopes!

Running a relay helps decentralise the network and reduces reliance on any single operator.

---

## Requirements

- A VPS or server with a **public IP address** (DigitalOcean, Hetzner, Vultr, Linode — $4-6/mo)
- **Node.js 18+** installed
- **Open ports:** 6001 (TCP), 6002 (WebSocket)
- Optional: a domain name for easier bootstrap addresses

---

## Quick Setup (5 minutes)

### 1. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs
```

### 2. Clone and Build

```bash
git clone https://github.com/Jaguwa/OpenDescent.git
cd OpenDescent
npm install
npm run build
```

### 3. Start the Relay

```bash
node dist/index.js \
  --port 6001 \
  --name "MyRelay" \
  --public \
  --announce-ip YOUR_VPS_IP \
  --data ./data-relay
```

Replace `YOUR_VPS_IP` with your server's public IP address.

**Flags explained:**
- `--port 6001` — TCP port for libp2p connections
- `--name "MyRelay"` — display name shown to peers
- `--public` — enables relay mode (DHT server + circuit relay)
- `--announce-ip` — your server's public IP (so peers know how to reach you)
- `--data ./data-relay` — where to store data

### 4. Open Firewall Ports

```bash
sudo ufw allow 6001/tcp
sudo ufw allow 6002/tcp
```

Port 6002 is automatically used for WebSocket connections (TCP port + 1).

### 5. Verify It's Running

You should see:
```
[Node] PUBLIC mode — this node is a DHT server and circuit relay
[Node] Listening on:
  /ip4/YOUR_VPS_IP/tcp/6001/p2p/12D3KooW...
  /ip4/YOUR_VPS_IP/tcp/6002/ws/p2p/12D3KooW...
```

The `/ip4/.../p2p/12D3KooW...` address is your relay's bootstrap address. Other users can connect by adding it with `--bootstrap` or via the app's invite code.

---

## Keep It Running (PM2)

Install PM2 to keep the relay running after you disconnect:

```bash
sudo npm install -g pm2
pm2 start dist/index.js --name relay -- --port 6001 --name "MyRelay" --public --announce-ip YOUR_VPS_IP --data ./data-relay
pm2 save
pm2 startup
```

### Useful PM2 Commands

```bash
pm2 list              # Check status
pm2 logs relay        # View logs
pm2 restart relay     # Restart
pm2 stop relay        # Stop
```

---

## Optional: Add TURN Server (For Voice/Video Calls)

If you want your relay to also help with voice/video calls through NAT:

### Install CoTURN

```bash
sudo apt install -y coturn
```

### Configure

```bash
sudo cat > /etc/turnserver.conf << 'EOF'
listening-port=3478
tls-listening-port=5349
realm=your-domain.com
server-name=your-domain.com
fingerprint
lt-cred-mech
user=opendescent:YourSecurePassword
no-stdout-log
syslog
EOF
```

### Start

```bash
sudo systemctl enable coturn
sudo systemctl start coturn
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49152:65535/udp
```

---

## Optional: Domain + SSL

If you have a domain, point an A record to your VPS IP, then:

```bash
sudo apt install -y certbot
sudo certbot certonly --standalone -d relay.yourdomain.com --agree-tos --email your@email.com
```

---

## Connecting Users to Your Relay

Users can connect to your relay by adding your bootstrap address. There are two ways:

### Via Command Line

```bash
node dist/index.js --name "UserName" --bootstrap /ip4/YOUR_VPS_IP/tcp/6001/p2p/YOUR_PEER_ID
```

### Via the App

Share your relay's invite code (shown on startup) — users paste it in the Connect Peer modal.

---

## How Much Resources Does It Use?

| Resource | Typical Usage |
|----------|---------------|
| CPU | <5% idle, spikes during shard transfers |
| RAM | 50-120MB |
| Disk | 200-500MB (posts, shards, peer data) |
| Bandwidth | Varies — ~1GB/day with 10 active users |

A $4-6/mo VPS handles hundreds of users comfortably.

---

## Storage Management

The relay stores posts (35-day window) and file shards from connected peers. To check usage:

```bash
du -sh data-relay/store/
```

To clear and start fresh (doesn't affect the relay's identity):

```bash
pm2 stop relay
rm -rf data-relay/store
pm2 start relay
```

---

## Security Notes

- The relay **cannot read** any messages, calls, or files — everything is end-to-end encrypted
- The relay **can see** that two peers are communicating (metadata) but not what they're saying
- The relay **cannot impersonate** users — all identities are cryptographic (Ed25519)
- Running a relay **does not expose your personal data** — the relay has its own identity separate from any user account
- You can run a relay **without using the app** yourself — it's just infrastructure

---

## Updating

```bash
cd OpenDescent
git pull
npm run build
pm2 restart relay
```
