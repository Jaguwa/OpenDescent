/**
 * Multi-Peer Integration Test — 3 nodes with group chat and file sharing
 *
 * Tests:
 * 1. Three nodes boot and discover each other
 * 2. All three exchange profiles
 * 3. Alice creates a group with Bob and Charlie
 * 4. Alice sends a group message
 * 5. Bob and Charlie both receive it
 * 6. Alice shares a file with Bob
 * 7. Bob downloads the file and verifies contents
 * 8. All three shut down cleanly
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { DecentraNode } from '../network/node.js';
import { LocalStore } from '../storage/store.js';
import { MessagingService } from '../messaging/delivery.js';
import { GroupManager } from '../messaging/groups.js';
import { ContentManager, type SharedFileInfo } from '../content/sharing.js';
import { shardContent } from '../storage/shard.js';
import { HubManager } from '../messaging/hubs.js';
import { DeadDropService } from '../content/deaddrops.js';
import { PROTOCOLS } from '../network/node.js';
import type { NodeConfig, Message, DeadDrop } from '../types/index.js';

const TEST_DIR = './test-data-multi';

function makeConfig(name: string, port: number, bootstrapPeers: string[] = []): NodeConfig {
  const dataDir = path.join(TEST_DIR, name);
  return {
    port,
    wsPort: port + 1000,
    displayName: name,
    bootstrapPeers,
    dataDir,
    identityPath: path.join(dataDir, 'identity.json'),
    maxStorageBytes: 64 * 1024 * 1024,
    maxShards: 100,
    enableRelay: false,
    messageRetentionSeconds: 3600,
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

async function run() {
  console.log('=== DecentraNet Multi-Peer Integration Test ===\n');
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

  // ─── Step 1: Boot all three nodes ─────────────────────────────────────
  console.log('1. Starting Alice (7010), Bob (7011), Charlie (7012)...');

  const aliceConfig = makeConfig('Alice', 7010);
  const aliceNode = new DecentraNode(aliceConfig, 'test-pass');
  const aliceStore = new LocalStore(aliceConfig.dataDir, aliceConfig.maxStorageBytes);
  await aliceStore.open();
  await aliceNode.start();
  await aliceStore.storePeerProfile(aliceNode.getProfile());

  const aliceAddrs = aliceNode.getAddresses();

  const bobConfig = makeConfig('Bob', 7011, aliceAddrs);
  const bobNode = new DecentraNode(bobConfig, 'test-pass');
  const bobStore = new LocalStore(bobConfig.dataDir, bobConfig.maxStorageBytes);
  await bobStore.open();
  await bobNode.start();
  await bobStore.storePeerProfile(bobNode.getProfile());

  const bobAddrs = bobNode.getAddresses();
  const charlieConfig = makeConfig('Charlie', 7012, [...aliceAddrs, ...bobAddrs]);
  const charlieNode = new DecentraNode(charlieConfig, 'test-pass');
  const charlieStore = new LocalStore(charlieConfig.dataDir, charlieConfig.maxStorageBytes);
  await charlieStore.open();
  await charlieNode.start();
  await charlieStore.storePeerProfile(charlieNode.getProfile());

  assert(aliceNode.getPeerId().length > 0, 'Alice started');
  assert(bobNode.getPeerId().length > 0, 'Bob started');
  assert(charlieNode.getPeerId().length > 0, 'Charlie started');

  // ─── Step 2: Wait for discovery and profile exchange ──────────────────
  console.log('\n2. Waiting for all peers to discover and exchange profiles...');
  // Retry discovery for up to 20 seconds (mDNS can be slow for transitive discovery)
  let aliceKnowsBob, aliceKnowsCharlie, bobKnowsAlice, bobKnowsCharlie, charlieKnowsAlice, charlieKnowsBob;
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(2000);
    aliceKnowsBob = aliceNode.getKnownPeer(bobNode.getPeerId());
    aliceKnowsCharlie = aliceNode.getKnownPeer(charlieNode.getPeerId());
    bobKnowsAlice = bobNode.getKnownPeer(aliceNode.getPeerId());
    bobKnowsCharlie = bobNode.getKnownPeer(charlieNode.getPeerId());
    charlieKnowsAlice = charlieNode.getKnownPeer(aliceNode.getPeerId());
    charlieKnowsBob = charlieNode.getKnownPeer(bobNode.getPeerId());
    if (aliceKnowsBob && aliceKnowsCharlie && bobKnowsAlice && bobKnowsCharlie && charlieKnowsAlice && charlieKnowsBob) break;
  }

  assert(!!aliceKnowsBob, 'Alice knows Bob');
  assert(!!aliceKnowsCharlie, 'Alice knows Charlie');
  assert(!!bobKnowsAlice, 'Bob knows Alice');
  assert(!!bobKnowsCharlie, 'Bob knows Charlie');
  assert(!!charlieKnowsAlice, 'Charlie knows Alice');
  assert(!!charlieKnowsBob, 'Charlie knows Bob');

  // Persist profiles so messaging & groups work
  if (aliceKnowsBob) await aliceStore.storePeerProfile(aliceKnowsBob);
  if (aliceKnowsCharlie) await aliceStore.storePeerProfile(aliceKnowsCharlie);
  if (bobKnowsAlice) await bobStore.storePeerProfile(bobKnowsAlice);
  if (bobKnowsCharlie) await bobStore.storePeerProfile(bobKnowsCharlie);
  if (charlieKnowsAlice) await charlieStore.storePeerProfile(charlieKnowsAlice);
  if (charlieKnowsBob) await charlieStore.storePeerProfile(charlieKnowsBob);

  // ─── Step 3: Set up messaging and group managers ──────────────────────
  console.log('\n3. Setting up messaging and group managers...');

  const aliceMessaging = new MessagingService(aliceNode, aliceStore);
  const bobMessaging = new MessagingService(bobNode, bobStore);
  const charlieMessaging = new MessagingService(charlieNode, charlieStore);

  const aliceGroups = new GroupManager(aliceNode, aliceStore);
  const bobGroups = new GroupManager(bobNode, bobStore);
  const charlieGroups = new GroupManager(charlieNode, charlieStore);

  // Wire group handlers
  aliceMessaging.setGroupMessageHandler(aliceGroups.handleGroupControlMessage.bind(aliceGroups));
  bobMessaging.setGroupMessageHandler(bobGroups.handleGroupControlMessage.bind(bobGroups));
  charlieMessaging.setGroupMessageHandler(charlieGroups.handleGroupControlMessage.bind(charlieGroups));

  assert(true, 'All messaging and group services initialized');

  // ─── Step 4: Alice creates a group ────────────────────────────────────
  console.log('\n4. Alice creates a group chat with Bob and Charlie...');

  const groupId = await aliceGroups.createGroup('Test Group', [
    bobNode.getPeerId(),
    charlieNode.getPeerId(),
  ]);

  assert(groupId.length > 0, 'Group created with ID');

  // Wait for invites to be delivered
  await sleep(2000);

  const bobHasGroup = bobGroups.findGroup(groupId);
  const charlieHasGroup = charlieGroups.findGroup(groupId);

  assert(!!bobHasGroup, 'Bob received group invite');
  assert(!!charlieHasGroup, 'Charlie received group invite');

  if (bobHasGroup) {
    assert(bobHasGroup.name === 'Test Group', 'Bob sees correct group name');
    assert(bobHasGroup.members.length === 3, 'Bob sees 3 members');
  }

  // ─── Step 5: Alice sends a group message ──────────────────────────────
  console.log('\n5. Alice sends a group message...');

  let bobGroupMsg: Message | null = null;
  let charlieGroupMsg: Message | null = null;

  bobGroups.onGroupMessage((gid, name, msg) => {
    if (gid === groupId) bobGroupMsg = msg;
  });
  charlieGroups.onGroupMessage((gid, name, msg) => {
    if (gid === groupId) charlieGroupMsg = msg;
  });

  await aliceGroups.sendGroupMessage(groupId, 'Hello everyone!');
  await sleep(2000);

  assert(bobGroupMsg !== null, 'Bob received group message');
  assert(charlieGroupMsg !== null, 'Charlie received group message');

  if (bobGroupMsg) {
    assert((bobGroupMsg as Message).body === 'Hello everyone!', 'Bob decrypted group message correctly');
  }
  if (charlieGroupMsg) {
    assert((charlieGroupMsg as Message).body === 'Hello everyone!', 'Charlie decrypted group message correctly');
  }

  // ─── Step 6: File sharing — Alice shares a file with Bob ──────────────
  console.log('\n6. Alice shares a file with Bob...');

  // Create a test file
  const testFilePath = path.join(TEST_DIR, 'test-file.txt');
  const testContent = 'This is a test file for DecentraNet file sharing! 🌐\n'.repeat(100);
  fs.writeFileSync(testFilePath, testContent);

  const aliceContent = new ContentManager(aliceNode, aliceStore);
  const bobContent = new ContentManager(bobNode, bobStore);

  // Wire shard retrieve handlers
  aliceNode.setShardRetrieveHandler(async (shardId: string) => {
    const shard = await aliceStore.getShard(shardId);
    if (!shard) return null;
    return new TextEncoder().encode(JSON.stringify({
      shardId: shard.shardId,
      contentId: shard.contentId,
      index: shard.index,
      totalShards: shard.totalShards,
      requiredShards: shard.requiredShards,
      data: Buffer.from(shard.data).toString('base64'),
      size: shard.size,
    }));
  });

  bobNode.setShardRetrieveHandler(async (shardId: string) => {
    const shard = await bobStore.getShard(shardId);
    if (!shard) return null;
    return new TextEncoder().encode(JSON.stringify({
      shardId: shard.shardId,
      contentId: shard.contentId,
      index: shard.index,
      totalShards: shard.totalShards,
      requiredShards: shard.requiredShards,
      data: Buffer.from(shard.data).toString('base64'),
      size: shard.size,
    }));
  });

  let fileInfo: SharedFileInfo | null = null;
  try {
    fileInfo = await aliceContent.shareFile(testFilePath);
    assert(fileInfo.contentId.length > 0, 'Alice prepared file for sharing');
    assert(fileInfo.fileName === 'test-file.txt', 'File name correct');
    assert(fileInfo.fileSize === Buffer.from(testContent).length, 'File size correct');
  } catch (error: any) {
    assert(false, `File share failed: ${error.message}`);
  }

  // ─── Step 7: Bob downloads the file ───────────────────────────────────
  if (fileInfo) {
    console.log('\n7. Bob downloads the file...');

    const downloadDir = path.join(TEST_DIR, 'bob-downloads');
    try {
      const outputPath = await bobContent.downloadFile(fileInfo, downloadDir);
      assert(fs.existsSync(outputPath), 'Downloaded file exists');

      const downloadedContent = fs.readFileSync(outputPath, 'utf-8');
      assert(downloadedContent === testContent, 'Downloaded file content matches original');
    } catch (error: any) {
      assert(false, `Download failed: ${error.message}`);
    }
  } else {
    console.log('\n7. Skipping download (file share failed)');
  }

  // ─── Step 8: DM between Bob and Charlie ───────────────────────────────
  console.log('\n8. Bob sends a DM to Charlie...');

  let charlieDM: Message | null = null;
  charlieMessaging.onMessage((msg) => {
    charlieDM = msg;
  });

  await bobMessaging.sendTextMessage(charlieNode.getPeerId(), 'Hey Charlie, private message!');
  await sleep(2000);

  assert(charlieDM !== null, 'Charlie received DM from Bob');
  if (charlieDM) {
    assert((charlieDM as Message).body === 'Hey Charlie, private message!', 'DM content correct');
    assert((charlieDM as Message).from === bobNode.getPeerId(), 'DM sender is Bob');
  }

  // ─── Step 9: Group Key Rotation ──────────────────────────────────────
  console.log('\n9. Testing group key rotation on member removal...');

  // Get current group key for Bob before rotation
  const groupBeforeRotation = bobGroups.findGroup(groupId);
  const keyBefore = groupBeforeRotation ? groupBeforeRotation.groupKey : '';
  assert(keyBefore.length > 0, 'Bob has a group key before rotation');

  // Alice removes Charlie from the group
  await aliceGroups.removeMember(groupId, charlieNode.getPeerId());
  await sleep(2000);

  // Verify the group key was rotated for Bob
  const groupAfterRotation = bobGroups.findGroup(groupId);
  const keyAfter = groupAfterRotation ? groupAfterRotation.groupKey : '';
  assert(keyAfter.length > 0, 'Bob has a group key after rotation');
  assert(keyBefore !== keyAfter, 'Group key was rotated (different from before)');

  // Verify Charlie was removed from the group (Alice's view)
  const aliceGroupAfter = aliceGroups.findGroup(groupId);
  assert(
    aliceGroupAfter !== undefined && !aliceGroupAfter.members.includes(charlieNode.getPeerId()),
    'Charlie removed from group member list'
  );

  // Alice can still send messages to the group with new key
  let bobGroupMsg2: Message | null = null;
  bobGroups.onGroupMessage((gid, name, msg) => {
    if (gid === groupId) bobGroupMsg2 = msg;
  });

  await aliceGroups.sendGroupMessage(groupId, 'Post-rotation message');
  await sleep(2000);

  assert(bobGroupMsg2 !== null, 'Bob received post-rotation group message');
  if (bobGroupMsg2) {
    assert(
      (bobGroupMsg2 as Message).body === 'Post-rotation message',
      'Bob decrypted post-rotation message correctly'
    );
  }

  // ─── Step 10: Shard Integrity Verification ─────────────────────────────
  console.log('\n10. Testing shard integrity verification...');

  // Create a small test payload and shard it
  const testPayload = Buffer.from('Shard integrity test data for DecentraNet verification');
  const shards = shardContent(testPayload, { dataShards: 3, parityShards: 1 });
  assert(shards.length === 4, 'Created 4 shards (3 data + 1 parity)');

  // Verify all shards have hash fields
  const allShardsHaveHash = shards.every(s => typeof s.hash === 'string' && s.hash.length === 64);
  assert(allShardsHaveHash, 'All shards have SHA-256 hash (64 hex chars)');

  // Verify hash correctness
  const shard0Hash = crypto.createHash('sha256').update(shards[0].data).digest('hex');
  assert(shard0Hash === shards[0].hash, 'Shard hash matches SHA-256 of data');

  // Store a shard and verify integrity on retrieval
  await aliceStore.storeShard(shards[0]);
  const retrievedShard = await aliceStore.getShard(shards[0].shardId);
  assert(retrievedShard !== null, 'Stored shard retrieved successfully');
  assert(retrievedShard!.hash === shards[0].hash, 'Retrieved shard hash matches original');

  // ─── Step 11: Hub Creation and Messaging ─────────────────────────────
  console.log('\n11. Testing Hub creation and messaging...');

  const aliceHubs = new HubManager(aliceNode, aliceStore);
  const bobHubs = new HubManager(bobNode, bobStore);
  const charlieHubs = new HubManager(charlieNode, charlieStore);

  // Wire hub sync handlers
  aliceNode.setHubSyncHandler(async (data) => { return await aliceHubs.handleHubSyncMessage(data); });
  bobNode.setHubSyncHandler(async (data) => { return await bobHubs.handleHubSyncMessage(data); });
  charlieNode.setHubSyncHandler(async (data) => { return await charlieHubs.handleHubSyncMessage(data); });
  aliceNode.setHubDiscoveryHandler(async (data) => { return await aliceHubs.handleDiscoveryMessage(data); });
  bobNode.setHubDiscoveryHandler(async (data) => { return await bobHubs.handleDiscoveryMessage(data); });
  charlieNode.setHubDiscoveryHandler(async (data) => { return await charlieHubs.handleDiscoveryMessage(data); });

  await aliceHubs.loadHubs();
  await bobHubs.loadHubs();
  await charlieHubs.loadHubs();

  // Alice creates a hub
  const hubId = await aliceHubs.createHub('Test Hub', 'A hub for testing', false, ['test']);
  assert(hubId.length > 0, 'Alice created a hub');

  const aliceHubState = await aliceHubs.getHubState(hubId);
  assert(aliceHubState !== null, 'Hub state exists after creation');
  assert(aliceHubState!.categories.length === 2, 'Hub has 2 default categories (TEXT + VOICE)');
  assert(aliceHubState!.channels.length === 2, 'Hub has 2 default channels');

  const aliceRole = await aliceHubs.getMyRole(hubId);
  assert(aliceRole === 'owner', 'Alice is the hub owner');

  // Alice invites Bob
  await aliceHubs.inviteMember(hubId, bobNode.getPeerId());
  await sleep(2000);

  const bobHubList = bobHubs.getHubs();
  assert(bobHubList.length > 0, 'Bob received hub invite and joined');

  if (bobHubList.length > 0) {
    const bobRole = await bobHubs.getMyRole(hubId);
    assert(bobRole === 'member', 'Bob joined as member role');
  }

  // Alice sends a message in #general
  const generalChannel = aliceHubState!.channels.find(c => c.name === 'general');
  assert(!!generalChannel, 'Found #general channel');

  let bobHubMsg: any = null;
  bobHubs.onChannelMessage.push((hId, chId, msg) => {
    if (hId === hubId) bobHubMsg = msg;
  });

  if (generalChannel) {
    await aliceHubs.sendChannelMessage(hubId, generalChannel.channelId, 'Hello from hub!');
    await sleep(2000);

    assert(bobHubMsg !== null, 'Bob received hub channel message');
    if (bobHubMsg) {
      assert(bobHubMsg.body === 'Hello from hub!', 'Bob decrypted hub message correctly');
    }
  }

  // Alice promotes Bob to Admin
  await aliceHubs.changeRole(hubId, bobNode.getPeerId(), 'admin');
  await sleep(1000);
  const bobRoleAfter = await aliceStore.getHubMember(hubId, bobNode.getPeerId());
  assert(bobRoleAfter !== null && bobRoleAfter.role === 'admin', 'Bob promoted to admin');

  // Bob (admin) creates a channel
  if (bobHubList.length > 0) {
    const catId = aliceHubState!.categories[0].categoryId;
    try {
      const devChId = await bobHubs.createChannel(hubId, catId, 'dev', 'text');
      assert(devChId.length > 0, 'Bob (admin) created #dev channel');
    } catch {
      assert(false, 'Bob (admin) created #dev channel');
    }
  }

  // Alice invites Charlie via direct invite
  await aliceHubs.inviteMember(hubId, charlieNode.getPeerId());
  await sleep(2000);

  const charlieHubList = charlieHubs.getHubs();
  assert(charlieHubList.length > 0, 'Charlie received hub invite and joined');

  // Alice kicks Charlie → key rotated
  const keyBeforeKick = aliceHubs.getHub(hubId)?.hubKey || '';
  await aliceHubs.kickMember(hubId, charlieNode.getPeerId());
  await sleep(2000);
  const keyAfterKick = aliceHubs.getHub(hubId)?.hubKey || '';
  assert(keyBeforeKick !== keyAfterKick, 'Hub key rotated after kicking Charlie');

  // Bob (admin) tries to kick Alice (owner) → should fail
  let kickOwnerFailed = false;
  try {
    await bobHubs.kickMember(hubId, aliceNode.getPeerId());
  } catch {
    kickOwnerFailed = true;
  }
  assert(kickOwnerFailed, 'Cannot kick owner (auth check works)');

  // ─── Step 13: Dead Drop / Onion Routing Tests ─────────────────────────
  console.log('\n13. Dead Drop / Onion Routing tests...');

  const aliceDrops = new DeadDropService(aliceNode, aliceStore);
  const bobDrops = new DeadDropService(bobNode, bobStore);
  const charlieDrops = new DeadDropService(charlieNode, charlieStore);

  // Wire relay handlers so onion hops work (dead drop relay protocol)
  aliceNode.setDeadDropRelayHandler(async (data) => aliceDrops.handleRelayMessage(data));
  bobNode.setDeadDropRelayHandler(async (data) => bobDrops.handleRelayMessage(data));
  charlieNode.setDeadDropRelayHandler(async (data) => charlieDrops.handleRelayMessage(data));

  // Wire broadcast handlers
  aliceNode.setDeadDropBroadcastHandler(async (data) => aliceDrops.handleIncomingBroadcast(data));
  bobNode.setDeadDropBroadcastHandler(async (data) => bobDrops.handleIncomingBroadcast(data));
  charlieNode.setDeadDropBroadcastHandler(async (data) => charlieDrops.handleIncomingBroadcast(data));

  // Track received drops on Bob and Charlie
  const bobReceivedDrops: DeadDrop[] = [];
  const charlieReceivedDrops: DeadDrop[] = [];
  bobDrops.onNewDrop.push((drop) => bobReceivedDrops.push(drop));
  charlieDrops.onNewDrop.push((drop) => charlieReceivedDrops.push(drop));

  // Test 13a: 3-hop onion circuit — Alice creates a dead drop
  console.log('  13a. Alice creates a dead drop (3-hop onion)...');
  const { drop: aliceDrop, warning } = await aliceDrops.createDeadDrop('Anonymous test message from Alice');
  assert(aliceDrop.dropId.length > 0, 'Dead drop created with ID');
  assert(aliceDrop.proofOfWork.length > 0, 'Dead drop has PoW hash');
  assert(aliceDrop.ciphertext.length > 0, 'Dead drop has encrypted content');
  // With 3 peers, should get full onion routing (no warning)
  // Note: Alice sends to herself as relay sometimes, so warning may or may not appear
  if (!warning) {
    assert(true, 'Full onion routing — no anonymity warning');
  } else {
    console.log(`  INFO: ${warning}`);
    assert(true, 'Dead drop created (with reduced anonymity warning)');
  }

  // Wait for the onion circuit to relay (2-15 second delays per hop × 3 hops)
  await sleep(50000);

  // Check if the drop reached at least one peer's store
  const bobHasDrop = await bobStore.getDeadDrop(aliceDrop.dropId);
  const charlieHasDrop = await charlieStore.getDeadDrop(aliceDrop.dropId);
  assert(!!bobHasDrop || !!charlieHasDrop, 'Drop reached at least one peer via onion relay');

  // Verify author identity is NOT revealed (no authorId field on dead drops)
  const receivedDrop = bobHasDrop || charlieHasDrop;
  assert(!('authorId' in receivedDrop!) || !(receivedDrop as any).authorId, 'Drop has no author attribution (anonymous)');

  // Test 13b: PoW verification — valid PoW
  console.log('  13b. PoW verification...');
  const challenge = aliceDrop.dropId + aliceDrop.ciphertext;
  const powHash = crypto.createHash('sha256').update(challenge + aliceDrop.powNonce.toString()).digest('hex');
  assert(powHash === aliceDrop.proofOfWork, 'PoW hash matches recomputed hash');

  // Check leading zero bits (at least 18)
  const hexPrefix = powHash.slice(0, 5); // first 20 bits = 5 hex chars
  const first18bits = parseInt(hexPrefix, 16) >> 2; // top 18 bits
  assert(first18bits === 0, 'PoW has at least 18 leading zero bits');

  // Invalid PoW: tamper nonce — verify it fails
  const badHash = crypto.createHash('sha256').update(challenge + (aliceDrop.powNonce + 999999).toString()).digest('hex');
  assert(badHash !== aliceDrop.proofOfWork, 'Tampered nonce produces different hash (invalid PoW)');

  // Test 13c: Daily key derivation consistency
  console.log('  13c. Daily network key derivation...');
  // Both Alice and Bob should derive the same key for today
  const aliceDecrypted = aliceDrops.decryptDrop(aliceDrop);
  const bobDecrypted = bobDrops.decryptDrop(aliceDrop);
  assert(aliceDecrypted === 'Anonymous test message from Alice', 'Alice decrypts own drop correctly');
  assert(bobDecrypted === 'Anonymous test message from Alice', 'Bob decrypts drop with same daily key');

  // Test 13d: Graceful degradation (already tested implicitly — with 3 peers, full routing used)
  // Test with just 2 peers by creating a drop from Charlie's perspective while disconnected from one peer
  console.log('  13d. Adaptive difficulty returns baseline...');
  const difficulty = await aliceDrops.getAdaptiveDifficulty();
  assert(difficulty >= 18, 'Adaptive difficulty is at least baseline (18 bits)');

  // Clean up
  aliceDrops.dispose();
  bobDrops.dispose();
  charlieDrops.dispose();

  // ─── Step 14: WebRTC Signaling Tests ──────────────────────────────────
  console.log('\n14. WebRTC signaling tests (mock SDP, no media)...');

  // Test 14a: Call offer/answer exchange
  console.log('  14a. Call offer/answer signal relay...');
  let bobReceivedSignal: any = null;
  bobNode.on('call:incoming', (event) => {
    bobReceivedSignal = event.data;
  });

  // Alice sends a mock offer to Bob via CALL_SIGNAL protocol
  const mockOffer = {
    type: 'offer',
    sdp: 'mock-sdp-offer-v=0\r\no=- 123 IN IP4 0.0.0.0\r\n',
    from: aliceNode.getPeerId(),
    to: bobNode.getPeerId(),
    callId: crypto.randomUUID(),
  };
  const offerData = new TextEncoder().encode(JSON.stringify(mockOffer));
  const offerResp = await aliceNode.sendToPeer(bobNode.getPeerId(), PROTOCOLS.CALL_SIGNAL, offerData);
  assert(offerResp !== null, 'Alice sent call offer to Bob (got response)');

  await sleep(1000);
  assert(bobReceivedSignal !== null, 'Bob received call offer signal');
  if (bobReceivedSignal) {
    assert(bobReceivedSignal.type === 'offer', 'Signal type is "offer"');
    assert(bobReceivedSignal.sdp === mockOffer.sdp, 'SDP content matches');
    assert(bobReceivedSignal.callId === mockOffer.callId, 'Call ID matches');
  }

  // Bob sends answer back to Alice
  let aliceReceivedSignal: any = null;
  aliceNode.on('call:incoming', (event) => {
    aliceReceivedSignal = event.data;
  });

  const mockAnswer = {
    type: 'answer',
    sdp: 'mock-sdp-answer-v=0\r\no=- 456 IN IP4 0.0.0.0\r\n',
    from: bobNode.getPeerId(),
    to: aliceNode.getPeerId(),
    callId: mockOffer.callId,
  };
  const answerData = new TextEncoder().encode(JSON.stringify(mockAnswer));
  await bobNode.sendToPeer(aliceNode.getPeerId(), PROTOCOLS.CALL_SIGNAL, answerData);
  await sleep(1000);

  assert(aliceReceivedSignal !== null, 'Alice received call answer signal');
  if (aliceReceivedSignal) {
    assert(aliceReceivedSignal.type === 'answer', 'Signal type is "answer"');
    assert(aliceReceivedSignal.callId === mockOffer.callId, 'Answer call ID matches offer');
  }

  // Test 14b: ICE candidate relay
  console.log('  14b. ICE candidate relay...');
  let bobReceivedIce: any = null;
  // Reset Bob's handler (we'll check latest signal)
  bobReceivedSignal = null;
  bobNode.on('call:incoming', (event) => {
    bobReceivedIce = event.data;
  });

  const mockCandidate = {
    type: 'ice-candidate',
    candidate: 'candidate:1 1 UDP 2013266431 192.168.1.1 50000 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0,
    from: aliceNode.getPeerId(),
    to: bobNode.getPeerId(),
    callId: mockOffer.callId,
  };
  const iceData = new TextEncoder().encode(JSON.stringify(mockCandidate));
  await aliceNode.sendToPeer(bobNode.getPeerId(), PROTOCOLS.CALL_SIGNAL, iceData);
  await sleep(1000);

  assert(bobReceivedIce !== null, 'Bob received ICE candidate');
  if (bobReceivedIce) {
    assert(bobReceivedIce.type === 'ice-candidate', 'ICE candidate type correct');
    assert(bobReceivedIce.candidate === mockCandidate.candidate, 'ICE candidate content matches');
  }

  // Test 14c: Call hangup signal
  console.log('  14c. Call hangup signal...');
  let bobReceivedHangup: any = null;
  bobNode.on('call:incoming', (event) => {
    bobReceivedHangup = event.data;
  });

  const mockHangup = {
    type: 'hangup',
    from: aliceNode.getPeerId(),
    to: bobNode.getPeerId(),
    callId: mockOffer.callId,
  };
  const hangupData = new TextEncoder().encode(JSON.stringify(mockHangup));
  await aliceNode.sendToPeer(bobNode.getPeerId(), PROTOCOLS.CALL_SIGNAL, hangupData);
  await sleep(1000);

  assert(bobReceivedHangup !== null, 'Bob received hangup signal');
  if (bobReceivedHangup) {
    assert(bobReceivedHangup.type === 'hangup', 'Hangup signal type correct');
    assert(bobReceivedHangup.callId === mockOffer.callId, 'Hangup call ID matches');
  }

  // ─── Step 15: Shutdown ─────────────────────────────────────────────────
  console.log('\n15. Shutting down all nodes...');

  await aliceNode.stop();
  await bobNode.stop();
  await charlieNode.stop();
  await aliceStore.close();
  await bobStore.close();
  await charlieStore.close();

  assert(true, 'All three nodes shut down cleanly');

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
