# NEXUS — Encryption Visualisation Feature Spec

> This document describes the "visible encryption" feature for NEXUS messaging. The goal: users should *see and feel* their messages being encrypted, routed through the mesh, and decrypted — turning a trust claim into a visceral experience.

---

## The Problem

Encrypted messaging apps tell you "your messages are encrypted" but it feels identical to unencrypted messaging. There's no tangible proof, no sensory feedback. Users have to trust a padlock icon. For NEXUS — a decentralised, security-first network — this is a missed opportunity. The encryption is the product's core value proposition, and it should be the most memorable part of the experience.

## The Solution

Every message and file transfer passes through a **visible cipher machine animation** before appearing in the chat. Users watch their plaintext enter an encryption device and exit as ciphertext, travel through relay nodes, and resolve at the destination. The process takes 2-4 seconds — fast enough for real conversation, slow enough to feel the security.

---

## The Cipher Machine

The centrepiece is a single-line inline widget that appears above the message text during transmission. It looks like a physical encryption device — text feeds in one side, passes through a labelled core, and exits transformed on the other side.

### Structure (left to right):

```
[ input tape ] ▶ [ ■ AES-256 ENCRYPT status ] ▶ [ output tape ]
```

- **Input tape:** A scrolling window showing the text being consumed, aligned to the right edge (new characters appear as the cursor advances). Monospace, showing the last ~20 characters that have been fed in.
- **Arrow in:** A small chevron (▶) between the tape and the core. Lights up in accent colour when the machine is active.
- **Core block:** A bordered box containing a lock icon, the algorithm label (AES-256), and a status word (READY → ENCRYPTING/DECRYPTING → DONE). The lock icon is a simple CSS-drawn padlock shape. The border is accent-coloured.
- **Arrow out:** Same as arrow in, lights up when output starts flowing.
- **Output tape:** A scrolling window showing the transformed text being produced, aligned to the left edge (new characters appear as they're generated).

### Send flow (ENCRYPT):

- Input tape shows **plaintext** (white text) feeding in from the left
- Output tape shows **ciphertext** (teal/mid-tone text) streaming out to the right
- The message body text below transforms in sync — as each character passes through the machine, it scrambles in the body. Left portion is ciphertext, right portion is still readable plaintext. The scramble frontier sweeps left to right.

### Receive flow (DECRYPT):

- Input tape shows **ciphertext** (teal/mid-tone text) feeding in from the left
- Output tape shows **plaintext** (white text) streaming out to the right
- The message body text below resolves in sync — left portion becomes readable plaintext, right portion remains as jittering ciphertext. The decrypt frontier sweeps left to right.
- The unresolved characters should not be static — they randomly re-scramble (~30% of characters per tick) so the encrypted portion looks actively noisy, creating a clear visual contrast with the stable decrypted text on the left.

### Key visual details:

- The machine appears with a fade-in/expand animation (max-height + opacity transition)
- Once the process completes, the machine fades out and collapses, leaving only the clean message bubble
- The core label changes between "ENCRYPT" and "DECRYPT" depending on direction
- The status reads "READY" → "WORKING" → "DONE"
- The processing speed should feel deliberate — not instant, not slow. Approximately 2 characters per tick at ~30-50ms intervals, meaning a 60-character message takes about 1-1.5 seconds to process through the machine

---

## The Route Strip

After encryption completes (send only), the cipher machine fades out and a **route strip** fades in. This is a single horizontal line showing the relay path:

```
ROUTE  EU-W7 — REL-4 — REL-9 — MX-2 — AS-E2
```

Each node label and connecting line lights up sequentially left to right (~180ms per hop), showing the encrypted packet bouncing through the decentralised mesh. This makes the decentralisation visible — not just encryption, but the actual relay infrastructure.

Once all nodes are lit, the route strip fades out and the message text runs a final decrypt animation (the accelerating character-resolve described below) before showing as delivered.

The route strip does not appear on incoming messages — the sender's routing is not visible to the receiver. The receiver only sees the decrypt machine.

---

## The Character Animations

### Encrypt (scramble):

Characters transform from readable to noise using a **quadratic acceleration curve** — `probability = (step² / total²)`. This means:
- First few frames: most characters still readable, just a few start to flip (unsettling)
- Middle frames: rapid cascade as more and more characters scramble
- Final frames: everything is noise

This is more visually interesting than linear scrambling because the viewer gets a moment of "I can still read it... wait, it's going..." before the rapid dissolution.

### Decrypt on delivery (final resolve):

After routing completes, the ciphertext in the message body resolves back to plaintext using the same quadratic curve but inverted — `probability = (step² / total²)` chance of each character resolving to its real value per frame. Characters that haven't resolved yet continue to randomly cycle. This creates a "crystallisation" effect where the message snaps into focus.

### Decrypt on receive (cursor sweep):

For incoming messages, the decryption is a **linear left-to-right sweep** synchronised with the cipher machine output. This is different from the quadratic resolve — it's steady and mechanical, matching the visual of text being physically processed through the machine. Characters ahead of the cursor jitter randomly. Characters behind the cursor are stable.

---

## Timing

| Phase | Duration | Notes |
|-------|----------|-------|
| Machine fade-in | ~100ms | max-height + opacity transition |
| Encrypt/decrypt processing | 1-2s | Depends on message length, ~30-50ms per 2 chars |
| Machine fade-out | ~300ms | Collapse after completion |
| Route strip fade-in | ~150ms | Immediately after machine collapses (send only) |
| Route hops | ~180ms each | 5 nodes = ~900ms total |
| Route strip fade-out | ~300ms | After final node lights |
| Final decrypt resolve | ~400ms | Quadratic acceleration, 9 steps at 45ms |
| **Total send cycle** | **~3-4s** | From TRANSMIT press to DELIVERED |
| Incoming receive indicator | ~1.5-2s | "Receiving encrypted transmission..." bar |
| Incoming decrypt processing | 1-2s | Cipher machine processes the message |
| Machine fade-out | ~500ms | Slightly slower on receive |
| **Total receive cycle** | **~3-4s** | From indicator to DECRYPTED |

These timings should be fast enough that real conversation isn't impeded but slow enough that the user consciously registers the encryption happening. If testing shows it feels slow, the encrypt/decrypt processing can be sped up — the machine visual and the route strip are the important parts, not the duration.

---

## Message States

Each message displays a status indicator in the bottom-right of the bubble:

| State | Display | Colour |
|-------|---------|--------|
| Processing | ◆ PROCESSING | Dim grey |
| Encrypting | ◆ ENCRYPTING | Dim grey |
| Routing | ◆ ROUTING | Dim grey |
| Delivered | ◆ DELIVERED | Accent teal |
| Decrypting | ◆ DECRYPTING | Mid teal |
| Decrypted | ◆ DECRYPTED | Accent teal |
| Failed | ◆ FAILED | Red |

---

## Incoming Message Flow

1. **Indicator bar** appears below the chat header: "Receiving encrypted transmission..." with animated dots. This is shown during the simulated network receive time.
2. Indicator bar disappears, message bubble appears with the cipher machine and scrambled body text.
3. Cipher machine processes: ciphertext feeds into DECRYPT core, plaintext exits. Body text resolves in sync.
4. Machine fades out. Status flips to DECRYPTED. Message is complete.

The indicator bar gives the user a moment of anticipation — they know something is coming before it arrives. This is important because without it, the message would just pop in already scrambled and the user might not understand what they're looking at.

---

## File Transfer Visualisation

Files use a **chunked block visualisation** instead of the character-level cipher machine:

### Display:
```
[PDF] ZKP_GROTH16_SPEC_v4.pdf                    2.4MB
[■■■■■■■■■■■■░░░░]  ← 16 chunk blocks
8/16 CHUNKS ENCRYPTED                     IN PROGRESS
```

- Each chunk block transitions from empty (dark grey) → encrypted (mid teal) → verified (accent teal)
- Chunks fill left to right during encryption/transfer
- The SHA hash and file metadata are displayed
- On completion, all chunks show as verified

This is simpler than the text machine but still makes the encryption visible — each chunk of the file is individually processed and verified.

---

## Interaction Notes

- The animation should **not block the user from typing their next message**. Once the send animation begins, the input field should be re-enabled after a short delay (not after the full animation completes). The animation is visual feedback, not a gate.
- Users may want to **disable or reduce the animation** in settings. Options could be: Full (machine + route + decrypt), Minimal (just the status label changing), or Off.
- In **group chats**, the send animation shows once (from sender's perspective). Other participants see individual incoming decrypt animations for each message they receive.
- The animation should **degrade gracefully on slow devices** — if frames are dropping, reduce the cipher machine to just the status label transition rather than the full tape animation.

---

## Integration with Cassette Futurism Aesthetic

The cipher machine is a natural extension of the cassette futurism design language:

- The lock icon, bordered core box, and monospace tapes feel like a physical hardware device — consistent with the "alternate-timeline 1987" direction
- The route strip with its sequential node lighting feels like a signal tracing across a circuit board
- The scrambled ciphertext uses the mid-tone teal from the palette, the same colour used for encrypted/system data throughout the UI
- The 7px micro-text labels (ENCRYPT, DECRYPT, ROUTE, DONE) match the machine-voice typography scale
- The whole animation reinforces the core brand promise: this network is encrypted, decentralised, and real — not just a claim in the settings page

---

## Success Criteria

The feature is working when:
- A new user sends their first message and immediately understands that their text was encrypted before transmission
- The animation feels like watching a real process, not a decorative effect
- Users mention the encryption visualisation when describing the app to others
- The animation doesn't feel tedious after the 100th message — it should be fast enough to become a satisfying rhythm rather than an interruption
- Users feel genuinely more confident in the app's security because they can *see* it working
