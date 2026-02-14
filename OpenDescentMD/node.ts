/**
 * Network Node — Core libp2p node setup and management
 *
 * This is the heart of the P2P network. Each running instance of DecentraNet
 * creates one of these nodes. It handles:
 *
 * - Peer discovery (mDNS for local, DHT for global, bootstrap for initial)
 * - Encrypted connections between peers (Noise protocol)
 * - Stream multiplexing (Yamux) — multiple logical streams over one connection
 * - NAT traversal via circuit relay
 * - Custom protocol handlers for our application messages
 */

import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { mdns } from '@libp2p/mdns';
import { kadDHT } from '@libp2p/kad-dht';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';

import type { NodeConfig, Identity, PeerProfile, NetworkEvent, NetworkEventType } from '../types/index.js';
import { generateIdentity, loadIdentity, saveIdentity, publicKeyToPeerId, createPeerProfile } from '../crypto/identity.js';

// Our custom protocol IDs
const PROTOCOL_PREFIX = '/decentranet';
export const PROTOCOLS = {
  MESSAGE: `${PROTOCOL_PREFIX}/message/1.0.0`,
  SHARD_STORE: `${PROTOCOL_PREFIX}/shard-store/1.0.0`,
  SHARD_RETRIEVE: `${PROTOCOL_PREFIX}/shard-retrieve/1.0.0`,
  CALL_SIGNAL: `${PROTOCOL_PREFIX}/call-signal/1.0.0`,
  PEER_EXCHANGE: `${PROTOCOL_PREFIX}/peer-exchange/1.0.0`,
} as const;

type EventHandler = (event: NetworkEvent) => void;

export class DecentraNode {
  private node: Libp2p | null = null;
  private config: NodeConfig;
  private identity: Identity;
  private eventHandlers: Map<NetworkEventType, EventHandler[]> = new Map();
  private knownPeers: Map<string, PeerProfile> = new Map();

  constructor(config: NodeConfig) {
    this.config = config;

    // Load or generate identity
    try {
      this.identity = loadIdentity(config.identityPath, 'default-passphrase');
      console.log(`[Identity] Loaded existing identity`);
    } catch {
      console.log(`[Identity] Generating new identity...`);
      this.identity = generateIdentity(config.displayName);
      saveIdentity(this.identity, config.identityPath, 'default-passphrase');
    }

    console.log(`[Identity] Peer ID: ${this.getPeerId()}`);
    if (this.identity.displayName) {
      console.log(`[Identity] Display name: ${this.identity.displayName}`);
    }
  }

  /**
   * Start the P2P node and begin listening for connections.
   */
  async start(): Promise<void> {
    console.log(`[Node] Starting on port ${this.config.port}...`);

    const libp2pConfig: any = {
      addresses: {
        listen: [
          `/ip4/0.0.0.0/tcp/${this.config.port}`,
          // Also listen on WebSocket for browser compatibility (future)
          // `/ip4/0.0.0.0/tcp/${this.config.port + 1000}/ws`,
        ],
      },

      transports: [
        tcp(),
        circuitRelayTransport({ discoverRelays: 1 }),
      ],

      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],

      services: {
        identify: identify(),
        dht: kadDHT({
          // Run as both client and server
          clientMode: false,
        }),
      },

      peerDiscovery: [
        // Local network discovery
        mdns(),
      ],
    };

    // Add bootstrap peers if provided
    if (this.config.bootstrapPeers.length > 0) {
      libp2pConfig.peerDiscovery.push(
        bootstrap({ list: this.config.bootstrapPeers })
      );
    }

    // Enable relay server if configured
    if (this.config.enableRelay) {
      libp2pConfig.services.relay = circuitRelayServer();
    }

    this.node = await createLibp2p(libp2pConfig);

    // Register event handlers
    this.setupEventListeners();

    // Register custom protocol handlers
    await this.registerProtocolHandlers();

    await this.node.start();

