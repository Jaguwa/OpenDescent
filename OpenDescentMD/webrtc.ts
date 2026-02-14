/**
 * WebRTC Call Manager — Live voice and video calls over P2P
 *
 * WebRTC is inherently peer-to-peer for media, but traditionally needs:
 * 1. A signaling server (to exchange SDP offers/answers and ICE candidates)
 * 2. STUN servers (to discover public IP/port for NAT traversal)
 * 3. TURN servers (to relay media when direct connection fails)
 *
 * In DecentraNet:
 * - Signaling goes through our libp2p overlay (no central signaling server)
 * - We use public STUN servers (Google's, etc.) for NAT discovery
 * - Volunteer peers act as TURN relays (incentivized by tokens, future)
 *
 * Call flow:
 * 1. Alice wants to call Bob
 * 2. Alice creates a WebRTC offer (SDP)
 * 3. Alice sends the offer to Bob via libp2p call-signal protocol
 * 4. Bob receives the offer, creates an answer
 * 5. Bob sends the answer back via libp2p
 * 6. Both exchange ICE candidates via libp2p
 * 7. WebRTC establishes direct media connection
 * 8. Voice/video flows peer-to-peer (not through our network)
 */

import type { CallSignal, CallType, CallState, Identity, PeerId } from '../types/index.js';
import { sign } from '../crypto/identity.js';
import { DecentraNode, PROTOCOLS } from '../network/node.js';

/** Public STUN servers for NAT traversal */
const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun.stunprotocol.org:3478',
];

export interface CallEventHandlers {
  onIncomingCall?: (call: ActiveCall) => void;
  onCallConnected?: (call: ActiveCall) => void;
  onCallEnded?: (callId: string, reason: string) => void;
  onRemoteStream?: (callId: string, stream: MediaStream) => void;
}

export interface ActiveCall {
  callId: string;
  remotePeerId: PeerId;
  type: CallType;
  state: CallState;
  direction: 'inbound' | 'outbound';
  startedAt: number;
  connectedAt?: number;
}

/**
 * Manages WebRTC calls using the P2P network for signaling.
 *
 * NOTE: This module is designed to work in both Node.js (for testing)
 * and browser/Electron environments (where WebRTC APIs are available).
 * In Node.js, you'll need a WebRTC polyfill like 'wrtc' or 'node-webrtc'.
 */
export class CallManager {
  private node: DecentraNode;
  private identity: Identity;
  private activeCalls: Map<string, ActiveCall> = new Map();
  private handlers: CallEventHandlers = {};

  // WebRTC peer connections (keyed by call ID)
  // Using 'any' because the actual RTCPeerConnection type depends on environment
  private peerConnections: Map<string, any> = new Map();

  constructor(node: DecentraNode) {
    this.node = node;
    this.identity = node.getIdentity();

    // Listen for incoming call signals
    this.node.on('call:incoming', async (event) => {
      if (event.data) {
        await this.handleCallSignal(event.data as CallSignal);
      }
    });
  }

  /**
   * Register event handlers for call events.
   */
  setHandlers(handlers: CallEventHandlers): void {
    this.handlers = handlers;
  }

