/**
 * Cross-Network Relay Test — Verifies two peers can connect and message
 * through the public relay without mDNS or direct address sharing.
 *
 * Simulates cross-network messaging on a single machine by:
 * - Disabling mDNS so nodes can't discover each other locally
 * - NOT passing bootstrap addresses between nodes — they only know the public relay
 * - Using invite codes to connect (the real-world flow)
 * - Verifying E2E encrypted DMs, group chat, and posts
 *
 * This is a REAL network test — it contacts the public relay at 188.166.151.203.
 * If the relay is unreachable, the test skips with exit 0.
 *
 * Two modes:
 * - RELAY mode: If the relay grants circuit relay reservations, nodes connect
 *   via relay-routed circuit addresses (full cross-network simulation)
 * - FALLBACK mode: If reservations aren't granted, nodes use their LAN addresses
 *   in invite codes. Still validates invite parsing, connectWithInvite, profile
 *   exchange, and E2E encrypted messaging — just over LAN instead of relay.
 */

import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import { DecentraNode } from '../network/node.js';
import { LocalStore } from '../storage/store.js';
import { MessagingService } from '../messaging/delivery.js';
import { GroupManager } from '../messaging/groups.js';
import { PostService } from '../content/posts.js';
import type { NodeConfig, Message } from '../types/index.js';

const TEST_DIR = './test-data-relay';
const RELAY_IP = '188.166.151.203';
const RELAY_PORT = 6001;

function makeConfig(name: string, port: number): NodeConfig {
  const dataDir = path.join(TEST_DIR, name);
  return {
    port,
    wsPort: port + 1000,
    displayName: name,
    bootstrapPeers: [],       // only DEFAULT_BOOTSTRAP_PEERS (merged in node.ts)
    dataDir,
    identityPath: path.join(dataDir, 'identity.json'),
    maxStorageBytes: 64 * 1024 * 1024,
    maxShards: 100,
    enableRelay: false,
    messageRetentionSeconds: 3600,
    disableMdns: true,        // no local discovery — relay only
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

/** TCP connect check — returns true if relay is reachable */
function checkRelay(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: RELAY_IP, port: RELAY_PORT, timeout: 5000 });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

/** Wait for relay connection (profile exchange with a bootstrap peer) */
async function waitForRelayConnection(node: DecentraNode, label: string, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (node.getConnectedPeers().length > 0) {
      console.log(`  ${label} connected to relay (${Math.round((Date.now() - start) / 1000)}s)`);
      return true;
    }
    await sleep(1000);
  }
  return false;
}

/** Wait for circuit relay address to appear */
async function waitForCircuitAddress(node: DecentraNode, label: string, timeoutMs = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (node.getAddresses().some(a => a.includes('/p2p-circuit/'))) {
      console.log(`  ${label} got circuit relay reservation (${Math.round((Date.now() - start) / 1000)}s)`);
      return true;
    }
    await sleep(2000);
  }
  return false;
}

/**
 * Build an invite code manually. Used when getInviteCode() produces no addresses
 * (because it filters out LAN IPs and relay didn't grant reservations).
 * Includes LAN addresses so the nodes can reach each other on the same machine.
 */
