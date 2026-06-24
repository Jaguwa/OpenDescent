# OpenDescent v0.5.7

hello peeps,

This release makes the public broadcast feed actually work the way it should, and adds proper in-app updates so you don't have to come back to GitHub to stay current.

## Download

Download **`OpenDescent.Setup.0.5.7.exe`** below and install. (Existing users will be prompted to update from inside the app.)

---

## What's New in 0.5.7

### Public broadcast feed now syncs across the network

- Post to the public feed, and people who were offline at the time will see it when they next open the app. The feed catches up on login by syncing with the peers and relay you connect to, so you no longer only see posts from people who happened to be online at the same moment as you.
- Posts keep their original timestamps and author.
- Feed retention window extended from 35 to **90 days**.
- (Under the hood: the desktop app was never wired for feed sync. It is now.)

### In-app updates

- The app checks for updates on launch and every few hours, and prompts you when a new version is ready, so you don't have to visit GitHub to update.
- New **Settings, App Updates** panel: a toggle to turn automatic checks off, a "Check for updates now" button, and a status line.

---

## What You Get (full feature list)

- 🔒 End-to-end encrypted messaging with visible encryption animation
- 📞 Voice and video calls with noise suppression
- 📡 P2P live streaming, go live to your network *(Pro)*
- 🏰 Community hubs with text and voice channels
- 📢 Broadcast feed, now syncing across the network
- 👻 Dead Drops, anonymous posts, gone in 24 hours
- 💀 Dead Man's Switch, auto-send messages on missed check-in *(Pro)*
- 📎 File sharing up to 35MB *(500MB with Pro)*
- 🛡 Trust web, vouch for peers, build reputation
- 🌐 Self-hostable relay, run the network on your own infrastructure
- 🔑 Your identity is a cryptographic keypair, no email, no password

---

## Windows Note

This build is signed by *Open Source Developer Alan Ivanovas* via Certum.
Windows SmartScreen may still show a brief warning on first download until the signing certificate builds reputation, click **"More info"** then **"Run anyway"**.
