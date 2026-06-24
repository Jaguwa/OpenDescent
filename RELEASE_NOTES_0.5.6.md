# OpenDescent v0.5.6

hello peeps,

This one's for the self-hosters. You can now run the network entirely on **your own relay** — your home connection or VPS — instead of leaning on the project's default infrastructure.

## Download

Download **`OpenDescent Setup 0.5.6.exe`** below and install.

---

## What's New in 0.5.6

### Bring your own relay

- **Clients now prefer a relay you specify.** Point a client at your relay with `--bootstrap` and its circuit reservation lands on *your* relay — so your relay actually carries the traffic, instead of quietly falling back to the project's default relay.
- **New `--no-default-bootstrap` flag.** Drops the built-in relays entirely so a node runs purely on your own infrastructure. Run a `--public` relay on a machine with a static IP and forwarded ports, point your other machines at it, and that box keeps the network up regardless of which clients are online.
- **Your LAN clients need no port-forwarding** — they reach the relay outbound and reserve a circuit on it. Only the relay box needs its ports open.
- Messages, files, and voice notes route through your relay end-to-end. (Live cross-network *video* still uses WebRTC/TURN — see the relay guide for the optional CoTURN step.)

See **[RELAY-SETUP-GUIDE.md](RELAY-SETUP-GUIDE.md)** → *Running an Independent Network* for the full setup.

---

## What You Get (full feature list)

- 🔒 End-to-end encrypted messaging with visible encryption animation
- 📞 Voice & video calls with noise suppression
- 📡 P2P live streaming — go live to your network *(Pro)*
- 🏰 Community hubs with text and voice channels
- 📢 Broadcast feed — share posts, photos, videos, polls
- 👻 Dead Drops — anonymous posts, no identity, gone in 24 hours
- 💀 Dead Man's Switch — auto-send messages on missed check-in *(Pro)*
- 📎 File sharing up to 35MB *(500MB with Pro)*
- 🛡 Trust web — vouch for peers, build reputation
- 🌐 Self-hostable relay — run the network on your own infrastructure
- 🔑 Your identity is a cryptographic keypair — no email, no password

---

## Windows Note

This build is signed by *Open Source Developer Alan Ivanovas* via Certum.
Windows SmartScreen may still show a brief warning on first download until the signing certificate builds reputation — click **"More info"** → **"Run anyway"**.
