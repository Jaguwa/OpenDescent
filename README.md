# OpenDescent

**Group chats. Voice & video calls. Community hubs. Anonymous drops.**
**All encrypted. All peer-to-peer. No servers. No surveillance. No compromise.**

OpenDescent is a decentralized communication platform where your identity is a cryptographic keypair — not an email, not a phone number, not a password. Your messages are end-to-end encrypted before they leave your device. Your data lives on your device, not someone else's. There are no central servers. Just you and the mesh.

[Download](https://open-descent.com) · [Website](https://open-descent.com) · [Founder's Edition (£1 Lifetime Pro)](https://open-descent.com/#founder)

---

## What Can You Do?

**Private Messaging** — End-to-end encrypted DMs with forward secrecy. Watch your messages encrypt in real time through a visible cipher machine.

**Voice & Video Calls** — Encrypted WebRTC calls with automatic relay fallback. Noise suppression, volume controls, and voice-over-mesh when direct connections fail.

**Community Hubs** — Create spaces with text channels, voice channels, roles, and invites. Like servers, but decentralized — nobody can shut them down.

**Broadcast Feed** — Share posts, photos, videos, polls, and voice notes with the network. Filter by All, Friends, or Trending.

**Dead Drops** — Anonymous onion-routed posts. No identity attached. Proof-of-work spam prevention. Disappears in 24 hours. Drop zones: #Signals, #Leaks, #Confessions, #Local.

**File Sharing** — Encrypted, sharded, and distributed across peers. Files are signed with Ed25519 to prevent tampering.

**Trust Web** — Vouch for peers you trust. Build a visible reputation constellation. Cryptographically verifiable — no fake reviews.

**Dead Man's Switch** — Auto-send messages to chosen contacts if you don't check in within a set time window. Pro feature.

---

## Security

| Layer | Technology |
|-------|-----------|
| Identity | Ed25519 keypairs + 12-word mnemonic backup |
| Encryption | AES-256-GCM with ephemeral X25519 key exchange |
| Signatures | Ed25519 on all messages, posts, and file manifests |
| Network | libp2p mesh with circuit relay v2 + DCUtR hole-punching |
| Calls | DTLS-SRTP (WebRTC) + TURN relay + voice-over-libp2p fallback |
| Anonymous posts | Onion routing through 3+ relay hops |

The relay infrastructure cannot read your data. All encryption happens on your device. The relay just passes sealed packets — like a postal service carrying locked boxes.

---

## Download

**Windows:** [Download from open-descent.com](https://open-descent.com)

macOS and Linux coming soon.

Or run from source:

```bash
git clone https://github.com/Jaguwa/OpenDescent.git
cd OpenDescent
npm install
npm run build
npm start -- --name "YourName" --web-port 8080
```

Then open http://localhost:8080

---

## Founder's Edition

The first 101 users get **lifetime Pro access** for £1. Permanent founder badge on your profile. [Claim yours →](https://open-descent.com/#founder)

---

## Pro Features

Free tier is fully functional. Pro unlocks:

| Feature | Free | Pro |
|---------|------|-----|
| File sharing | 35MB | 500MB |
| Group size | 10 members | Unlimited |
| Hub creation | 2 | Unlimited |
| Dead Man's Switch | — | Unlimited |
| GIF avatar | — | Yes |
| Storage | 512MB | 2GB |

---

## Run Your Own Relay

Help decentralize the network by running a relay node. See the [Relay Setup Guide](RELAY-SETUP-GUIDE.md) for instructions. A $4-6/mo VPS is all you need.

---

## License

[MIT](LICENSE)

---

<details>
<summary><strong>For Developers</strong></summary>

### Build from Source

```bash
git clone https://github.com/Jaguwa/OpenDescent.git
cd OpenDescent
npm install
npm run build
```

### Run in Development

```bash
npm start -- --port 6001 --name "Alice" --web-port 8080
```

### Build Electron Installer

```bash
npm run dist
```

Output: `release/OpenDescent Setup X.X.X.exe`

### Run Tests

```bash
npm run build
node dist/test/integration.js    # 31 assertions
node dist/test/multi-peer.js     # 39+ assertions
```

### Tech Stack

- TypeScript (Node.js), ES2022 modules
- libp2p (TCP, WebSockets, Noise, Yamux, KadDHT, DCUtR, circuit relay v2)
- LevelDB for local storage
- Node.js built-in crypto (Ed25519, X25519, AES-256-GCM, HKDF, scrypt)
- Browser-native WebRTC for voice/video
- Plain HTML/CSS/JS frontend (no framework)
- Electron for desktop packaging

### Project Structure

```
src/
├── network/node.ts      — libp2p node, protocols, peer management
├── crypto/identity.ts   — Ed25519 keypairs, signing, verification
├── crypto/encryption.ts — E2E encryption (X25519 DH + AES-256-GCM)
├── messaging/delivery.ts — Encrypted messaging, store-and-forward
├── messaging/groups.ts  — Group chat with key rotation
├── messaging/hubs.ts    — Community hubs with channels and roles
├── content/sharing.ts   — File sharding, encryption, signed manifests
├── content/posts.ts     — Broadcast feed with gossip propagation
├── content/deaddrops.ts — Anonymous onion-routed posts
├── licensing/license.ts — Ed25519 signed license keys
├── api/server.ts        — HTTP + WebSocket bridge to browser
├── index.ts             — CLI + main wiring
frontend/
├── index.html           — App UI
├── app.js               — Frontend logic
├── style.css            — Cassette futurism theme
├── landing.html         — Website landing page
electron/
├── main.cjs             — Electron wrapper
```

</details>
