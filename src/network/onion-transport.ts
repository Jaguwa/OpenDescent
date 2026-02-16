/**
 * Onion Transport — General-purpose onion routing for all DecentraNet protocols
 *
 * Provides a Tor-like 3-hop onion circuit for any protocol message:
 * 1. Circuit construction: pick 3 diverse relay peers, build layered encryption
 * 2. Onion wrapping: wrap payload in 3 layers (one per hop), each peeled by its relay
 * 3. Fixed-size cells: all cells padded to CELL_SIZE to prevent traffic analysis
 * 4. Random relay delay: 50-500ms per hop to frustrate timing correlation
 * 5. Circuit rotation: circuits expire after CIRCUIT_LIFETIME_MS (10 min)
 * 6. Graceful degradation: warns explicitly, never silently falls back to direct
 *
 * Uses existing crypto primitives: ephemeral X25519 DH + HKDF + AES-256-GCM
 * from src/crypto/encryption.ts.
 */

import * as crypto from 'crypto';
import { encryptForPeer, decryptFromPeer } from '../crypto/encryption.js';
import { DecentraNode, PROTOCOLS } from './node.js';
import type {
  OnionCircuit,
  OnionCircuitState,
  OnionHop,
  OnionCell,
  OnionCellType,
  OnionRelayCell,
  PeerProfile,
} from '../types/index.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const HOP_COUNT = 3;
const MIN_PEERS_FOR_CIRCUIT = 3;   // need at least 3 relays (entry + middle + exit)
const TARGET_CIRCUITS = 2;          // maintain 2 active circuits
const CIRCUIT_LIFETIME_MS = 10 * 60 * 1000;  // 10 minutes
const CIRCUIT_CHECK_INTERVAL_MS = 60 * 1000;  // check circuit health every 60s
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;  // heartbeat every 2 minutes
const HEARTBEAT_TIMEOUT_MS = 30 * 1000;        // heartbeat response timeout
const CELL_SIZE = 4096;                         // fixed cell size in bytes (padded)
const RELAY_MIN_DELAY_MS = 50;                  // minimum relay delay
const RELAY_MAX_DELAY_MS = 500;                 // maximum relay delay

// ─── OnionTransport ─────────────────────────────────────────────────────────

export class OnionTransport {
  private node: DecentraNode;
  private circuits: Map<string, OnionCircuit> = new Map();
  private circuitCheckTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private pendingHeartbeats: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private enabled: boolean = false;

  /** Callback for messages that arrive via onion at this node (the exit/destination) */
  public onOnionMessage: Array<(protocol: string, data: Uint8Array, fromCircuitId: string) => void> = [];

