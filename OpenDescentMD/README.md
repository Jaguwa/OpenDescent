# OpenDescent — Decentralized P2P Social Network

A fully decentralized peer-to-peer social network with encrypted messaging,
voice/video notes, and real-time calls. No central servers. Data is sharded,
encrypted, and distributed across peers in the network.

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                  Application Layer                     │
│         (UI, Social Graph, User Profiles)              │
├──────────────────────────────────────────────────────┤
│                  Media Layer                           │
│    (Voice Notes, Video Notes, WebRTC Live Calls)      │
├──────────────────────────────────────────────────────┤
│                Messaging Layer                         │
│   (Encrypted DMs, Group Chat, Store-and-Forward)      │
├──────────────────────────────────────────────────────┤
│                 Storage Layer                          │
│  (Shard Manager, Erasure Coding, Content Addressing)  │
├──────────────────────────────────────────────────────┤
│                 Crypto Layer                           │
│   (Identity/Keys, E2E Encryption, Signatures)         │
├──────────────────────────────────────────────────────┤
│                 Network Layer                          │
│  (Peer Discovery, DHT, NAT Traversal, Gossip)         │
└──────────────────────────────────────────────────────┘
```

## Tech Stack

- **Language**: TypeScript (Node.js) — for rapid prototyping
- **Networking**: libp2p (js-libp2p)
- **Storage**: LevelDB (local), content-addressed chunks
- **Crypto**: libsodium (via sodium-native)
- **Real-time**: WebRTC (via simple-peer)
- **Erasure Coding**: reed-solomon-erasure

## Project Structure

```
src/
├── network/          # P2P networking, peer discovery, DHT
│   ├── node.ts       # Core libp2p node setup
│   ├── discovery.ts  # Peer discovery mechanisms
│   ├── dht.ts        # Distributed hash table operations
│   └── relay.ts      # NAT traversal & relay logic
├── crypto/           # All cryptographic operations
│   ├── identity.ts   # Key generation & management
│   ├── encryption.ts # E2E encryption utilities
│   └── signatures.ts # Message signing & verification
├── storage/          # Distributed storage engine
│   ├── shard.ts      # File sharding & reassembly
│   ├── erasure.ts    # Erasure coding for redundancy
│   ├── store.ts      # Local storage (LevelDB)
│   └── content.ts    # Content-addressed storage (CID)
├── messaging/        # Async messaging system
│   ├── channel.ts    # Message channels (DM, group)
│   ├── envelope.ts   # Message envelope format
│   └── delivery.ts   # Store-and-forward delivery
├── media/            # Voice/video handling
│   ├── recorder.ts   # Voice & video note capture
│   ├── webrtc.ts     # Live call management
│   └── codec.ts      # Media encoding/compression
├── protocol/         # Wire protocol definitions
│   ├── messages.ts   # Protocol message types
│   └── handlers.ts   # Protocol message handlers
├── types/            # Shared TypeScript types
│   └── index.ts      # Core type definitions
└── index.ts          # Main entry point
```

## Quick Start

```bash
npm install
npm run build
npm run start -- --port 6001 --name "Alice"
# In another terminal:
npm run start -- --port 6002 --name "Bob" --bootstrap /ip4/127.0.0.1/tcp/6001
```

## Core Concepts

### Identity
Each user is identified by an Ed25519 keypair. Your public key IS your
identity — there's no username/password system. Keys are generated locally
and never leave your device.

### Data Distribution
When you post content or send a message:
1. Content is encrypted with recipient's public key(s)
2. Encrypted blob is split into N shards using erasure coding
3. Shards are distributed to K peers via the DHT
4. Only M-of-N shards needed to reconstruct (fault tolerance)

### Message Delivery
- **Online recipient**: Direct encrypted delivery via libp2p stream
- **Offline recipient**: Store-and-forward — message shards held by
  peers and delivered when recipient comes online

### Live Calls
- WebRTC peer-to-peer connection (direct when possible)
- Signaling via the libp2p overlay network (no central signaling server)
- TURN-style relay through volunteer peers when direct connection fails