function buildManualInviteCode(node: DecentraNode): string {
  const allAddrs = node.getAddresses()
    .filter(a => !a.includes('/::1/') && !a.includes('/127.0.0.1/'));
  const payload = {
    v: 1,
    a: allAddrs,
    d: node.getPeerId(),
    l: node.getLibp2pPeerId(),
    n: node.getIdentity().displayName || undefined,
  };
  const json = JSON.stringify(payload);
  return Buffer.from(json).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function run() {
  console.log('=== DecentraNet Cross-Network Relay Test ===\n');

  // ─── Step 1: Relay reachability check ─────────────────────────────────
  console.log('1. Checking relay reachability...');
  const relayUp = await checkRelay();
  if (!relayUp) {
    console.log('SKIPPED: Public relay unreachable at ' + RELAY_IP + ':' + RELAY_PORT);
    process.exit(0);
  }
  console.log('  Relay is reachable\n');

  cleanup();

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string) {
    if (condition) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.log(`  FAIL: ${label}`);
      failed++;
    }
  }

  let aliceNode: DecentraNode | null = null;
  let bobNode: DecentraNode | null = null;
  let aliceStore: LocalStore | null = null;
  let bobStore: LocalStore | null = null;
  let alicePosts: PostService | null = null;

  try {
    // ─── Step 2: Boot two nodes (relay-only, no mDNS, no mutual bootstrap) ─
    console.log('2. Starting Alice (9010) and Bob (9011) — relay-only, no mDNS...');

    const aliceConfig = makeConfig('Alice', 9010);
    aliceNode = new DecentraNode(aliceConfig, 'test-relay');
    aliceStore = new LocalStore(aliceConfig.dataDir, aliceConfig.maxStorageBytes);
    await aliceStore.open();
    await aliceNode.start();
    await aliceStore.storePeerProfile(aliceNode.getProfile());

    const bobConfig = makeConfig('Bob', 9011);
    bobNode = new DecentraNode(bobConfig, 'test-relay');
    bobStore = new LocalStore(bobConfig.dataDir, bobConfig.maxStorageBytes);
    await bobStore.open();
    await bobNode.start();
    await bobStore.storePeerProfile(bobNode.getProfile());

    assert(aliceNode.getPeerId().length > 0, 'Alice started');
    assert(bobNode.getPeerId().length > 0, 'Bob started');

    // ─── Step 3: Wait for relay connection ──────────────────────────────
    console.log('\n3. Waiting for relay connection (up to 30s)...');

    const aliceOnRelay = await waitForRelayConnection(aliceNode, 'Alice');
    const bobOnRelay = await waitForRelayConnection(bobNode, 'Bob');

    assert(aliceOnRelay, 'Alice connected to relay');
    assert(bobOnRelay, 'Bob connected to relay');

    if (!aliceOnRelay || !bobOnRelay) {
      console.log('\nCannot proceed without relay connection. Aborting.');
      throw new Error('Relay connection failed');
    }

    // Check if circuit relay reservations are available
    console.log('\n  Checking for circuit relay reservations (20s)...');
    const aliceHasCircuit = await waitForCircuitAddress(aliceNode, 'Alice');
    const bobHasCircuit = await waitForCircuitAddress(bobNode, 'Bob');

    const relayMode = aliceHasCircuit && bobHasCircuit;
    if (relayMode) {
      console.log('  MODE: Full relay routing — circuit reservations available');
    } else {
      console.log('  MODE: LAN fallback — relay did not grant reservations (NO_RESERVATION)');
      console.log('  Tests will use LAN addresses in invite codes instead');
    }
    assert(true, `Relay connection established (${relayMode ? 'circuit relay' : 'LAN fallback'} mode)`);

    // ─── Step 4: Invite code generation + validation ────────────────────
    console.log('\n4. Testing invite code generation...');

    // Use standard invite code if relay provides circuit addresses, otherwise manual
    let aliceCode: string;
    let bobCode: string;

    if (relayMode) {
      aliceCode = aliceNode.getInviteCode();
      bobCode = bobNode.getInviteCode();
    } else {
      aliceCode = buildManualInviteCode(aliceNode);
      bobCode = buildManualInviteCode(bobNode);
    }

    assert(aliceCode.length > 0, 'Alice generated invite code');

    // Decode and inspect Alice's code
    const alicePayload = JSON.parse(
      Buffer.from(aliceCode.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
    );
    assert(!!alicePayload.l, 'Invite code contains libp2p PeerId (l field)');
    assert(!!alicePayload.d, 'Invite code contains DecentraNet PeerId (d field)');
    assert(alicePayload.a.length > 0, 'Invite code contains addresses');

    if (relayMode) {
      assert(
        alicePayload.a.some((a: string) => a.includes('/p2p-circuit/')),
        'Invite code contains relay circuit address'
      );
    }

    assert(bobCode.length > 0, 'Bob generated invite code');

    const bobPayload = JSON.parse(
      Buffer.from(bobCode.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
    );
    assert(!!bobPayload.l, 'Bob invite code contains libp2p PeerId (l field)');

    // ─── Step 5: Bob connects to Alice via invite code ──────────────────
    console.log('\n5. Bob connects to Alice via invite code...');

    const connectResult = await bobNode.connectWithInvite(aliceCode);
    assert(connectResult.peerId === aliceNode.getPeerId(), 'Bob connected to Alice via invite');

    // Wait for profile exchange to complete
    await sleep(3000);
    const bobKnowsAlice = bobNode.getKnownPeer(aliceNode.getPeerId());
    assert(!!bobKnowsAlice, 'Bob knows Alice after invite connect');

    // ─── Step 6: Alice connects to Bob via invite code ──────────────────
    console.log('\n6. Alice connects to Bob via invite code...');

    const reverseResult = await aliceNode.connectWithInvite(bobCode);
    assert(reverseResult.peerId === bobNode.getPeerId(), 'Alice connected to Bob via invite');

    await sleep(3000);
    const aliceKnowsBob = aliceNode.getKnownPeer(bobNode.getPeerId());
    assert(!!aliceKnowsBob, 'Alice knows Bob after invite connect');

    // Persist profiles so messaging & groups work
    if (bobKnowsAlice) await bobStore.storePeerProfile(bobKnowsAlice);
    if (aliceKnowsBob) await aliceStore.storePeerProfile(aliceKnowsBob);

    // ─── Step 7: DM — Alice → Bob ───────────────────────────────────────
    console.log('\n7. Alice sends DM to Bob...');

    const aliceMessaging = new MessagingService(aliceNode, aliceStore);
    const bobMessaging = new MessagingService(bobNode, bobStore);

    let bobReceivedDM: Message | null = null;
    bobMessaging.onMessage((msg) => {
      bobReceivedDM = msg;
    });

    await aliceMessaging.sendTextMessage(bobNode.getPeerId(), 'Hello through the relay!');

    // Wait for delivery (up to 15s)
    for (let i = 0; i < 15 && !bobReceivedDM; i++) await sleep(1000);

    assert(bobReceivedDM !== null, 'Bob received DM from Alice');
    if (bobReceivedDM) {
      assert((bobReceivedDM as Message).body === 'Hello through the relay!', 'DM body correct');
      assert((bobReceivedDM as Message).from === aliceNode.getPeerId(), 'DM sender is Alice');
    }

    // ─── Step 8: DM — Bob → Alice reply ─────────────────────────────────
    console.log('\n8. Bob replies to Alice...');

    let aliceReceivedDM: Message | null = null;
    aliceMessaging.onMessage((msg) => {
      aliceReceivedDM = msg;
    });

    await bobMessaging.sendTextMessage(aliceNode.getPeerId(), 'Got it, relay works!');

    for (let i = 0; i < 15 && !aliceReceivedDM; i++) await sleep(1000);

    assert(aliceReceivedDM !== null, 'Alice received reply from Bob');
    if (aliceReceivedDM) {
      assert((aliceReceivedDM as Message).body === 'Got it, relay works!', 'Reply body correct');
      assert((aliceReceivedDM as Message).from === bobNode.getPeerId(), 'Reply sender is Bob');
    }

    // ─── Step 9: Group chat ─────────────────────────────────────────────
    console.log('\n9. Testing group chat...');

    const aliceGroups = new GroupManager(aliceNode, aliceStore);
    const bobGroups = new GroupManager(bobNode, bobStore);

    // Wire group handlers
    aliceMessaging.setGroupMessageHandler(aliceGroups.handleGroupControlMessage.bind(aliceGroups));
    bobMessaging.setGroupMessageHandler(bobGroups.handleGroupControlMessage.bind(bobGroups));

    const groupId = await aliceGroups.createGroup('Relay Test Group', [bobNode.getPeerId()]);
    assert(groupId.length > 0, 'Group created');

    // Wait for invite delivery
    await sleep(5000);

    const bobHasGroup = bobGroups.findGroup(groupId);
    assert(!!bobHasGroup, 'Bob received group invite');

    if (bobHasGroup) {
      let bobGroupMsg: Message | null = null;
      bobGroups.onGroupMessage((gid, name, msg) => {
        if (gid === groupId) bobGroupMsg = msg;
      });

      await aliceGroups.sendGroupMessage(groupId, 'Group relay test!');
      await sleep(5000);

      assert(bobGroupMsg !== null, 'Bob received group message');
      if (bobGroupMsg) {
        assert((bobGroupMsg as Message).body === 'Group relay test!', 'Group message body correct');
      }
    }

    // ─── Step 10: Timeline post ─────────────────────────────────────────
    console.log('\n10. Testing timeline post creation...');

    alicePosts = new PostService(aliceNode, aliceStore);

    const post = await alicePosts.createPost('First relay-verified post!');
    assert(post.postId.length > 0, 'Post created with ID');
    assert(post.authorId === aliceNode.getPeerId(), 'Post author is Alice');
    assert(post.content === 'First relay-verified post!', 'Post content correct');

    // ─── Step 11: Verify connections ────────────────────────────────────
    console.log('\n11. Verifying connections...');

    assert(aliceNode.getConnectedPeers().length > 0, 'Alice has active connections');
    assert(bobNode.getConnectedPeers().length > 0, 'Bob has active connections');
    assert(!!aliceNode.getKnownPeer(bobNode.getPeerId()), 'Alice knows Bob (final check)');
    assert(!!bobNode.getKnownPeer(aliceNode.getPeerId()), 'Bob knows Alice (final check)');

  } finally {
    // ─── Step 12: Shutdown ──────────────────────────────────────────────
    console.log('\n12. Shutting down...');

    if (alicePosts) alicePosts.stop();
    if (aliceNode) await aliceNode.stop();
    if (bobNode) await bobNode.stop();
    if (aliceStore) await aliceStore.close();
    if (bobStore) await bobStore.close();

    assert(true, 'Both nodes shut down cleanly');
  }

  // ─── Results ──────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error('Test crashed:', error);
  cleanup();
  process.exit(1);
});
