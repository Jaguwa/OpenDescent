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
import { DecentraNode } from '../network/node.js';
import { LocalStore } from '../storage/store.js';
import { MessagingService } from '../messaging/delivery.js';
import { GroupManager } from '../messaging/groups.js';
import { ContentManager, type SharedFileInfo } from '../content/sharing.js';
import type { NodeConfig, Message } from '../types/index.js';

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

  const charlieConfig = makeConfig('Charlie', 7012, aliceAddrs);
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
  await sleep(6000);

  const aliceKnowsBob = aliceNode.getKnownPeer(bobNode.getPeerId());
  const aliceKnowsCharlie = aliceNode.getKnownPeer(charlieNode.getPeerId());
  const bobKnowsAlice = bobNode.getKnownPeer(aliceNode.getPeerId());
  const bobKnowsCharlie = bobNode.getKnownPeer(charlieNode.getPeerId());
  const charlieKnowsAlice = charlieNode.getKnownPeer(aliceNode.getPeerId());
  const charlieKnowsBob = charlieNode.getKnownPeer(bobNode.getPeerId());

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

  // ─── Step 9: Shutdown ─────────────────────────────────────────────────
  console.log('\n9. Shutting down all nodes...');

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