    const addresses = this.node.getMultiaddrs();
    console.log(`[Node] Listening on:`);
    addresses.forEach((addr) => console.log(`  ${addr.toString()}`));
    console.log(`[Node] Node started successfully`);
  }

  /**
   * Stop the node gracefully.
   */
  async stop(): Promise<void> {
    if (this.node) {
      console.log(`[Node] Shutting down...`);
      await this.node.stop();
      console.log(`[Node] Stopped`);
    }
  }

  /**
   * Get our Peer ID (derived from public key).
   */
  getPeerId(): string {
    return publicKeyToPeerId(this.identity.publicKey);
  }

  /**
   * Get the underlying libp2p node (for advanced operations).
   */
  getLibp2p(): Libp2p {
    if (!this.node) throw new Error('Node not started');
    return this.node;
  }

  /**
   * Get our identity.
   */
  getIdentity(): Identity {
    return this.identity;
  }

  /**
   * Get our multiaddresses (how other peers can connect to us).
   */
  getAddresses(): string[] {
    if (!this.node) return [];
    return this.node.getMultiaddrs().map((addr) => addr.toString());
  }

  /**
   * Get our signed peer profile.
   */
  getProfile(): PeerProfile {
    return createPeerProfile(this.identity, this.getAddresses());
  }

  /**
   * Get all connected peers.
   */
  getConnectedPeers(): string[] {
    if (!this.node) return [];
    return this.node.getPeers().map((p) => p.toString());
  }

  /**
   * Subscribe to network events.
   */
  on(event: NetworkEventType, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  /**
   * Emit a network event to subscribers.
   */
  private emit(type: NetworkEventType, data?: unknown, peerId?: string): void {
    const event: NetworkEvent = { type, data, peerId, timestamp: Date.now() };
    const handlers = this.eventHandlers.get(type) || [];
    handlers.forEach((h) => h(event));
  }

  /**
   * Send raw data to a specific peer using a specific protocol.
   */
  async sendToPeer(peerId: string, protocol: string, data: Uint8Array): Promise<Uint8Array | null> {
    if (!this.node) throw new Error('Node not started');

    try {
      // Look up the peer in the DHT or known peers
      const connections = this.node.getConnections();
      const peerConnection = connections.find(
        (conn) => conn.remotePeer.toString() === peerId
      );

      if (!peerConnection) {
        console.log(`[Node] No active connection to ${peerId}, attempting to dial...`);
        // In a full implementation, we'd look up the peer's address in the DHT
        // and dial them. For now, we need a direct connection.
        return null;
      }

      const stream = await this.node.dialProtocol(peerConnection.remotePeer, protocol);

      // Write request
      const writer = stream.writable.getWriter();
      await writer.write(data);
      await writer.close();

      // Read response
      const reader = stream.readable.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value.subarray());
      }

      return chunks.length > 0 ? concatenateUint8Arrays(chunks) : null;
    } catch (error) {
      console.error(`[Node] Failed to send to ${peerId}:`, error);
      return null;
    }
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  private setupEventListeners(): void {
    if (!this.node) return;

    this.node.addEventListener('peer:connect', (event) => {
      const peerId = event.detail.toString();
      console.log(`[Node] Peer connected: ${peerId}`);
      this.emit('peer:connected', undefined, peerId);
    });

    this.node.addEventListener('peer:disconnect', (event) => {
      const peerId = event.detail.toString();
      console.log(`[Node] Peer disconnected: ${peerId}`);
      this.emit('peer:disconnected', undefined, peerId);
    });

    this.node.addEventListener('peer:discovery', (event) => {
      const peerId = event.detail.id.toString();
      console.log(`[Node] Discovered peer: ${peerId}`);
    });
  }

  private async registerProtocolHandlers(): Promise<void> {
    if (!this.node) return;

    // Message delivery protocol
    await this.node.handle(PROTOCOLS.MESSAGE, async ({ stream, connection }) => {
      const peerId = connection.remotePeer.toString();
      console.log(`[Protocol] Incoming message from ${peerId}`);

      try {
        const reader = stream.readable.getReader();
        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value.subarray());
        }

        const data = concatenateUint8Arrays(chunks);
        this.emit('message:received', data, peerId);

        // Send ACK
        const writer = stream.writable.getWriter();
        await writer.write(new TextEncoder().encode('ACK'));
        await writer.close();
      } catch (error) {
        console.error(`[Protocol] Error handling message:`, error);
      }
    });

    // Shard storage protocol
    await this.node.handle(PROTOCOLS.SHARD_STORE, async ({ stream, connection }) => {
      const peerId = connection.remotePeer.toString();
      console.log(`[Protocol] Shard store request from ${peerId}`);

      try {
        const reader = stream.readable.getReader();
        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value.subarray());
        }

        const data = concatenateUint8Arrays(chunks);
        this.emit('shard:stored', data, peerId);

        // ACK that we stored the shard
        const writer = stream.writable.getWriter();
        await writer.write(new TextEncoder().encode('STORED'));
        await writer.close();
      } catch (error) {
        console.error(`[Protocol] Error storing shard:`, error);
      }
    });

    // Shard retrieval protocol
    await this.node.handle(PROTOCOLS.SHARD_RETRIEVE, async ({ stream, connection }) => {
      const peerId = connection.remotePeer.toString();
      console.log(`[Protocol] Shard retrieve request from ${peerId}`);

      try {
        const reader = stream.readable.getReader();
        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value.subarray());
        }

        const shardId = new TextDecoder().decode(concatenateUint8Arrays(chunks));
        this.emit('shard:requested', shardId, peerId);

        // In a full implementation, we'd look up the shard in local storage
        // and send it back. For now, send a placeholder response.
        const writer = stream.writable.getWriter();
        await writer.write(new TextEncoder().encode('SHARD_NOT_FOUND'));
        await writer.close();
      } catch (error) {
        console.error(`[Protocol] Error retrieving shard:`, error);
      }
    });

    // Call signaling protocol
    await this.node.handle(PROTOCOLS.CALL_SIGNAL, async ({ stream, connection }) => {
      const peerId = connection.remotePeer.toString();
      console.log(`[Protocol] Call signal from ${peerId}`);

      try {
        const reader = stream.readable.getReader();
        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value.subarray());
        }

        const data = concatenateUint8Arrays(chunks);
        const signal = JSON.parse(new TextDecoder().decode(data));
        this.emit('call:incoming', signal, peerId);

        const writer = stream.writable.getWriter();
        await writer.write(new TextEncoder().encode('SIGNAL_RECEIVED'));
        await writer.close();
      } catch (error) {
        console.error(`[Protocol] Error handling call signal:`, error);
      }
    });

    console.log(`[Protocol] Registered handlers for: ${Object.values(PROTOCOLS).join(', ')}`);
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function concatenateUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
