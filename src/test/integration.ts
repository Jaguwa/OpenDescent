/**
 * Integration Test — Two-node communication
 *
 * Boots Alice and Bob, verifies:
 * 1. Both nodes start successfully
 * 2. They discover each other via mDNS
 * 3. They exchange profiles (encryption keys)
 * 4. Alice can send an encrypted message to Bob
 * 5. Bob receives and decrypts it
 * 6. Bob can reply to Alice
 * 7. Both shut down cleanly
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { DecentraNode } from '../network/node.js';
import { LocalStore } from '../storage/store.js';
import { MessagingService } from '../messaging/delivery.js';
import { generateMnemonic, validateMnemonic, mnemonicToSeed } from '../crypto/mnemonic.js';
import { generateIdentityFromSeed, publicKeyToPeerId } from '../crypto/identity.js';
import type { NodeConfig, Message } from '../types/index.js';

const TEST_DIR = './test-data';

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
  console.log('=== DecentraNet Integration Test ===\n');
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

  // ─── Step 1: Boot Alice ─────────────────────────────────────────────────
  console.log('1. Starting Alice on port 7001...');
  const aliceConfig = makeConfig('Alice', 7001);
  const aliceNode = new DecentraNode(aliceConfig, 'test-pass');
  const aliceStore = new LocalStore(aliceConfig.dataDir, aliceConfig.maxStorageBytes);
  await aliceStore.open();
  await aliceNode.start();

  assert(aliceNode.getPeerId().length > 0, 'Alice has a Peer ID');
  assert(aliceNode.getAddresses().length > 0, 'Alice has listen addresses');

  // Store Alice's own profile
  await aliceStore.storePeerProfile(aliceNode.getProfile());

  // ─── Step 2: Boot Bob with Alice as bootstrap ───────────────────────────
  console.log('\n2. Starting Bob on port 7002 (bootstrap: Alice)...');
  const aliceAddrs = aliceNode.getAddresses();
  const bobConfig = makeConfig('Bob', 7002, aliceAddrs);
  const bobNode = new DecentraNode(bobConfig, 'test-pass');
  const bobStore = new LocalStore(bobConfig.dataDir, bobConfig.maxStorageBytes);
  await bobStore.open();
  await bobNode.start();

  assert(bobNode.getPeerId().length > 0, 'Bob has a Peer ID');
  assert(bobNode.getPeerId() !== aliceNode.getPeerId(), 'Alice and Bob have different Peer IDs');

  await bobStore.storePeerProfile(bobNode.getProfile());

  // ─── Step 3: Wait for discovery and profile exchange ────────────────────
  console.log('\n3. Waiting for peer discovery and profile exchange...');

  // Wait for profile exchange (the auto-exchange fires on connect with 500ms delay)
  await sleep(4000);

  const aliceKnowsBob = aliceNode.getKnownPeer(bobNode.getPeerId());
  const bobKnowsAlice = bobNode.getKnownPeer(aliceNode.getPeerId());

  assert(!!aliceKnowsBob, 'Alice received Bob\'s profile');
  assert(!!bobKnowsAlice, 'Bob received Alice\'s profile');

  if (aliceKnowsBob) {
    assert(aliceKnowsBob.displayName === 'Bob', 'Alice knows Bob\'s display name');
    assert(aliceKnowsBob.encryptionPublicKey.length > 0, 'Alice has Bob\'s encryption key');
  }

  if (bobKnowsAlice) {
    assert(bobKnowsAlice.displayName === 'Alice', 'Bob knows Alice\'s display name');
  }

  // Persist profiles for messaging to work
  if (aliceKnowsBob) await aliceStore.storePeerProfile(aliceKnowsBob);
  if (bobKnowsAlice) await bobStore.storePeerProfile(bobKnowsAlice);

  // ─── Step 4: Alice sends a message to Bob ───────────────────────────────
  console.log('\n4. Alice sends a message to Bob...');

  const aliceMessaging = new MessagingService(aliceNode, aliceStore);
  const bobMessaging = new MessagingService(bobNode, bobStore);

  let bobReceivedMessage: Message | null = null;
  bobMessaging.onMessage((msg) => {
    bobReceivedMessage = msg;
  });

  try {
    const msgId = await aliceMessaging.sendTextMessage(bobNode.getPeerId(), 'Hello Bob! This is encrypted.');
    assert(msgId.length > 0, 'Alice sent message (got message ID)');
  } catch (error: any) {
    assert(false, `Alice send failed: ${error.message}`);
  }

  // Wait for delivery
  await sleep(2000);

  assert(bobReceivedMessage !== null, 'Bob received the message');
  if (bobReceivedMessage) {
    const msg = bobReceivedMessage as Message;
    assert(msg.body === 'Hello Bob! This is encrypted.', 'Message body decrypted correctly');
    assert(msg.from === aliceNode.getPeerId(), 'Message "from" is Alice\'s Peer ID');
  }

  // ─── Step 5: Bob replies to Alice ───────────────────────────────────────
  console.log('\n5. Bob replies to Alice...');

  let aliceReceivedMessage: Message | null = null;
  aliceMessaging.onMessage((msg) => {
    aliceReceivedMessage = msg;
  });

  try {
    await bobMessaging.sendTextMessage(aliceNode.getPeerId(), 'Hey Alice! Got your message.');
    assert(true, 'Bob sent reply');
  } catch (error: any) {
    assert(false, `Bob reply failed: ${error.message}`);
  }

  await sleep(2000);

  assert(aliceReceivedMessage !== null, 'Alice received the reply');
  if (aliceReceivedMessage) {
    const msg = aliceReceivedMessage as Message;
    assert(msg.body === 'Hey Alice! Got your message.', 'Reply body decrypted correctly');
  }

  // ─── Step 6: Check conversation history ─────────────────────────────────
  console.log('\n6. Checking conversation history...');

  const aliceConvoId = [aliceNode.getPeerId(), bobNode.getPeerId()].sort().join(':');
  const aliceHistory = await aliceStore.getConversationHistory(aliceConvoId);
  assert(aliceHistory.length >= 1, `Alice has ${aliceHistory.length} message(s) in history`);

  // ─── Step 7: Mnemonic + Deterministic Key Derivation ───────────────────
  console.log('\n7. Testing mnemonic generation and deterministic key derivation...');

  // 7a. Generate mnemonic and validate
  const mnemonic = generateMnemonic();
  assert(mnemonic.length === 12, 'Mnemonic has 12 words');
  assert(validateMnemonic(mnemonic), 'Generated mnemonic passes validation');

  // 7b. Invalid mnemonic fails validation
  const badMnemonic = [...mnemonic];
  badMnemonic[0] = 'zzzznotaword';
  assert(!validateMnemonic(badMnemonic), 'Invalid mnemonic fails validation');

  // 7c. Deterministic keys — same mnemonic produces same identity
  const seed1 = mnemonicToSeed(mnemonic);
  const seed2 = mnemonicToSeed(mnemonic);
  assert(Buffer.from(seed1).equals(Buffer.from(seed2)), 'Same mnemonic produces same seed');

  const identity1 = generateIdentityFromSeed(seed1, 'TestUser');
  const identity2 = generateIdentityFromSeed(seed2, 'TestUser');
  const pid1 = publicKeyToPeerId(identity1.publicKey);
  const pid2 = publicKeyToPeerId(identity2.publicKey);
  assert(pid1 === pid2, 'Same seed produces same PeerId');
  assert(
    Buffer.from(identity1.publicKey).equals(Buffer.from(identity2.publicKey)),
    'Same seed produces same public key'
  );

  // 7d. Different mnemonic produces different identity
  const mnemonic2 = generateMnemonic();
  const seed3 = mnemonicToSeed(mnemonic2);
  const identity3 = generateIdentityFromSeed(seed3, 'OtherUser');
  const pid3 = publicKeyToPeerId(identity3.publicKey);
  assert(pid1 !== pid3, 'Different mnemonic produces different PeerId');

  // ─── Step 8: TOFU Key Pinning ───────────────────────────────────────────
  console.log('\n8. Testing TOFU key pinning...');

  const testPeerId = 'test-tofu-peer-id';
  const testPubKey = crypto.randomBytes(32);
  const testPubKeyHash = crypto.createHash('sha256').update(testPubKey).digest('hex');

  await aliceStore.storePinnedKey({
    peerId: testPeerId,
    publicKeyHash: testPubKeyHash,
    firstSeen: Date.now(),
    lastVerified: Date.now(),
  });

  const pinned = await aliceStore.getPinnedKey(testPeerId);
  assert(pinned !== null, 'Pinned key stored and retrieved');
  assert(pinned!.publicKeyHash === testPubKeyHash, 'Pinned key hash matches');

  // Verify no pin for unknown peer
  const noPinned = await aliceStore.getPinnedKey('unknown-peer');
  assert(noPinned === null, 'No pinned key for unknown peer');

  // ─── Step 9: Account Bundle ─────────────────────────────────────────────
  console.log('\n9. Testing account bundle build...');

  const { sign } = await import('../crypto/identity.js');
  const aliceIdentity = aliceNode.getIdentity();
  const bundle = await aliceStore.buildAccountBundle(
    aliceNode.getPeerId(),
    (data: Uint8Array) => sign(data, aliceIdentity.privateKey)
  );
  assert(bundle.peerId === aliceNode.getPeerId(), 'Bundle has correct peerId');
  assert(bundle.version === 1, 'Bundle version is 1');
  assert(bundle.signature.length > 0, 'Bundle is signed');

  // ─── Step 10: Shutdown ──────────────────────────────────────────────────
  console.log('\n10. Shutting down...');

  await aliceNode.stop();
  await bobNode.stop();
  await aliceStore.close();
  await bobStore.close();

  assert(true, 'Both nodes shut down cleanly');

  // ─── Results ────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error('Test crashed:', error);
  cleanup();
  process.exit(1);
});
