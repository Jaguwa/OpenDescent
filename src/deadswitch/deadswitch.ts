/**
 * Dead Man's Switch — Auto-send a pre-written message if the user
 * doesn't check in within a configurable time window.
 */

import * as crypto from 'crypto';
import type { DeadManSwitch, PeerId } from '../types/index.js';
import type { LocalStore } from '../storage/store.js';
import type { MessagingService } from '../messaging/delivery.js';

const MIN_WINDOW_MS = 60 * 60 * 1000;          // 1 hour
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const MAX_RECIPIENTS = 20;
const MAX_MESSAGE_LENGTH = 2_000_000; // 2MB

export class DeadManSwitchService {
  private store: LocalStore;
  private messaging: MessagingService;

  constructor(store: LocalStore, messaging: MessagingService) {
    this.store = store;
    this.messaging = messaging;
  }

  async createSwitch(recipientIds: PeerId[], message: string, windowMs: number): Promise<string> {
    if (recipientIds.length === 0) throw new Error('At least one recipient required');
    if (recipientIds.length > MAX_RECIPIENTS) throw new Error(`Max ${MAX_RECIPIENTS} recipients`);
    if (!message || message.length > MAX_MESSAGE_LENGTH) throw new Error('Message too large (max 2MB)');
    if (!Number.isFinite(windowMs) || windowMs < MIN_WINDOW_MS || windowMs > MAX_WINDOW_MS) {
      throw new Error('Window must be between 1 hour and 30 days');
    }

    const now = Date.now();
    const dms: DeadManSwitch = {
      switchId: crypto.randomUUID(),
      recipientIds,
      message,
      windowMs,
      createdAt: now,
      lastCheckIn: now,
      status: 'armed',
    };

    await this.store.storeDMS(dms);
    console.log(`[DMS] Created switch ${dms.switchId} — ${recipientIds.length} recipients, window ${windowMs / 3600000}h`);
    return dms.switchId;
  }

  async listSwitches(): Promise<(DeadManSwitch & { timeRemaining: number })[]> {
    const all = await this.store.getAllDMS();
    const now = Date.now();
    return all.map(dms => ({
      ...dms,
      timeRemaining: dms.status === 'armed'
        ? Math.max(0, dms.windowMs - (now - dms.lastCheckIn))
        : 0,
    }));
  }

  async checkIn(): Promise<number> {
    const armed = await this.store.getAllArmedDMS();
    const now = Date.now();
    for (const dms of armed) {
      dms.lastCheckIn = now;
      await this.store.updateDMS(dms);
    }
    if (armed.length > 0) {
      console.log(`[DMS] Check-in reset for ${armed.length} switches`);
    }
    return armed.length;
  }

  async disarm(switchId: string): Promise<void> {
    const dms = await this.store.getDMS(switchId);
    if (!dms) throw new Error('Switch not found');
    dms.status = 'disarmed';
    await this.store.updateDMS(dms);
    console.log(`[DMS] Disarmed switch ${switchId}`);
  }

  async deleteSwitch(switchId: string): Promise<void> {
    await this.store.deleteDMS(switchId);
    console.log(`[DMS] Deleted switch ${switchId}`);
  }

  async checkAndTrigger(): Promise<string[]> {
    const armed = await this.store.getAllArmedDMS();
    const now = Date.now();
    const triggered: string[] = [];

    for (const dms of armed) {
      if (now - dms.lastCheckIn >= dms.windowMs) {
        // Trigger: send message to all recipients
        for (const recipientId of dms.recipientIds) {
          try {
            await this.messaging.sendTextMessage(recipientId, dms.message);
          } catch (err) {
            console.warn(`[DMS] Failed to send to ${recipientId}:`, (err as Error).message);
          }
        }
        dms.status = 'triggered';
        await this.store.updateDMS(dms);
        triggered.push(dms.switchId);
        console.log(`[DMS] TRIGGERED switch ${dms.switchId} — sent to ${dms.recipientIds.length} recipients`);
      }
    }

    return triggered;
  }
}
