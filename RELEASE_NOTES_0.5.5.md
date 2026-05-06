# OpenDescent v0.5.5

hello peeps,

This release is about **payment privacy** — making sure paying for Pro doesn't link your real identity to your peer ID. Plus a few nice cosmetic perks and a small badge cleanup.

## Download

Download **`OpenDescent Setup 0.5.5.exe`** below and install.

> **First 101 users get lifetime Pro for £1** — claim your Founder's Edition from Settings after installing.

---

## What's New in 0.5.5

### Privacy

- **Stripe no longer sees your peer ID.** Checkout sessions are created without peer-ID metadata. Even if Stripe is breached or subpoenaed, the link between your payment and your OpenDescent identity isn't there for them to hand over.
- **New redemption-code flow.** After checkout you get a 16-character code on the success page; paste it into Settings → Redeem Code in the app to activate Pro. Your peer ID only travels to our license server, never Stripe.
- **Anonymous renewal mode** *(optional toggle).* Server forgets your peer ID after activation, sends a fresh redemption code by email each renewal cycle. Trades a small UX cost for maximum payment privacy.
- **Backward compat.** Existing license keys keep working via the legacy endpoint — no action required if you're already Pro.

### Cosmetic Pro perks

- **Avatar frames** — pulse, glow, rainbow, gradient
- **Vibe themes** — sunset, cyber, aurora, neon, pastel
- **Username color** — full color picker
- All in the profile editor when you're Pro. Free tier sees them disabled with an upgrade hint.

### Self-claimed Supporter Pin

- A pin (★ Supporter or ★ Early Supporter) you can wear next to your displayName if you support the project. **Honor system — no verification.** Anyone can wear any variant. Founders see "Early Supporter" as an option in the editor; the network accepts whatever you broadcast.

### Small cleanup

- Founder badge dropped from profile rendering. Was unverifiable across peers and risked linking payments to identities. Founders keep lifetime Pro — every Pro feature, forever — only the cosmetic on-profile star is gone.

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
- 🎨 Cosmetic Pro perks — avatar frames, vibe themes, username color
- ⭐ Self-claimed supporter pin
- 🔑 Your identity is a cryptographic keypair — no email, no password

---

## Coming next

- **Bitcoin Lightning payment rail** for users who want non-KYC Pro purchases. Will reuse the same redemption-code mechanism — no peer ID exposed to any payment processor.

---

## Windows Note

This build is signed by *Open Source Developer Alan Ivanovas* via Certum.
Windows SmartScreen may still show a brief warning on first download until the signing certificate builds reputation — click **"More info"** → **"Run anyway"**.
