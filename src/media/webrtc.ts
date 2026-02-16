/**
 * WebRTC Call Manager — Live voice and video calls over P2P
 *
 * In DecentraNet:
 * - Signaling goes through our libp2p overlay (no central signaling server)
 * - We use public STUN servers for NAT discovery
 * - Volunteer peers act as TURN relays (future: incentivized by tokens)
 *
 * Call flow:
 * 1. Alice creates a WebRTC offer (SDP)
 * 2. Alice sends the offer to Bob via libp2p call-signal protocol
 * 3. Bob receives the offer, creates an answer
 * 4. Bob sends the answer back via libp2p
 * 5. Both exchange ICE candidates via libp2p
 * 6. WebRTC establishes direct media connection
 * 7. Voice/video flows peer-to-peer (not through our overlay)
 *
 * NOTE: In Node.js, RTCPeerConnection is not available natively.
 * A mock is used for development. For real calls, run in a browser/Electron
 * environment or install a Node.js WebRTC polyfill (e.g. 'wrtc', '@roamhq/wrtc').
 */

import * as crypto from 'crypto';
import type { CallSignal, CallType, CallState, Identity, PeerId } from '../types/index.js';
import { sign, verify } from '../crypto/identity.js';
import { DecentraNode, PROTOCOLS } from '../network/node.js';

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
  onRemoteStream?: (callId: string, stream: unknown) => void;
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

export class CallManager {
  private node: DecentraNode;
  private identity: Identity;
  private activeCalls: Map<string, ActiveCall> = new Map();
  private handlers: CallEventHandlers = {};
  private peerConnections: Map<string, any> = new Map();

  constructor(node: DecentraNode) {
    this.node = node;
    this.identity = node.getIdentity();

    this.node.on('call:incoming', async (event) => {
      if (event.data) {
        const raw = event.data as any;
        // Skip browser WebRTC relay signals (handled by APIServer instead)
        if (raw.type === 'webrtc_signal') return;
        await this.handleCallSignal(raw as CallSignal);
      }
    });
  }

  setHandlers(handlers: CallEventHandlers): void {
    this.handlers = handlers;
  }

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
      const pc = this.createPeerConnection(callId);
      this.peerConnections.set(callId, pc);

      // Add local media tracks (browser/Electron environments only)
      await this.addLocalMedia(pc, type);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await this.sendCallSignal(remotePeerId, {
        callId,
        from: this.node.getPeerId(),
        to: remotePeerId,
        type,
        signalData: { type: 'offer', sdp: offer.sdp },
        state: 'initiating' as CallState,
        timestamp: Date.now(),
        signature: new Uint8Array(0),
      });

      call.state = 'ringing' as CallState;
      this.activeCalls.set(callId, call);
      return callId;
    } catch (error) {
      this.activeCalls.delete(callId);
      throw error;
    }
  }

  async acceptCall(callId: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call || call.direction !== 'inbound') {
      throw new Error(`No incoming call with ID ${callId}`);
    }

    console.log(`[Call] Accepting call ${callId} from ${call.remotePeerId}`);
    const pc = this.peerConnections.get(callId);
    if (!pc) throw new Error('No peer connection for this call');

    await this.addLocalMedia(pc, call.type);

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

  async endCall(callId: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    console.log(`[Call] Ending call ${callId}`);

    const pc = this.peerConnections.get(callId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(callId);
    }

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

    this.activeCalls.delete(callId);
    this.handlers.onCallEnded?.(callId, 'local_hangup');
  }

  getActiveCalls(): ActiveCall[] {
    return Array.from(this.activeCalls.values());
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private async addLocalMedia(pc: any, type: CallType): Promise<void> {
    // Only works in browser/Electron where navigator.mediaDevices exists
    const nav = globalThis as any;
    if (nav.navigator?.mediaDevices?.getUserMedia) {
      const constraints = {
        audio: true,
        video: type === ('video' as CallType),
      };
      const localStream = await nav.navigator.mediaDevices.getUserMedia(constraints);
      localStream.getTracks().forEach((track: any) => pc.addTrack(track, localStream));
    }
  }

  private async handleCallSignal(signal: CallSignal): Promise<void> {
    const signalData = signal.signalData as any;

    if (!signalData || !signalData.type) {
      console.warn('[Call] Ignoring signal with missing signalData');
      return;
    }

    // Verify sender signature before processing
    const senderProfile = this.node.getKnownPeer(signal.from);
    if (!senderProfile) {
      console.warn(`[Call] Dropping signal from unknown sender ${signal.from}`);
      return;
    }
    const sigBytes = typeof signal.signature === 'string'
      ? new Uint8Array(Buffer.from(signal.signature as string, 'base64'))
      : signal.signature;
    if (!sigBytes || sigBytes.length === 0) {
      console.warn(`[Call] Dropping unsigned signal from ${signal.from}`);
      return;
    }
    const dataToVerify = new TextEncoder().encode(
      JSON.stringify({ ...signal, signature: undefined })
    );
    if (!verify(dataToVerify, sigBytes, senderProfile.publicKey)) {
      console.warn(`[Call] Invalid signature on call signal from ${signal.from} — dropping`);
      return;
    }

    if (signalData.type === 'offer') {
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
      const pc = this.peerConnections.get(signal.callId);
      if (pc) await pc.addIceCandidate(signalData.candidate);

    } else if (signalData.type === 'hangup') {
      const pc = this.peerConnections.get(signal.callId);
      if (pc) {
        pc.close();
        this.peerConnections.delete(signal.callId);
      }
      this.activeCalls.delete(signal.callId);
      this.handlers.onCallEnded?.(signal.callId, 'remote_hangup');
    }
  }

  private createPeerConnection(callId: string): any {
    const g = globalThis as any;
    const RTCPeerConnection = g.RTCPeerConnection || g.webkitRTCPeerConnection;

    if (!RTCPeerConnection) {
      console.warn('[Call] RTCPeerConnection not available — using mock for Node.js dev');
      return createMockPeerConnection();
    }

    const pc = new RTCPeerConnection({
      iceServers: STUN_SERVERS.map((url) => ({ urls: url })),
    });

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

    pc.ontrack = (event: any) => {
      if (event.streams?.[0]) {
        this.handlers.onRemoteStream?.(callId, event.streams[0]);
      }
    };

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

  private async sendCallSignal(remotePeerId: PeerId, signal: CallSignal): Promise<void> {
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