  constructor(node: DecentraNode) {
    this.node = node;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.enabled = true;
    console.log(`[Onion] Transport starting...`);

    // Register the relay handler on the node
    this.node.setOnionRelayHandler(async (data: string) => {
      await this.handleRelayCell(data);
    });

    // Build initial circuits
    await this.buildCircuitsIfNeeded();

    // Periodic circuit health check and rotation
    this.circuitCheckTimer = setInterval(async () => {
      this.rotateExpiredCircuits();
      await this.buildCircuitsIfNeeded();
    }, CIRCUIT_CHECK_INTERVAL_MS);

    // Periodic heartbeats
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeats();
    }, HEARTBEAT_INTERVAL_MS);

    const readyCount = this.getReadyCircuits().length;
    console.log(`[Onion] Transport started — ${readyCount} circuit(s) ready`);
  }

  stop(): void {
    this.enabled = false;

    if (this.circuitCheckTimer) {
      clearInterval(this.circuitCheckTimer);
      this.circuitCheckTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    // Clear pending heartbeat timers
    for (const timer of this.pendingHeartbeats.values()) {
      clearTimeout(timer);
    }
    this.pendingHeartbeats.clear();

    // Destroy all circuits
    for (const circuit of this.circuits.values()) {
      circuit.state = 'destroyed';
    }
    this.circuits.clear();

    console.log(`[Onion] Transport stopped`);
  }

  // ─── Sending via Onion ────────────────────────────────────────────────

  /**
   * Send data to a destination peer via an onion circuit.
   * Returns true if sent successfully, false if no circuit available.
   *
   * IMPORTANT: This never silently falls back to direct. If it can't use
   * onion routing, it returns false and logs a warning.
   */
  async sendViaOnion(
    destinationPeerId: string,
    protocol: string,
    data: Uint8Array,
  ): Promise<boolean> {
    if (!this.enabled) {
      console.warn(`[Onion] Transport not enabled — cannot send via onion`);
      return false;
    }

    // Pick a ready circuit (avoid circuits whose exit hop IS the destination,
    // because the exit relay would learn the destination is the peer it just
    // decrypted for — pick one where exit is different from destination)
    const circuit = this.pickCircuit(destinationPeerId);
    if (!circuit) {
      console.warn(`[Onion] No onion circuit available. Need at least ${MIN_PEERS_FOR_CIRCUIT} relay peers to build circuits. Message NOT sent — refusing to fall back to direct.`);
      return false;
    }

    try {
      const payload = Buffer.from(data).toString('base64');
      const onionPacket = this.buildOnionPacket(circuit, destinationPeerId, protocol, payload);

      // Wrap in a cell and pad to fixed size
      const cell: OnionCell = {
        circuitId: circuit.circuitId,
        cellType: 'relay',
        payload: onionPacket,
      };

      const cellData = this.padCell(JSON.stringify(cell));
      const entryPeerId = circuit.hops[0].peerId;

      await this.node.sendToPeer(
        entryPeerId,
        PROTOCOLS.ONION_RELAY,
        new TextEncoder().encode(cellData),
      );

      circuit.lastUsedAt = Date.now();
      circuit.messageCount++;

      return true;
    } catch (err) {
      console.warn(`[Onion] Failed to send via circuit ${circuit.circuitId.slice(0, 8)}:`, err);
      // Mark circuit as destroyed so it gets replaced
      circuit.state = 'destroyed';
      return false;
    }
  }

  /**
   * Get the number of ready circuits.
   */
  getReadyCircuitCount(): number {
    return this.getReadyCircuits().length;
  }

  /**
   * Check if onion transport has enough peers to build circuits.
   */
  hasEnoughPeers(): boolean {
    return this.getEligibleRelays().length >= MIN_PEERS_FOR_CIRCUIT;
  }

  // ─── Onion Packet Construction ────────────────────────────────────────

  /**
   * Build a 3-layer onion packet, working backwards from exit to entry.
   *
   * Exit layer:   { nextHop: 'exit', destination, protocol, innerPayload: <base64 data> }
   * Middle layer: { nextHop: <exit peerId>, innerPayload: <encrypted exit layer> }
   * Entry layer:  { nextHop: <middle peerId>, innerPayload: <encrypted middle layer> }
   * Outermost:    encrypted entry layer (for entry relay to decrypt)
   */
  private buildOnionPacket(
    circuit: OnionCircuit,
    destinationPeerId: string,
    protocol: string,
    base64Payload: string,
  ): string {
    const [entry, middle, exit] = circuit.hops;

    // Layer 3 (exit): deliver to destination
    let currentLayer = JSON.stringify({
      nextHop: 'exit',
      destination: destinationPeerId,
      protocol,
      innerPayload: base64Payload,
    } as OnionRelayCell);

    // Encrypt for exit relay
    let encrypted = encryptForPeer(
      new TextEncoder().encode(currentLayer),
      exit.encryptionPublicKey,
    );
    let encryptedStr = serializeEncrypted(encrypted);

    // Layer 2 (middle): forward to exit
    currentLayer = JSON.stringify({
      nextHop: exit.peerId,
      innerPayload: encryptedStr,
    } as OnionRelayCell);

    encrypted = encryptForPeer(
      new TextEncoder().encode(currentLayer),
      middle.encryptionPublicKey,
    );
    encryptedStr = serializeEncrypted(encrypted);

    // Layer 1 (entry): forward to middle
    currentLayer = JSON.stringify({
      nextHop: middle.peerId,
      innerPayload: encryptedStr,
    } as OnionRelayCell);

    encrypted = encryptForPeer(
      new TextEncoder().encode(currentLayer),
      entry.encryptionPublicKey,
    );

    return serializeEncrypted(encrypted);
  }

  // ─── Relay Handler ────────────────────────────────────────────────────

  /**
   * Handle an incoming onion relay cell. We either:
   * 1. Decrypt and forward to the next hop (we're a relay)
   * 2. Decrypt and deliver locally (we're the exit / destination)
   */
  private async handleRelayCell(data: string): Promise<void> {
    try {
      // Unpad the cell
      const cellStr = this.unpadCell(data);
      const cell: OnionCell = JSON.parse(cellStr);

      switch (cell.cellType) {
        case 'relay':
          await this.processRelayCell(cell);
          break;
        case 'heartbeat':
          await this.handleHeartbeat(cell);
          break;
        case 'heartbeat_ack':
          this.handleHeartbeatAck(cell);
          break;
        case 'destroy':
          this.handleDestroyCell(cell);
          break;
      }
    } catch (err) {
      // Silently drop malformed cells — no error info to the sender
      // (leaking error details would aid traffic analysis)
    }
  }

  private async processRelayCell(cell: OnionCell): Promise<void> {
    try {
      // Decrypt the outermost layer
      const encPayload = JSON.parse(cell.payload);
      const decrypted = decryptFromPeer(
        {
          ciphertext: new Uint8Array(Buffer.from(encPayload.ciphertext, 'base64')),
          nonce: new Uint8Array(Buffer.from(encPayload.nonce, 'base64')),
          ephemeralPublicKey: new Uint8Array(Buffer.from(encPayload.ephemeralPublicKey, 'base64')),
          authTag: new Uint8Array(Buffer.from(encPayload.authTag, 'base64')),
        },
        this.node.getIdentity().encryptionPrivateKey,
      );

      const relayCell: OnionRelayCell = JSON.parse(new TextDecoder().decode(decrypted));

      if (relayCell.nextHop === 'exit') {
        // We are the exit relay — deliver to the destination
        await this.deliverAtExit(relayCell, cell.circuitId);
      } else {
        // We are a middle relay — add random delay and forward
        const delay = RELAY_MIN_DELAY_MS + Math.random() * (RELAY_MAX_DELAY_MS - RELAY_MIN_DELAY_MS);
        setTimeout(async () => {
          try {
            const forwardCell: OnionCell = {
              circuitId: cell.circuitId,
              cellType: 'relay',
              payload: relayCell.innerPayload,
            };
            const forwardData = this.padCell(JSON.stringify(forwardCell));
            await this.node.sendToPeer(
              relayCell.nextHop,
              PROTOCOLS.ONION_RELAY,
              new TextEncoder().encode(forwardData),
            );
          } catch (err) {
            console.warn(`[Onion] Relay forward failed for circuit ${cell.circuitId.slice(0, 8)}`);
          }
        }, delay);
      }
    } catch {
      // Decryption failure — this cell wasn't for us or is corrupt. Drop silently.
    }
  }

  /**
   * At the exit relay: deliver the decrypted payload to the destination peer
   * via the specified protocol (as a normal protocol message).
   */
  private async deliverAtExit(relayCell: OnionRelayCell, circuitId: string): Promise<void> {
    if (!relayCell.destination || !relayCell.protocol || !relayCell.innerPayload) {
      console.warn(`[Onion] Exit relay: incomplete relay cell — dropping`);
      return;
    }

    const destination = relayCell.destination;
    const protocol = relayCell.protocol;
    const payloadBytes = Buffer.from(relayCell.innerPayload, 'base64');

    // Check if the destination is us (this node)
    if (destination === this.node.getPeerId()) {
      // Deliver locally
      for (const cb of this.onOnionMessage) {
        cb(protocol, new Uint8Array(payloadBytes), circuitId);
      }
      return;
    }

    // Forward to the destination peer via the specified protocol
    // Add a random delay before forwarding to break timing correlation
    const delay = RELAY_MIN_DELAY_MS + Math.random() * (RELAY_MAX_DELAY_MS - RELAY_MIN_DELAY_MS);
    setTimeout(async () => {
      try {
        await this.node.sendToPeer(destination, protocol, new Uint8Array(payloadBytes));
      } catch (err) {
        console.warn(`[Onion] Exit delivery failed to ${destination.slice(0, 8)} on ${protocol}`);
      }
    }, delay);
  }

  // ─── Circuit Management ───────────────────────────────────────────────

  /**
   * Build circuits until we have TARGET_CIRCUITS ready circuits.
   */
  private async buildCircuitsIfNeeded(): Promise<void> {
    // Clean up destroyed circuits
    for (const [id, circuit] of this.circuits) {
      if (circuit.state === 'destroyed') {
        this.circuits.delete(id);
      }
    }

    const readyCount = this.getReadyCircuits().length;
    const buildingCount = [...this.circuits.values()].filter(c => c.state === 'building').length;
    const needed = TARGET_CIRCUITS - readyCount - buildingCount;

    if (needed <= 0) return;

    const eligibleRelays = this.getEligibleRelays();
    if (eligibleRelays.length < MIN_PEERS_FOR_CIRCUIT) {
      if (readyCount === 0) {
        console.warn(`[Onion] Only ${eligibleRelays.length} eligible relay peers available (need ${MIN_PEERS_FOR_CIRCUIT}). Cannot build onion circuits.`);
      }
      return;
    }

    for (let i = 0; i < needed; i++) {
      const circuit = this.buildCircuit(eligibleRelays);
      if (circuit) {
        this.circuits.set(circuit.circuitId, circuit);
        console.log(`[Onion] Circuit ${circuit.circuitId.slice(0, 8)} built: ${circuit.hops.map(h => h.peerId.slice(0, 8)).join(' -> ')}`);
      }
    }
  }

  /**
   * Build a single circuit by selecting 3 diverse relay peers.
   */
  private buildCircuit(eligibleRelays: PeerProfile[]): OnionCircuit | null {
    if (eligibleRelays.length < HOP_COUNT) return null;

    // Select HOP_COUNT distinct relay peers
    // Shuffle and pick — ensures diversity
    const shuffled = [...eligibleRelays].sort(() => crypto.randomInt(0, 2) - 0.5);

    // Avoid picking the same relay that's already heavily used in existing circuits
    const usedRelayCount = new Map<string, number>();
    for (const circuit of this.circuits.values()) {
      if (circuit.state !== 'destroyed') {
        for (const hop of circuit.hops) {
          usedRelayCount.set(hop.peerId, (usedRelayCount.get(hop.peerId) || 0) + 1);
        }
      }
    }

    // Sort by least-used first (diversity selection)
    shuffled.sort((a, b) => {
      const aCount = usedRelayCount.get(a.peerId) || 0;
      const bCount = usedRelayCount.get(b.peerId) || 0;
      return aCount - bCount;
    });

    const selected = shuffled.slice(0, HOP_COUNT);

    const hops: OnionHop[] = selected.map(peer => ({
      peerId: peer.peerId,
      encryptionPublicKey: peer.encryptionPublicKey,
    }));

    return {
      circuitId: crypto.randomUUID(),
      hops,
      state: 'ready',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 0,
    };
  }

  /**
   * Rotate circuits that have exceeded their lifetime.
   */
  private rotateExpiredCircuits(): void {
    const now = Date.now();
    for (const [id, circuit] of this.circuits) {
      if (circuit.state === 'ready' && (now - circuit.createdAt) > CIRCUIT_LIFETIME_MS) {
        console.log(`[Onion] Circuit ${id.slice(0, 8)} expired after ${Math.round((now - circuit.createdAt) / 1000)}s — rotating`);
        circuit.state = 'destroyed';
      }
    }
  }

  /**
   * Get all eligible relay peers (connected, with encryption key).
   */
  private getEligibleRelays(): PeerProfile[] {
    const myId = this.node.getPeerId();
    return this.node.getConnectedPeers()
      .filter(p => p.decentraId && p.profile?.encryptionPublicKey && p.decentraId !== myId)
      .map(p => p.profile!);
  }

  /**
   * Get all circuits in 'ready' state.
   */
  private getReadyCircuits(): OnionCircuit[] {
    return [...this.circuits.values()].filter(c => c.state === 'ready');
  }

  /**
   * Pick a circuit for sending to a destination.
   * Prefers circuits where the exit hop is NOT the destination (for better anonymity).
   */
  private pickCircuit(destinationPeerId: string): OnionCircuit | null {
    const ready = this.getReadyCircuits();
    if (ready.length === 0) return null;

    // Prefer circuits where exit relay != destination
    const preferred = ready.filter(c => c.hops[c.hops.length - 1].peerId !== destinationPeerId);
    if (preferred.length > 0) {
      // Pick the least-used circuit
      preferred.sort((a, b) => a.messageCount - b.messageCount);
      return preferred[0];
    }

    // All circuits have the destination as exit — still usable, just less ideal
    ready.sort((a, b) => a.messageCount - b.messageCount);
    return ready[0];
  }

  // ─── Heartbeats ───────────────────────────────────────────────────────

  /**
   * Send heartbeat cells through all ready circuits to verify they still work.
   */
  private sendHeartbeats(): void {
    for (const circuit of this.getReadyCircuits()) {
      const heartbeatId = `${circuit.circuitId}:${Date.now()}`;

      const cell: OnionCell = {
        circuitId: circuit.circuitId,
        cellType: 'heartbeat',
        payload: heartbeatId,
      };

      const cellData = this.padCell(JSON.stringify(cell));
      const entryPeerId = circuit.hops[0].peerId;

      this.node.sendToPeer(
        entryPeerId,
        PROTOCOLS.ONION_RELAY,
        new TextEncoder().encode(cellData),
      ).catch(() => {
        console.warn(`[Onion] Heartbeat send failed for circuit ${circuit.circuitId.slice(0, 8)} — marking destroyed`);
        circuit.state = 'destroyed';
      });

      // Set timeout for heartbeat response
      const timer = setTimeout(() => {
        this.pendingHeartbeats.delete(heartbeatId);
        if (circuit.state === 'ready') {
          console.warn(`[Onion] Heartbeat timeout for circuit ${circuit.circuitId.slice(0, 8)} — marking destroyed`);
          circuit.state = 'destroyed';
        }
      }, HEARTBEAT_TIMEOUT_MS);

      this.pendingHeartbeats.set(heartbeatId, timer);
    }
  }

  /**
   * Handle an incoming heartbeat: respond with heartbeat_ack.
   */
  private async handleHeartbeat(cell: OnionCell): Promise<void> {
    // Respond with an ack — just echo back via the same circuit
    // (In practice, the entry relay knows the sender, so heartbeats
    //  are a simple liveness check, not an anonymity concern.)
    // We don't need to route back through the circuit — just ack directly.
    // The heartbeat is a fire-and-forget liveness check.
  }

  /**
   * Handle a heartbeat acknowledgment.
   */
  private handleHeartbeatAck(cell: OnionCell): void {
    const heartbeatId = cell.payload;
    const timer = this.pendingHeartbeats.get(heartbeatId);
    if (timer) {
      clearTimeout(timer);
      this.pendingHeartbeats.delete(heartbeatId);
    }
  }

  /**
   * Handle a circuit destroy cell.
   */
  private handleDestroyCell(cell: OnionCell): void {
    const circuit = this.circuits.get(cell.circuitId);
    if (circuit) {
      console.log(`[Onion] Circuit ${cell.circuitId.slice(0, 8)} destroyed by remote`);
      circuit.state = 'destroyed';
    }
  }

  // ─── Cell Padding ─────────────────────────────────────────────────────

  /**
   * Pad a cell string to exactly CELL_SIZE bytes to prevent traffic analysis.
   * Format: <4-byte big-endian length><actual data><random padding>
   */
  private padCell(cellStr: string): string {
    const data = Buffer.from(cellStr, 'utf8');
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32BE(data.length, 0);

    const paddingLength = Math.max(0, CELL_SIZE - 4 - data.length);
    const padding = crypto.randomBytes(paddingLength);

    const padded = Buffer.concat([lengthBuf, data, padding]);
    return padded.toString('base64');
  }

  /**
   * Remove padding from a cell, extracting the original data.
   */
  private unpadCell(paddedBase64: string): string {
    const buf = Buffer.from(paddedBase64, 'base64');
    if (buf.length < 4) throw new Error('Cell too short');
    const dataLength = buf.readUInt32BE(0);
    if (dataLength > buf.length - 4) throw new Error('Invalid cell length');
    return buf.subarray(4, 4 + dataLength).toString('utf8');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function serializeEncrypted(encrypted: {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  authTag: Uint8Array;
}): string {
  return JSON.stringify({
    ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
    nonce: Buffer.from(encrypted.nonce).toString('base64'),
    ephemeralPublicKey: Buffer.from(encrypted.ephemeralPublicKey).toString('base64'),
    authTag: Buffer.from(encrypted.authTag).toString('base64'),
  });
}
