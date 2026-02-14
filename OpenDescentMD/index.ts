/**
 * DecentraNet — Main Entry Point
 *
 * This is the top-level orchestrator that wires together all the layers:
 * Network → Crypto → Storage → Messaging → Media
 *
 * Usage:
 *   npx ts-node src/index.ts --port 6001 --name "Alice"
 *   npx ts-node src/index.ts --port 6002 --name "Bob" --bootstrap /ip4/127.0.0.1/tcp/6001
 */

import * as path from 'path';
import * as readline from 'readline';
import { DecentraNode } from './network/node.js';
import { LocalStore } from './storage/store.js';
import { MessagingService } from './messaging/delivery.js';
import { CallManager } from './media/webrtc.js';
import type { NodeConfig, Message } from './types/index.js';

// ─── Parse CLI Arguments ─────────────────────────────────────────────────────

function parseArgs(): Partial<NodeConfig> & { help?: boolean } {
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
  private rl: readline.Interface;

  constructor(node: DecentraNode, store: LocalStore, messaging: MessagingService, calls: CallManager) {
    this.node = node;
    this.store = store;
    this.messaging = messaging;
    this.calls = calls;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async start(): Promise<void> {
    // Set up message handler
    this.messaging.onMessage((message: Message) => {
      console.log(`\n📨 Message from ${message.from}: ${message.body}`);
      this.prompt();
    });

    // Set up call handlers
    this.calls.setHandlers({
      onIncomingCall: (call) => {
        console.log(`\n📞 Incoming ${call.type} call from ${call.remotePeerId}`);
        console.log(`   Type 'accept ${call.callId}' to answer`);
        this.prompt();
      },
      onCallConnected: (call) => {
        console.log(`\n✅ Call ${call.callId} connected!`);
        this.prompt();
      },
      onCallEnded: (callId, reason) => {
        console.log(`\n📵 Call ${callId} ended: ${reason}`);
        this.prompt();
      },
    });

    this.printHelp();
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
      case 'whoami':
        console.log(`Peer ID: ${this.node.getPeerId()}`);
        console.log(`Name:    ${this.node.getIdentity().displayName || '(none)'}`);
        console.log(`Addrs:   ${this.node.getAddresses().join('\n         ')}`);
        break;

      case 'peers':
        const peers = this.node.getConnectedPeers();
        if (peers.length === 0) {
          console.log('No connected peers');
        } else {
          console.log(`Connected peers (${peers.length}):`);
          peers.forEach((p) => console.log(`  ${p}`));
        }
        break;

      case 'msg':
      case 'send': {
        const recipientId = args[0];
        const text = args.slice(1).join(' ');
        if (!recipientId || !text) {
          console.log('Usage: msg <peer-id> <message>');
          break;
        }
        try {
          const msgId = await this.messaging.sendTextMessage(recipientId, text);
          console.log(`Sent (${msgId})`);
        } catch (error: any) {
          console.error(`Failed: ${error.message}`);
        }
        break;
      }

      case 'call': {
        const remotePeer = args[0];
        const callType = (args[1] || 'voice') as any;
        if (!remotePeer) {
          console.log('Usage: call <peer-id> [voice|video]');
          break;
        }
        try {
          const callId = await this.calls.startCall(remotePeer, callType);
          console.log(`Calling... (${callId})`);
        } catch (error: any) {
          console.error(`Failed: ${error.message}`);
        }
        break;
      }

      case 'accept': {
        const callId = args[0];
        if (!callId) {
          console.log('Usage: accept <call-id>');
          break;
        }
        try {
          await this.calls.acceptCall(callId);
        } catch (error: any) {
          console.error(`Failed: ${error.message}`);
        }
        break;
      }

      case 'hangup': {
        const callId = args[0];
        if (!callId) {
          const activeCalls = this.calls.getActiveCalls();
          if (activeCalls.length === 1) {
            await this.calls.endCall(activeCalls[0].callId);
          } else {
            console.log('Usage: hangup <call-id>');
          }
          break;
        }
        await this.calls.endCall(callId);
        break;
      }

      case 'storage': {
        const usage = this.store.getStorageUsage();
        console.log(`Storage: ${formatBytes(usage.used)} / ${formatBytes(usage.max)} (${usage.percentage.toFixed(1)}%)`);
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
        console.log(`Unknown command: ${command}. Type 'help' for available commands.`);
    }
  }

  private printHelp(): void {
    console.log(`
╔══════════════════════════════════════════════════════╗
║              DecentraNet v0.1.0                      ║
║         Decentralized P2P Social Network             ║
╠══════════════════════════════════════════════════════╣
║  Commands:                                           ║
║                                                      ║
║  id / whoami     Show your peer ID and addresses     ║
║  peers           List connected peers                ║
║  msg <id> <txt>  Send a text message                 ║
║  call <id> [v/a] Start a voice/video call            ║
║  accept <callid> Accept an incoming call             ║
║  hangup [callid] End a call                          ║
║  storage         Show storage usage                  ║
║  help            Show this help                      ║
║  quit            Shutdown and exit                   ║
╚══════════════════════════════════════════════════════╝
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
  --name, -n <string>      Display name for this node
  --bootstrap, -b <addr>   Bootstrap peer multiaddr (can repeat)
  --data, -d <path>        Data directory (default: ./data)
  --help, -h               Show this help
    `);
    process.exit(0);
  }

  const config: NodeConfig = {
    port: args.port || 6001,
    displayName: args.displayName || `Peer-${Math.floor(Math.random() * 10000)}`,
    bootstrapPeers: args.bootstrapPeers || [],
    dataDir: args.dataDir || `./data-${args.port || 6001}`,
    identityPath: path.join(args.dataDir || `./data-${args.port || 6001}`, 'identity.json'),
    maxStorageBytes: 512 * 1024 * 1024, // 512MB
    maxShards: 10000,
    enableRelay: true,
    messageRetentionSeconds: 7 * 24 * 60 * 60,
  };

  console.log('🌐 Starting DecentraNet node...\n');

  // Initialize layers
  const node = new DecentraNode(config);
  const store = new LocalStore(config.dataDir, config.maxStorageBytes);

  await store.open();
  await node.start();

  const messaging = new MessagingService(node, store);
  const calls = new CallManager(node);

  // Start interactive CLI
  const cli = new DecentraNetCLI(node, store, messaging, calls);
  await cli.start();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
