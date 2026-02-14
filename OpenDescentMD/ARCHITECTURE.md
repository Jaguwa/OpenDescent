# DecentraNet — Security Model & Next Steps

## Security Model

### Encryption Layers

| Data                | Encryption              | Who can read            |
|---------------------|-------------------------|-------------------------|
| Network connections | Noise protocol (libp2p) | Connected peers only    |
| Direct messages     | X25519 DH + AES-256-GCM| Sender + recipient only |
| Group messages      | Shared AES-256 group key| Group members only      |
| Stored shards       | Pre-encrypted by sender | Only key holders        |
| Voice/video calls   | WebRTC DTLS-SRTP        | Call participants only  |
| Identity keys       | AES-256-GCM + scrypt    | Device owner only       |

### Threat Model

**Protected against:**
- Server-side data breaches (no server exists)
- Mass surveillance (no central collection point)
- Censorship (no single point to block)
- Peer snooping (all content encrypted before sharding)

**NOT protected against (yet):**
- Traffic analysis (who's talking to whom can be inferred)
- Sybil attacks (fake peers flooding the network)
- Eclipse attacks (isolating a peer from honest peers)
- Device compromise (if your private key is stolen)

## Next Steps for Production

### Phase 1 — Harden Core (Weeks 1-4)
- [ ] Replace XOR parity with Reed-Solomon erasure coding
- [ ] Implement proper DHT content routing for shard distribution
- [ ] Add peer reputation system (track reliability scores)
- [ ] Implement proper NAT traversal testing
- [ ] Add message delivery receipts and retry logic

### Phase 2 — Media Pipeline (Weeks 5-8)
- [ ] Integrate Opus codec for voice note compression
- [ ] Add VP9/AV1 encoding for video notes
- [ ] Implement chunked streaming for large media files
- [ ] Add thumbnail generation for video content
- [ ] Test WebRTC calls across NAT types

### Phase 3 — Social Features (Weeks 9-12)
- [ ] Contact management (add/remove/block)
- [ ] Profile pages with avatar and status
- [ ] Group chat with member management
- [ ] Social feed (posts visible to contacts)
- [ ] Push-style notifications via gossip protocol

### Phase 4 — Token Incentive Layer (Weeks 13-16)
- [ ] Design token economics model
- [ ] Implement proof-of-storage challenges
- [ ] Track peer uptime and reliability
- [ ] Add token balance tracking (off-chain first)
- [ ] Integrate with L2 blockchain for settlement

### Phase 5 — Desktop & Mobile Apps (Weeks 17-20)
- [ ] Build Tauri desktop app (Rust + React frontend)
- [ ] React Native or Flutter mobile client
- [ ] Background service for always-on peer participation
- [ ] OS-level notification integration
- [ ] Key backup and recovery flow