  /**
   * Initiate a voice or video call to a peer.
   */
  async startCall(remotePeerId: PeerId, type: CallType): Promise<string> {
    const callId = crypto.randomUUID();

    console.log(`[Call] Starting ${type} call ${callId} to ${remotePeerId}`);

    const call: ActiveCall = {
      callId,
      remotePeerId,
      type,
      state: 'initiating' as CallState,
      direction: 'outbound',
      startedAt: Date.now(),
    };

    this.activeCalls.set(callId, call);

    try {
      // Create WebRTC peer connection
      const pc = this.createPeerConnection(callId);
      this.peerConnections.set(callId, pc);

      // Add local media tracks
      // In a real implementation, this would access the microphone/camera
      // For Node.js prototype, we skip media track addition
      if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
        const constraints: MediaStreamConstraints = {
          audio: true,
          video: type === ('video' as CallType),
        };
        const localStream = await navigator.mediaDevices.getUserMedia(constraints);
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      }

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Send offer via our P2P signaling
      await this.sendCallSignal(remotePeerId, {
        callId,
        from: this.node.getPeerId(),
        to: remotePeerId,
        type,
        signalData: { type: 'offer', sdp: offer.sdp },
        state: 'initiating' as CallState,
        timestamp: Date.now(),
        signature: new Uint8Array(0), // Will be set in sendCallSignal
      });

      call.state = 'ringing' as CallState;
      this.activeCalls.set(callId, call);

      return callId;
    } catch (error) {
      console.error(`[Call] Failed to start call:`, error);
      this.activeCalls.delete(callId);
      throw error;
    }
  }

  /**
   * Accept an incoming call.
   */
  async acceptCall(callId: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call || call.direction !== 'inbound') {
      throw new Error(`No incoming call with ID ${callId}`);
    }

    console.log(`[Call] Accepting call ${callId} from ${call.remotePeerId}`);

    const pc = this.peerConnections.get(callId);
    if (!pc) throw new Error('No peer connection for this call');

    // Add local media
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      const constraints: MediaStreamConstraints = {
        audio: true,
        video: call.type === ('video' as CallType),
      };
      const localStream = await navigator.mediaDevices.getUserMedia(constraints);
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    // Create and send answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await this.sendCallSignal(call.remotePeerId, {
      callId,
      from: this.node.getPeerId(),
      to: call.remotePeerId,
      type: call.type,
      signalData: { type: 'answer', sdp: answer.sdp },
      state: 'connected' as CallState,
      timestamp: Date.now(),
      signature: new Uint8Array(0),
    });
  }

  /**
   * End a call.
   */
  async endCall(callId: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    console.log(`[Call] Ending call ${callId}`);

    // Close WebRTC connection
    const pc = this.peerConnections.get(callId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(callId);
    }

    // Notify remote peer
    await this.sendCallSignal(call.remotePeerId, {
      callId,
      from: this.node.getPeerId(),
      to: call.remotePeerId,
      type: call.type,
      signalData: { type: 'hangup' },
      state: 'ended' as CallState,
      timestamp: Date.now(),
      signature: new Uint8Array(0),
    });

    call.state = 'ended' as CallState;
    this.activeCalls.delete(callId);
    this.handlers.onCallEnded?.(callId, 'local_hangup');
  }

  /**
   * Get active calls.
   */
  getActiveCalls(): ActiveCall[] {
    return Array.from(this.activeCalls.values());
  }

  // ─── Private ───────────────────────────────────────────────────────────

  /**
   * Handle an incoming call signal from the network.
   */
  private async handleCallSignal(signal: CallSignal): Promise<void> {
    const signalData = signal.signalData as any;

    if (signalData.type === 'offer') {
      // Incoming call
      console.log(`[Call] Incoming ${signal.type} call from ${signal.from}`);

      const pc = this.createPeerConnection(signal.callId);
      this.peerConnections.set(signal.callId, pc);

      await pc.setRemoteDescription({ type: 'offer', sdp: signalData.sdp });

      const call: ActiveCall = {
        callId: signal.callId,
        remotePeerId: signal.from,
        type: signal.type,
        state: 'ringing' as CallState,
        direction: 'inbound',
        startedAt: Date.now(),
      };

      this.activeCalls.set(signal.callId, call);
      this.handlers.onIncomingCall?.(call);

    } else if (signalData.type === 'answer') {
      // Call accepted
      const pc = this.peerConnections.get(signal.callId);
      if (pc) {
        await pc.setRemoteDescription({ type: 'answer', sdp: signalData.sdp });
        const call = this.activeCalls.get(signal.callId);
        if (call) {
          call.state = 'connected' as CallState;
          call.connectedAt = Date.now();
          this.handlers.onCallConnected?.(call);
        }
      }

    } else if (signalData.type === 'ice-candidate') {
      // ICE candidate exchange
      const pc = this.peerConnections.get(signal.callId);
      if (pc) {
        await pc.addIceCandidate(signalData.candidate);
      }

    } else if (signalData.type === 'hangup') {
      // Remote hangup
      const pc = this.peerConnections.get(signal.callId);
      if (pc) {
        pc.close();
        this.peerConnections.delete(signal.callId);
      }
      this.activeCalls.delete(signal.callId);
      this.handlers.onCallEnded?.(signal.callId, 'remote_hangup');
    }
  }

  /**
   * Create a new RTCPeerConnection with our STUN configuration.
   */
  private createPeerConnection(callId: string): any {
    // Check if RTCPeerConnection is available (browser/Electron)
    const RTCPeerConnection =
      (globalThis as any).RTCPeerConnection ||
      (globalThis as any).webkitRTCPeerConnection;

    if (!RTCPeerConnection) {
      console.warn('[Call] RTCPeerConnection not available in this environment');
      console.warn('[Call] Install "wrtc" package for Node.js WebRTC support');
      // Return a mock for Node.js development
      return createMockPeerConnection();
    }

    const pc = new RTCPeerConnection({
      iceServers: STUN_SERVERS.map((url) => ({ urls: url })),
    });

    // Handle ICE candidates — send them to the remote peer
    pc.onicecandidate = async (event: any) => {
      if (event.candidate) {
        const call = this.activeCalls.get(callId);
        if (call) {
          await this.sendCallSignal(call.remotePeerId, {
            callId,
            from: this.node.getPeerId(),
            to: call.remotePeerId,
            type: call.type,
            signalData: { type: 'ice-candidate', candidate: event.candidate },
            state: call.state,
            timestamp: Date.now(),
            signature: new Uint8Array(0),
          });
        }
      }
    };

    // Handle incoming remote media streams
    pc.ontrack = (event: any) => {
      if (event.streams[0]) {
        this.handlers.onRemoteStream?.(callId, event.streams[0]);
      }
    };

    // Connection state changes
    pc.onconnectionstatechange = () => {
      console.log(`[Call] Connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        const call = this.activeCalls.get(callId);
        if (call) {
          call.state = 'connected' as CallState;
          call.connectedAt = Date.now();
          this.handlers.onCallConnected?.(call);
        }
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.activeCalls.delete(callId);
        this.peerConnections.delete(callId);
        this.handlers.onCallEnded?.(callId, pc.connectionState);
      }
    };

    return pc;
  }

  /**
   * Send a call signaling message via our P2P overlay.
   */
  private async sendCallSignal(remotePeerId: PeerId, signal: CallSignal): Promise<void> {
    // Sign the signal
    const dataToSign = new TextEncoder().encode(
      JSON.stringify({ ...signal, signature: undefined })
    );
    signal.signature = sign(dataToSign, this.identity.privateKey);

    const data = new TextEncoder().encode(JSON.stringify({
      ...signal,
      signature: Buffer.from(signal.signature).toString('base64'),
    }));

    await this.node.sendToPeer(remotePeerId, PROTOCOLS.CALL_SIGNAL, data);
  }
}

/**
 * Mock RTCPeerConnection for Node.js development.
 * Replace with 'wrtc' package for actual Node.js WebRTC.
 */
function createMockPeerConnection(): any {
  return {
    createOffer: async () => ({ type: 'offer', sdp: 'mock-sdp-offer' }),
    createAnswer: async () => ({ type: 'answer', sdp: 'mock-sdp-answer' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate: async () => {},
    addTrack: () => {},
    close: () => {},
    onicecandidate: null,
    ontrack: null,
    onconnectionstatechange: null,
    connectionState: 'new',
  };
}
