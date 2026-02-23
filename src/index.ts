/**
 * DecentraNet — Main Entry Point
 *
 * Top-level orchestrator that wires together all layers:
 * Network -> Crypto -> Storage -> Messaging -> Media
 *
 * Usage:
 *   npm run build && node dist/index.js --port 6001 --name "Alice"
 *   npm run build && node dist/index.js --port 6002 --name "Bob" --bootstrap /ip4/127.0.0.1/tcp/6001
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { DecentraNode } from './network/node.js';
import { LocalStore } from './storage/store.js';
import { MessagingService } from './messaging/delivery.js';
import { CallManager } from './media/webrtc.js';
import { GroupManager } from './messaging/groups.js';
import { ContentManager, type SharedFileInfo } from './content/sharing.js';
import { PostService } from './content/posts.js';
import { TrustWebService } from './trust/web.js';
import { DeadDropService } from './content/deaddrops.js';
import { PollService } from './content/polls.js';
import { HubManager } from './messaging/hubs.js';
import { HubStatsService } from './messaging/hub-stats.js';
import { DeadManSwitchService } from './deadswitch/deadswitch.js';
import { APIServer } from './api/server.js';
import { OnionTransport } from './network/onion-transport.js';
import type { NodeConfig, Message, PeerProfile, ContentType } from './types/index.js';

// ─── Parse CLI Arguments ─────────────────────────────────────────────────────

interface ParsedArgs extends Partial<NodeConfig> {
  help?: boolean;
  passphrase?: string;
  webPort?: number;
  connect?: string;
  onionRouting?: boolean;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const config: any = { bootstrapPeers: [] };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
      case '-p':
        config.port = parseInt(args[++i]);
        break;
      case '--name':
      case '-n':
        config.displayName = args[++i];
        break;
      case '--bootstrap':
      case '-b':
        config.bootstrapPeers.push(args[++i]);
        break;
      case '--data':
      case '-d':
        config.dataDir = args[++i];
        break;
      case '--passphrase':
        config.passphrase = args[++i];
        break;
      case '--web-port':
      case '-w':
        config.webPort = parseInt(args[++i]);
        break;
      case '--ws-port':
        config.wsPort = parseInt(args[++i]);
        break;
      case '--public':
        config.isPublic = true;
        break;
      case '--announce-ip':
        config.announceIp = args[++i];
        break;
      case '--no-mdns':
        config.disableMdns = true;
        break;
      case '--onion-routing':
        config.onionRouting = true;
        break;
      case '--connect':
      case '-c':
        config.connect = args[++i];
        break;
      case '--help':
      case '-h':
        config.help = true;
        break;
    }
  }

  return config;
}

// ─── Interactive CLI ─────────────────────────────────────────────────────────

class DecentraNetCLI {
  private node: DecentraNode;
  private store: LocalStore;
  private messaging: MessagingService;
  private calls: CallManager;
  private groups: GroupManager;
  private content: ContentManager;
  private receivedFiles: Map<string, SharedFileInfo> = new Map();
  private rl: readline.Interface;

  constructor(
    node: DecentraNode,
    store: LocalStore,
    messaging: MessagingService,
    calls: CallManager,
    groups: GroupManager,
    content: ContentManager,
  ) {
    this.node = node;
    this.store = store;
    this.messaging = messaging;
    this.calls = calls;
    this.groups = groups;
    this.content = content;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async start(): Promise<void> {
    this.messaging.onMessage((message: Message) => {
      const senderProfile = this.node.getKnownPeer(message.from);
      const senderName = senderProfile?.displayName || message.from.slice(0, 12);

      // Check if this is a file share message
      if (message.type === ('file' as ContentType)) {
        try {
          const fileInfo: SharedFileInfo = JSON.parse(message.body);
          this.receivedFiles.set(fileInfo.contentId, fileInfo);
          console.log(`\n  [${senderName}] shared file: "${fileInfo.fileName}" (${formatBytes(fileInfo.fileSize)})`);
          console.log(`    Download with: download ${fileInfo.contentId.slice(0, 12)}`);
        } catch {
          console.log(`\n  [${senderName}] ${message.body}`);
        }
      } else {
        console.log(`\n  [${senderName}] ${message.body}`);
      }
      this.prompt();
    });

    this.groups.onGroupMessage((groupId, groupName, message) => {
      const senderProfile = this.node.getKnownPeer(message.from);
      const senderName = senderProfile?.displayName || message.from.slice(0, 12);
      console.log(`\n  [${groupName}] ${senderName}: ${message.body}`);
      this.prompt();
    });

    this.calls.setHandlers({
      onIncomingCall: (call) => {
        const profile = this.node.getKnownPeer(call.remotePeerId);
        const name = profile?.displayName || call.remotePeerId.slice(0, 12);
        console.log(`\n  Incoming ${call.type} call from ${name}`);
        console.log(`  Type 'accept ${call.callId}' to answer`);
        this.prompt();
      },
      onCallConnected: (call) => {
        console.log(`\n  Call connected!`);
        this.prompt();
      },
      onCallEnded: (callId, reason) => {
        console.log(`\n  Call ended: ${reason}`);
        this.prompt();
      },
    });

    // Listen for new peer profile exchanges
    this.node.on('peer:connected', (event) => {
      if (event.data && typeof event.data === 'object' && 'displayName' in (event.data as any)) {
        const profile = event.data as PeerProfile;
        const name = profile.displayName || profile.peerId.slice(0, 12);
        console.log(`\n  >> ${name} is online (${profile.peerId})`);
        this.prompt();
      }
    });

    this.node.on('peer:disconnected', (event) => {
      if (event.peerId) {
        const profile = this.node.getKnownPeer(event.peerId);
        const name = profile?.displayName || event.peerId.slice(0, 12);
        console.log(`\n  << ${name} went offline`);
        this.prompt();
      }
    });

    this.printBanner();
    this.prompt();

    this.rl.on('line', async (line) => {
      await this.handleCommand(line.trim());
      this.prompt();
    });
  }

  private prompt(): void {
    const name = this.node.getIdentity().displayName || 'anon';
    this.rl.setPrompt(`[${name}] > `);
    this.rl.prompt();
  }

  private async handleCommand(input: string): Promise<void> {
    const [command, ...args] = input.split(' ');

    switch (command) {
      case 'help':
        this.printHelp();
        break;

      case 'id':
      case 'whoami': {
        const identity = this.node.getIdentity();
        console.log(`  DecentraNet ID:  ${this.node.getPeerId()}`);
        console.log(`  libp2p ID:       ${this.node.getLibp2pPeerId()}`);
        console.log(`  Name:            ${identity.displayName || '(none)'}`);
        const addrs = this.node.getAddresses();
        if (addrs.length > 0) {
          console.log(`  Addresses:`);
          addrs.forEach((a) => console.log(`    ${a}`));
        }
        break;
      }

      case 'peers': {
        const peers = this.node.getConnectedPeers();
        if (peers.length === 0) {
          console.log('  No connected peers');
        } else {
          console.log(`  Connected peers (${peers.length}):`);
          peers.forEach((p) => {
            const name = p.profile?.displayName || '(unknown)';
            const did = p.decentraId || '(exchanging...)';
            console.log(`    ${name.padEnd(15)} ${did}`);
          });
        }
        break;
      }

      case 'contacts': {
        const profiles = this.node.getAllKnownPeers();
        const myId = this.node.getPeerId();
        const others = profiles.filter((p) => p.peerId !== myId);
        if (others.length === 0) {
          console.log('  No known contacts. Connect to a peer to exchange profiles.');
        } else {
          const connectedIds = new Set(
            this.node.getConnectedPeers()
              .filter((p) => p.decentraId)
              .map((p) => p.decentraId)
          );
          console.log(`  Contacts (${others.length}):`);
          others.forEach((p) => {
            const online = connectedIds.has(p.peerId) ? ' [online]' : '';
            console.log(`    ${(p.displayName || '(anon)').padEnd(15)} ${p.peerId}${online}`);
          });
        }
        break;
      }

      case 'msg':
      case 'send': {
        const target = args[0];
        const text = args.slice(1).join(' ');
        if (!target || !text) {
          console.log('  Usage: msg <name-or-id> <message>');
          break;
        }
        const recipientId = this.resolveRecipient(target);
        if (!recipientId) {
          console.log(`  Unknown recipient: ${target}`);
          console.log('  Use "contacts" to see known peers, or "peers" for connected ones.');
          break;
        }
        try {
          await this.messaging.sendTextMessage(recipientId, text);
          const profile = this.node.getKnownPeer(recipientId);
          const name = profile?.displayName || recipientId.slice(0, 12);
          console.log(`  -> ${name}: ${text}`);
        } catch (error: any) {
          console.error(`  Failed: ${error.message}`);
        }
        break;
      }

      case 'history': {
        const target = args[0];
        const limit = parseInt(args[1]) || 20;
        if (!target) {
          // Show all conversations
          const convos = await this.store.getConversations();
          if (convos.length === 0) {
            console.log('  No conversations yet.');
          } else {
            console.log('  Conversations:');
            for (const c of convos) {
              const otherId = c.lastMessage.from === this.node.getPeerId()
                ? c.lastMessage.to : c.lastMessage.from;
              const profile = this.node.getKnownPeer(otherId);
              const name = profile?.displayName || otherId.slice(0, 12);
              const time = new Date(c.lastMessage.timestamp).toLocaleTimeString();
              const preview = c.lastMessage.body.slice(0, 40);
              console.log(`    ${name.padEnd(15)} ${time}  ${preview}`);
            }
          }
          break;
        }

        const recipientId = this.resolveRecipient(target);
        if (!recipientId) {
          console.log(`  Unknown recipient: ${target}`);
          break;
        }

        const myId = this.node.getPeerId();
        const convoId = [myId, recipientId].sort().join(':');
        const messages = await this.store.getConversationHistory(convoId, limit);

        if (messages.length === 0) {
          console.log('  No messages in this conversation.');
        } else {
          const profile = this.node.getKnownPeer(recipientId);
          const theirName = profile?.displayName || recipientId.slice(0, 12);
          const myName = this.node.getIdentity().displayName || 'me';
          console.log(`  --- Conversation with ${theirName} ---`);
          for (const m of messages) {
            const sender = m.from === myId ? myName : theirName;
            const time = new Date(m.timestamp).toLocaleTimeString();
            const status = m.from === myId ? ` [${m.status}]` : '';
            console.log(`  [${time}] ${sender}: ${m.body}${status}`);
          }
        }
        break;
      }

      case 'gcreate':
      case 'groupcreate': {
        const name = args[0];
        const memberNames = args.slice(1);
        if (!name || memberNames.length === 0) {
          console.log('  Usage: gcreate <group-name> <member1> [member2] ...');
          console.log('  Members can be names or peer IDs.');
          break;
        }
        const memberIds: string[] = [];
        for (const m of memberNames) {
          const resolved = this.resolveRecipient(m);
          if (!resolved) {
            console.log(`  Unknown member: ${m}`);
            break;
          }
          memberIds.push(resolved);
        }
        if (memberIds.length !== memberNames.length) break;
        try {
          const groupId = await this.groups.createGroup(name, memberIds);
          console.log(`  Group "${name}" created (${groupId.slice(0, 8)}...)`);
          console.log(`  Members: you + ${memberNames.join(', ')}`);
        } catch (error: any) {
          console.error(`  Failed: ${error.message}`);
        }
        break;
      }

      case 'gmsg':
      case 'groupmsg': {
        const target = args[0];
        const text = args.slice(1).join(' ');
        if (!target || !text) {
          console.log('  Usage: gmsg <group-name-or-id> <message>');
          break;
        }
        const group = this.groups.findGroup(target);
        if (!group) {
          console.log(`  Unknown group: ${target}`);
          console.log('  Use "groups" to list your groups.');
          break;
        }
        try {
          await this.groups.sendGroupMessage(group.groupId, text);
          console.log(`  -> [${group.name}] ${text}`);
        } catch (error: any) {
          console.error(`  Failed: ${error.message}`);
        }
        break;
      }

      case 'groups': {
        const allGroups = this.groups.getGroups();
        if (allGroups.length === 0) {
          console.log('  No groups. Create one with: gcreate <name> <member1> ...');
        } else {
          console.log(`  Groups (${allGroups.length}):`);
          for (const g of allGroups) {
            const memberCount = g.members.length;
            const lastMsg = new Date(g.lastMessageAt).toLocaleTimeString();
            console.log(`    ${g.name.padEnd(20)} ${memberCount} members  last: ${lastMsg}  (${g.groupId.slice(0, 8)}...)`);
          }
        }
        break;
      }

      case 'ghistory': {
        const target = args[0];
        const limit = parseInt(args[1]) || 20;
        if (!target) {
          console.log('  Usage: ghistory <group-name-or-id> [limit]');
          break;
        }
        const group = this.groups.findGroup(target);
        if (!group) {
          console.log(`  Unknown group: ${target}`);
          break;
        }
        const convoId = `group:${group.groupId}`;
        const messages = await this.store.getConversationHistory(convoId, limit);
        if (messages.length === 0) {
          console.log(`  No messages in "${group.name}" yet.`);
        } else {
          console.log(`  --- ${group.name} ---`);
          for (const m of messages) {
            const senderProfile = this.node.getKnownPeer(m.from);
            const sender = m.from === this.node.getPeerId()
              ? (this.node.getIdentity().displayName || 'me')
              : (senderProfile?.displayName || m.from.slice(0, 12));
            const time = new Date(m.timestamp).toLocaleTimeString();
            console.log(`  [${time}] ${sender}: ${m.body}`);
          }
        }
        break;
      }

      case 'share': {
        const target = args[0];
        const filePath = args.slice(1).join(' ');
        if (!target || !filePath) {
          console.log('  Usage: share <name|id> <file-path>');
          break;
        }
        const recipientId = this.resolveRecipient(target);
        if (!recipientId) {
          console.log(`  Unknown recipient: ${target}`);
          break;
        }
        try {
          const fileInfo = await this.content.shareFile(filePath);
          // Send the file metadata as a 'file' type message
          await this.messaging.sendMediaMessage(
            recipientId,
            'file' as ContentType,
            fileInfo.contentId,
            JSON.stringify(fileInfo),
          );
          const profile = this.node.getKnownPeer(recipientId);
          const name = profile?.displayName || recipientId.slice(0, 12);
          console.log(`  Shared "${fileInfo.fileName}" with ${name}`);
        } catch (error: any) {
          console.error(`  Failed: ${error.message}`);
        }
        break;
      }

      case 'download': {
        const contentIdPrefix = args[0];
        const outputDir = args[1] || path.join(this.node.getIdentity().displayName ? `./downloads` : './downloads');
        if (!contentIdPrefix) {
          console.log('  Usage: download <content-id> [output-dir]');
          break;
        }
        // Find the file info by prefix match
        let fileInfo: SharedFileInfo | undefined;
        for (const [cid, info] of this.receivedFiles) {
          if (cid.startsWith(contentIdPrefix) || cid.includes(contentIdPrefix)) {
            fileInfo = info;
            break;
          }
        }
        if (!fileInfo) {
          console.log(`  No received file matching "${contentIdPrefix}"`);
          console.log('  Use "files" to see available files.');
          break;
        }
        try {
          const outputPath = await this.content.downloadFile(fileInfo, outputDir);
          console.log(`  Downloaded to: ${outputPath}`);
        } catch (error: any) {
          console.error(`  Failed: ${error.message}`);
        }
        break;
      }

      case 'files': {
        if (this.receivedFiles.size === 0) {
          console.log('  No received files. Someone can share with: share <your-name> <file>');
        } else {
          console.log(`  Received files (${this.receivedFiles.size}):`);
          for (const [cid, info] of this.receivedFiles) {
            console.log(`    ${info.fileName.padEnd(25)} ${formatBytes(info.fileSize).padEnd(10)} ${cid.slice(0, 12)}...`);
          }
        }
        break;
      }

      case 'call': {
        const target = args[0];
        const callType = (args[1] || 'voice') as any;
        if (!target) {
          console.log('  Usage: call <name-or-id> [voice|video]');
          break;
        }
        const recipientId = this.resolveRecipient(target);
        if (!recipientId) {
          console.log(`  Unknown recipient: ${target}`);
          break;
        }
        try {
          const callId = await this.calls.startCall(recipientId, callType);
          console.log(`  Calling... (${callId})`);
        } catch (error: any) {
          console.error(`  Failed: ${error.message}`);
        }
        break;
      }

      case 'accept': {
        const callId = args[0];
        if (!callId) {
          console.log('  Usage: accept <call-id>');
          break;
        }
        try {
          await this.calls.acceptCall(callId);
        } catch (error: any) {
          console.error(`  Failed: ${error.message}`);
        }
        break;
      }

      case 'hangup': {
        const callId = args[0];
        if (!callId) {
          const active = this.calls.getActiveCalls();
          if (active.length === 1) {
            await this.calls.endCall(active[0].callId);
          } else {
            console.log('  Usage: hangup <call-id>');
          }
          break;
        }
        await this.calls.endCall(callId);
        break;
      }

      case 'invite': {
        const code = this.node.getInviteCode();
        console.log(`  Your invite code:\n`);
        console.log(`  ${code}\n`);
        console.log(`  Share this with another peer. They can connect with:`);
        console.log(`    connect ${code.slice(0, 20)}...`);
        break;
      }

      case 'connect': {
        const code = args.join('');
        if (!code) {
          console.log('  Usage: connect <invite-code>');
          break;
        }
        try {
          const result = await this.node.connectWithInvite(code);
          console.log(`  Connected to ${result.name || result.peerId}!`);
          console.log(`  Profile exchange will happen automatically.`);
        } catch (error: any) {
          console.error(`  Failed: ${error.message}`);
        }
        break;
      }

      case 'storage': {
        const usage = this.store.getStorageUsage();
        console.log(`  Storage: ${formatBytes(usage.used)} / ${formatBytes(usage.max)} (${usage.percentage.toFixed(1)}%)`);
        break;
      }

      case 'quit':
      case 'exit':
        console.log('Shutting down...');
        await this.node.stop();
        await this.store.close();
        process.exit(0);

      case '':
        break;

      default:
        console.log(`  Unknown command: ${command}. Type 'help' for commands.`);
    }
  }

  /**
   * Resolve a user input (name or peer ID) to a DecentraNet PeerId.
   */
  private resolveRecipient(input: string): string | null {
    // Try exact DecentraNet PeerId match
    if (this.node.getKnownPeer(input)) return input;

    // Try name match
    const byName = this.node.findPeerByName(input);
    if (byName) return byName.peerId;

    // Try partial ID match
    for (const peer of this.node.getAllKnownPeers()) {
      if (peer.peerId.startsWith(input)) return peer.peerId;
    }

    return null;
  }

  setWebPort(port: number): void {
    this.webPort = port;
  }

  private webPort: number = 3000;

  private printBanner(): void {
    const addrs = this.node.getAddresses();
    const connectAddr = addrs.find((a) => !a.includes('127.0.0.1')) || addrs[0] || '';
    const inviteCode = this.node.getInviteCode();

    console.log(`
 ____                      _            _   _      _
|  _ \\  ___  ___ ___ _ __ | |_ _ __ __ | \\ | | ___| |_
| | | |/ _ \\/ __/ _ \\ '_ \\| __| '__/ _\` |  \\| |/ _ \\ __|
| |_| |  __/ (_|  __/ | | | |_| | | (_| | |\\  |  __/ |_
|____/ \\___|\\___\\___|_| |_|\\__|_|  \\__,_|_| \\_|\\___|\\__|
                                              v0.5.3

  Web UI:  http://localhost:${this.webPort}

  Bootstrap (LAN):
    node dist/index.js --port <PORT> --name "<NAME>" -b ${connectAddr}

  Invite code (share with peers):
    ${inviteCode}

  Type 'help' for commands.
    `);
  }

  private printHelp(): void {
    console.log(`
  Commands:
    id / whoami              Show your peer ID and addresses
    peers                    List connected peers
    contacts                 List known contacts with online status
    msg <name|id> <text>     Send a message (by name or peer ID)
    history [name|id] [n]    View conversations or chat history

    gcreate <name> <members> Create a group chat
    gmsg <group> <text>      Send a message to a group
    groups                   List your groups
    ghistory <group> [n]     View group chat history

    invite                   Show your invite code (share with others)
    connect <code>           Connect to a peer using their invite code

    share <name|id> <file>   Share a file with a peer
    download <content-id>    Download a received file
    files                    List received files

    call <name|id> [v/a]     Start a voice/video call
    accept <callid>          Accept an incoming call
    hangup [callid]          End a call
    storage                  Show storage usage
    help                     Show this help
    quit                     Shutdown and exit
    `);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    console.log(`
Usage: decentra-net [options]

Options:
  --port, -p <number>      TCP port to listen on (default: 6001)
  --ws-port <number>        WebSocket port (default: TCP port + 1)
  --web-port, -w <number>  Web UI port (default: 3000)
  --name, -n <string>      Display name for this node
  --bootstrap, -b <addr>   Bootstrap peer multiaddr (can repeat)
  --data, -d <path>        Data directory (default: ./data-<port>)
  --passphrase <string>    Passphrase for identity encryption
  --public                  Run as public node (DHT server + relay)
  --no-mdns                Disable mDNS discovery (hides node from LAN)
  --onion-routing          Enable onion-routed transport (3-hop circuits)
  --connect, -c <code>     Connect to peer using invite code on startup
  --help, -h               Show this help
    `);
    process.exit(0);
  }

  const port = args.port || 6001;
  const dataDir = args.dataDir || `./data-${port}`;

  // Resolve passphrase: explicit > device-key > legacy default (for existing identities)
  let passphrase: string;
  const identityFile = path.join(dataDir, 'identity.json');
  const deviceKeyFile = path.join(dataDir, '.device-key');
  if (args.passphrase) {
    passphrase = args.passphrase;
  } else if (fs.existsSync(deviceKeyFile)) {
    passphrase = fs.readFileSync(deviceKeyFile, 'utf8').trim();
  } else if (fs.existsSync(identityFile)) {
    // Existing identity without device key → auto-migrate to random device key
    const legacyPassphrase = 'decentranet-dev-passphrase';
    try {
      const { loadIdentity: loadId, saveIdentity: saveId } = await import('./crypto/identity.js');
      const identity = loadId(identityFile, legacyPassphrase);
      const newKey = crypto.randomBytes(32).toString('hex');
      saveId(identity, identityFile, newKey);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(deviceKeyFile, newKey);
      passphrase = newKey;
      console.log('[Security] Migrated legacy passphrase to device-specific key.');
    } catch {
      // Migration failed — fall back to legacy passphrase
      passphrase = legacyPassphrase;
      console.warn('[Security] Legacy passphrase migration failed. Using legacy default.');
    }
  } else {
    // Fresh install → generate random device-specific key
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    passphrase = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(deviceKeyFile, passphrase);
    console.log('[Security] Generated device-specific encryption key.');
  }

  const config: NodeConfig = {
    port,
    wsPort: args.wsPort,
    isPublic: args.isPublic || false,
    announceIp: args.announceIp,
    displayName: args.displayName || `Peer-${Math.floor(Math.random() * 10000)}`,
    bootstrapPeers: args.bootstrapPeers || [],
    dataDir,
    identityPath: path.join(dataDir, 'identity.json'),
    maxStorageBytes: 512 * 1024 * 1024,
    maxShards: 10000,
    enableRelay: true,
    messageRetentionSeconds: 7 * 24 * 60 * 60,
    disableMdns: args.disableMdns || false,
  };

  console.log('Starting DecentraNet node...\n');

  const node = new DecentraNode(config, passphrase);
  const store = new LocalStore(config.dataDir, config.maxStorageBytes);

  await store.open();
  await node.start();

  // Restore known peers from storage into the node's memory
  const savedProfiles = await store.getAllPeerProfiles();
  for (const profile of savedProfiles) {
    const libp2pId = await store.getLibp2pId(profile.peerId);
    node.registerKnownPeer(profile, libp2pId || undefined);
  }

  // Store our own profile
  const profile = node.getProfile();
  await store.storePeerProfile(profile);

  // Start DHT directory publishing if discoverable (default: true)
  const discoverable = await store.getMeta('discoverable');
  if (discoverable !== 'false') {
    node.startDirectoryPublishing();
  }

  const messaging = new MessagingService(node, store);
  const calls = new CallManager(node);
  const groups = new GroupManager(node, store);
  const content = new ContentManager(node, store);
  const posts = new PostService(node, store);
  const trustWeb = new TrustWebService(node, store);
  const deadDrops = new DeadDropService(node, store);
  const polls = new PollService(node, store);
  const hubs = new HubManager(node, store);

  const dmsService = new DeadManSwitchService(store, messaging);

  // Start onion transport if enabled
  let onionTransport: OnionTransport | null = null;
  if (args.onionRouting) {
    onionTransport = new OnionTransport(node);
    await onionTransport.start();
  }

  // Wire poll handlers
  node.setPollBroadcastHandler(async (data) => {
    await polls.handleIncomingBroadcast(data);
  });
  node.setPollVoteHandler(async (data) => {
    await polls.handleIncomingVote(data);
  });

  // Wire dead drop handlers
  node.setDeadDropBroadcastHandler(async (data) => {
    await deadDrops.handleIncomingBroadcast(data);
  });
  node.setDeadDropRelayHandler(async (data) => {
    await deadDrops.handleRelayMessage(data);
  });

  // Wire vouch broadcast handler (Trust Web)
  node.setVouchBroadcastHandler(async (data) => {
    await trustWeb.handleIncomingVouch(data);
  });

  // Wire hub handlers
  node.setHubSyncHandler(async (data) => {
    return await hubs.handleHubSyncMessage(data);
  });
  node.setHubDiscoveryHandler(async (data) => {
    return await hubs.handleDiscoveryMessage(data);
  });
  await hubs.loadHubs();

  // Start hub stats computation
  const hubStats = new HubStatsService(store, hubs);
  hubStats.start();

  // Wire delete notification handler (re-registered after apiServer init to broadcast UI events)
  let deleteNotifyBroadcast: ((event: string, data: Record<string, unknown>) => void) | null = null;
  node.setDeleteNotifyHandler(async (data) => {
    try {
      const notification = JSON.parse(data);
      if (notification.type === 'delete_message' && notification.conversationId && notification.msgTimestamp && notification.targetId) {
        await store.deleteHistoryMessage(notification.conversationId, notification.msgTimestamp, notification.targetId);
        console.log(`[Delete] Remote deletion: message ${notification.targetId} from ${notification.from}`);
        deleteNotifyBroadcast?.('message_deleted', {
          conversationId: notification.conversationId,
          messageId: notification.targetId,
          from: notification.from,
        });
      }
    } catch (e) {
      console.warn(`[Delete] Failed to process notification:`, e);
    }
  });

  // Wire group message handler into the messaging layer
  messaging.setGroupMessageHandler(groups.handleGroupControlMessage.bind(groups));
  await groups.loadGroups();

  // Wire profile update handler (Phase 2)
  node.setProfileUpdateHandler(async (peerId, data) => {
    try {
      const profile = JSON.parse(data);
      // Verify the profile update came from the claimed peer
      if (profile.peerId !== peerId) {
        console.warn(`[Profile] Rejected update: claimed peerId ${profile.peerId} != sender ${peerId}`);
        return;
      }
      // Verify signature if present
      if (profile.signature) {
        const senderProfile = node.getKnownPeer(peerId);
        if (senderProfile) {
          const { verify: verifyProfile } = await import('./crypto/identity.js');
          const sigData = new TextEncoder().encode(JSON.stringify({
            peerId: profile.peerId,
            cards: profile.cards,
            cardData: profile.cardData,
            version: profile.version,
            updatedAt: profile.updatedAt,
          }));
          const sigBytes = new Uint8Array(Buffer.from(profile.signature, 'base64'));
          if (!verifyProfile(sigData, sigBytes, senderProfile.publicKey)) {
            console.warn(`[Profile] Rejected update: invalid signature from ${peerId}`);
            return;
          }
        }
      }
      await store.storeUserProfile(profile);
    } catch {}
  });

  // Wire peer search handler (Phase 3)
  node.setPeerSearchHandler(async (queryStr, requesterId) => {
    try {
      const parsed = JSON.parse(queryStr);

      // Handle GIF API key requests — only share with TOFU-verified peers
      if (parsed.action === 'get_gif_key') {
        if (requesterId) {
          const pinned = await store.getPinnedKey(requesterId);
          if (!pinned) {
            return JSON.stringify({ gifApiKey: '' });
          }
        }
        const key = process.env.KLIPY_API_KEY || await store.getMeta('gif_api_key') || '';
        return JSON.stringify({ gifApiKey: key });
      }

      const { searchTerm, maxResults } = parsed;
      const term = (searchTerm || '').toLowerCase();
      const discoverable = await store.getMeta('discoverable');
      if (discoverable === 'false') return '[]';

      const allPeers = node.getAllKnownPeers();
      const myId = node.getPeerId();
      const connectedIds = new Set(node.getConnectedPeers().filter(p => p.decentraId).map(p => p.decentraId));

      const results = allPeers
        .filter(p => p.peerId !== myId)
        .filter(p => !term || (p.displayName || '').toLowerCase().includes(term) || p.peerId.includes(term))
        .slice(0, maxResults || 20)
        .map(p => ({
          peerId: p.peerId,
          displayName: p.displayName || p.peerId.slice(0, 12),
          isOnline: connectedIds.has(p.peerId),
          hopDistance: 1,
        }));
      return JSON.stringify(results);
    } catch {
      return '[]';
    }
  });

  // Wire friend request handler (Phase 3)
  node.setFriendRequestHandler(async (data) => {
    try {
      const msg = JSON.parse(data);

      // Silently reject friend requests from blocked peers
      if (msg.from && await store.isBlocked(msg.from)) {
        return 'BLOCKED';
      }

      if (msg.type === 'response') {
        // Response to our outbound request
        const req = await store.getFriendRequest(msg.requestId);
        if (req) {
          req.status = msg.accepted ? 'accepted' : 'rejected';
          await store.storeFriendRequest(req);
          if (msg.accepted) await store.addFriend(req.to);
        }
        return 'OK';
      }
      // Incoming friend request — verify signature if present
      if (msg.signature && msg.from) {
        const senderProfile = node.getKnownPeer(msg.from);
        if (senderProfile) {
          const { verify: verifyFR } = await import('./crypto/identity.js');
          const sigData = new TextEncoder().encode(JSON.stringify({
            requestId: msg.requestId,
            from: msg.from,
            to: msg.to,
            fromName: msg.fromName,
            message: msg.message || '',
            timestamp: msg.timestamp,
          }));
          const sigBytes = new Uint8Array(Buffer.from(msg.signature, 'base64'));
          if (!verifyFR(sigData, sigBytes, senderProfile.publicKey)) {
            console.warn(`[FriendReq] Rejected: invalid signature from ${msg.from}`);
            return 'INVALID_SIGNATURE';
          }
        }
      }
      await store.storeFriendRequest(msg);
      return 'RECEIVED';
    } catch {
      return 'ERROR';
    }
  });

  // Wire account bundle handlers: store/retrieve bundles for other peers
  node.setBundleHandlers(
    async (peerId: string, data: string) => {
      await store.storeBundle(peerId, data);
    },
    async (peerId: string) => {
      return store.getBundle(peerId);
    },
  );

  // Wire history sync: respond to recovery requests from contacts
  node.setHistorySyncHandler(async (requesterId: string, since: number) => {
    const myId = node.getPeerId();
    const convoId = [myId, requesterId].sort().join(':');
    const messages = await store.getConversationHistory(convoId, 1000);
    const filtered = messages.filter(m => m.timestamp > since);
    if (filtered.length === 0) return null;
    return new TextEncoder().encode(JSON.stringify(filtered));
  });

  // Wire TOFU (Trust On First Use) — pin public keys on first encounter
  node.setTofuHandler(async (peerId: string, publicKey: Uint8Array) => {
    const pubKeyHash = crypto.createHash('sha256').update(publicKey).digest('hex');
    const existing = await store.getPinnedKey(peerId);

    if (!existing) {
      // First time seeing this peer — pin their key
      await store.storePinnedKey({
        peerId,
        publicKeyHash: pubKeyHash,
        firstSeen: Date.now(),
        lastVerified: Date.now(),
      });
      return true; // trusted (first-seen)
    }

    if (existing.publicKeyHash === pubKeyHash) {
      // Key matches the pin — update verification timestamp
      await store.updatePinnedKeyVerified(peerId);
      return true;
    }

    // KEY CHANGED — do not auto-accept
    console.warn(`[TOFU] Key change detected for ${peerId}!`);
    console.warn(`  Pinned:   ${existing.publicKeyHash.slice(0, 16)}...`);
    console.warn(`  Received: ${pubKeyHash.slice(0, 16)}...`);
    return false;
  });

  // Wire shard retrieval: when a peer requests a shard, look it up in our store
  node.setShardRetrieveHandler(async (shardId: string) => {
    const shard = await store.getShard(shardId);
    if (!shard) return null;
    const payload = JSON.stringify({
      shardId: shard.shardId,
      contentId: shard.contentId,
      index: shard.index,
      totalShards: shard.totalShards,
      requiredShards: shard.requiredShards,
      data: Buffer.from(shard.data).toString('base64'),
      size: shard.size,
    });
    return new TextEncoder().encode(payload);
  });

  // When profiles are exchanged, persist the mapping
  node.on('peer:connected', async (event) => {
    if (event.data && typeof event.data === 'object' && 'peerId' in (event.data as any)) {
      const peerProfile = event.data as PeerProfile;
      await store.storePeerProfile(peerProfile);
      const connectedPeers = node.getConnectedPeers();
      const match = connectedPeers.find((p) => p.decentraId === peerProfile.peerId);
      if (match) {
        await store.storePeerIdMapping(match.libp2pId, peerProfile.peerId);
      }
    }
  });

  // Start the Web UI server
  const webPort = args.webPort || 3000;
  const apiServer = new APIServer(webPort, {
    node,
    store,
    messaging,
    groups,
    content,
    posts,
    trustWeb,
    deadDrops,
    polls,
    hubs,
    hubStats,
    dms: dmsService,
  });

  // Connect delete-notification handler to the UI broadcast
  deleteNotifyBroadcast = (event, data) => apiServer.broadcastEvent(event, data);

  // Dead Man's Switch: auto check-in on startup + 1-minute trigger check
  dmsService.checkIn().catch(() => {});
  const dmsTimer = setInterval(async () => {
    try {
      const triggered = await dmsService.checkAndTrigger();
      if (triggered.length > 0) {
        console.log(`[DMS] Triggered ${triggered.length} switches: ${triggered.join(', ')}`);
      }
    } catch {}
  }, 60 * 1000);

  // Periodic cleanup of expired dead drops (every 30 minutes)
  const dropCleanupTimer = setInterval(async () => {
    const cleaned = await store.cleanExpiredDrops();
    if (cleaned > 0) console.log(`[DeadDrops] Cleaned ${cleaned} expired drops`);
  }, 30 * 60 * 1000);

  // Periodic cleanup of expired polls (every 15 minutes)
  const pollCleanupTimer = setInterval(async () => {
    const closed = await store.closeExpiredPolls();
    if (closed > 0) console.log(`[Polls] Closed ${closed} expired polls`);
  }, 15 * 60 * 1000);

  // Periodic cleanup of expired pending messages (hourly)
  const messageCleanupTimer = setInterval(() => store.cleanExpiredMessages(config.messageRetentionSeconds), 60 * 60 * 1000);

  // Periodic account bundle auto-save and distribution (every 5 minutes)
  // Bundles are encrypted before distribution so storing peers can't read contacts/groups
  const { sign: signData } = await import('./crypto/identity.js');
  const bundleDistTimer = setInterval(async () => {
    try {
      const bundle = await store.buildAccountBundle(node.getPeerId(), (data) => signData(data, node.getIdentity().privateKey));
      const serialized = JSON.stringify({
        ...bundle,
        signature: Buffer.from(bundle.signature).toString('base64'),
      });

      // Encrypt the bundle with a key derived from our private key
      // Only someone with the same private key (i.e., mnemonic recovery) can decrypt
      const bundleKey = crypto.createHash('sha256').update(node.getIdentity().privateKey).digest();
      const bundleIv = crypto.randomBytes(16);
      const bundleCipher = crypto.createCipheriv('aes-256-gcm', bundleKey, bundleIv);
      let encrypted = bundleCipher.update(serialized, 'utf8', 'base64');
      encrypted += bundleCipher.final('base64');
      const bundleAuthTag = bundleCipher.getAuthTag();
      const encryptedBundle = JSON.stringify({
        v: 1,
        iv: bundleIv.toString('base64'),
        authTag: bundleAuthTag.toString('base64'),
        data: encrypted,
      });

      // Distribute to connected peers
      const { PROTOCOLS: P } = await import('./network/node.js');
      const request = new TextEncoder().encode(JSON.stringify({
        action: 'store',
        peerId: node.getPeerId(),
        data: encryptedBundle,
      }));
      for (const peer of node.getConnectedPeers()) {
        if (peer.decentraId) {
          node.sendToPeer(peer.decentraId, P.ACCOUNT_BUNDLE, request).catch(() => {});
        }
      }
    } catch {}
  }, 5 * 60 * 1000);

  // Connect to a peer via invite code if provided on CLI
  if (args.connect) {
    try {
      const result = await node.connectWithInvite(args.connect);
      console.log(`[Startup] Connected to ${result.name || result.peerId} via invite code`);
    } catch (error: any) {
      console.error(`[Startup] Failed to connect with invite code: ${error.message}`);
    }
  }

  // Graceful shutdown handler
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Shutdown] ${signal} received, cleaning up...`);
    try {
      clearInterval(dropCleanupTimer);
      clearInterval(pollCleanupTimer);
      clearInterval(messageCleanupTimer);
      clearInterval(bundleDistTimer);
      clearInterval(dmsTimer);
      posts.stop();
      polls.stop();
      trustWeb.stop();
      hubStats.stop();
      if (onionTransport) onionTransport.stop();
      await node.stop();
      await store.close();
      console.log('[Shutdown] Clean shutdown complete.');
    } catch (err) {
      console.error('[Shutdown] Error during cleanup:', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const cli = new DecentraNetCLI(node, store, messaging, calls, groups, content);
  cli.setWebPort(webPort);
  await cli.start();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
