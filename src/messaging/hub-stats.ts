/**
 * Hub Stats Service — Computes power scores, tiers, achievements, and leaderboard rankings
 */

import type { HubStats, HubTier, HubAchievementId, HubContributor } from '../types/index.js';
import { LocalStore } from '../storage/store.js';
import type { HubManager } from './hubs.js';

export class HubStatsService {
  private store: LocalStore;
  private hubs: HubManager;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(store: LocalStore, hubs: HubManager) {
    this.store = store;
    this.hubs = hubs;
  }

  start(): void {
    this.recomputeAll().catch(() => {});
    this.interval = setInterval(() => this.recomputeAll().catch(() => {}), 5 * 60 * 1000);
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private async recomputeAll(): Promise<void> {
    const hubs = this.hubs.getHubs();
    for (const hub of hubs) {
      try { await this.computeHubStats(hub.hubId); } catch {}
    }
  }

  async computeHubStats(hubId: string): Promise<HubStats> {
    const members = await this.store.getHubMembers(hubId);
    const channels = await this.store.getHubChannels(hubId);
    const textChannelIds = channels.filter(c => c.type === 'text').map(c => c.channelId);
    const hub = this.hubs.getHubs().find(h => h.hubId === hubId);

    const now = Date.now();
    const dayMs = 86400000;
    const weekMs = 7 * dayMs;
    const weekAgo = now - weekMs;
    const todayStart = now - dayMs;

    // Message counts by member (this week)
    const memberMsgCounts = await this.store.countHubMessagesByMember(hubId, textChannelIds, weekAgo);
    const messagesToday = await this.store.countHubMessages(hubId, textChannelIds, todayStart);
    const messagesThisWeek = Array.from(memberMsgCounts.values()).reduce((a, b) => a + b, 0);
    const messagesPerDay = Math.round((messagesThisWeek / 7) * 10) / 10;

    // Active members = members who sent at least 1 message this week
    const activeMembersWeek = memberMsgCounts.size;

    // Daily sparkline
    const dailyMessageCounts = await this.store.countHubDailyMessages(hubId, textChannelIds, 7);

    // Member count a week ago (members with joinedAt before weekAgo)
    const memberCountWeekAgo = members.filter(m => m.joinedAt <= weekAgo).length;

    // Trust density: fraction of members who have at least one vouch received
    let vouchedMembers = 0;
    for (const m of members) {
      const vouches = await this.store.getVouchesFor(m.peerId);
      if (vouches.length > 0) vouchedMembers++;
    }
    const trustDensity = members.length > 0 ? vouchedMembers / members.length : 0;

    // Preserve accumulated voice minutes from previous stats
    const prevStats = await this.store.getHubStats(hubId);
    const voiceMinutesTotal = prevStats?.voiceMinutesTotal || 0;

    // Top contributors (top 5 by message count)
    const topContributors: HubContributor[] = Array.from(memberMsgCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([peerId, count]) => {
        const member = members.find(m => m.peerId === peerId);
        return { peerId, displayName: member?.displayName || peerId.slice(0, 8), messageCount: count };
      });

    // Achievements
    const achievements: HubAchievementId[] = [];
    const newMembersThisWeek = members.filter(m => m.joinedAt > weekAgo).length;
    if (newMembersThisWeek >= 10) achievements.push('rising_star');
    if (members.length > 0 && activeMembersWeek / members.length > 0.8) achievements.push('tight_knit');
    if (messagesThisWeek >= 1000) achievements.push('chatterbox');
    if (voiceMinutesTotal >= 6000) achievements.push('voice_hub'); // 100 hours = 6000 minutes
    if (trustDensity > 0.5) achievements.push('trusted_circle');
    if (hub && (now - hub.createdAt) > 30 * dayMs) achievements.push('veteran');
    if (members.length >= 50) achievements.push('crowded_house');

    // Power Score (0-10000)
    const totalMembers = members.length;
    const clamp = (v: number, max: number) => Math.min(v, max);
    const log2Safe = (v: number) => Math.log2(v + 1);

    const activeScore = (log2Safe(clamp(activeMembersWeek, 100)) / log2Safe(101)) * 2000;
    const velocityScore = (log2Safe(clamp(messagesPerDay, 500)) / log2Safe(501)) * 2000;
    const retentionScore = totalMembers > 0 ? (activeMembersWeek / totalMembers) * 2000 : 0;
    const trustScore = trustDensity * 2000;
    const growthRate = memberCountWeekAgo > 0
      ? (totalMembers - memberCountWeekAgo) / memberCountWeekAgo
      : (totalMembers > 0 ? 2 : 0);
    const growthScore = (clamp(growthRate, 2) / 2) * 2000;

    const powerScore = Math.round(activeScore + velocityScore + retentionScore + trustScore + growthScore);

    // Tier
    let tier: HubTier;
    if (powerScore >= 8000) tier = 'Diamond';
    else if (powerScore >= 5000) tier = 'Platinum';
    else if (powerScore >= 2500) tier = 'Gold';
    else if (powerScore >= 1000) tier = 'Silver';
    else tier = 'Bronze';

    // Level (1-100)
    const level = Math.max(1, Math.min(100, Math.ceil(powerScore / 100)));

    const stats: HubStats = {
      hubId, totalMembers, activeMembersWeek, messagesToday, messagesThisWeek,
      messagesPerDay, dailyMessageCounts, voiceMinutesTotal, memberCountWeekAgo,
      trustDensity, topContributors, achievements, powerScore, tier, level,
      computedAt: now,
    };

    await this.store.storeHubStats(stats);
    return stats;
  }

  async getStats(hubId: string): Promise<HubStats | null> {
    const cached = await this.store.getHubStats(hubId);
    if (cached && Date.now() - cached.computedAt < 10 * 60 * 1000) return cached;
    try { return await this.computeHubStats(hubId); } catch { return cached; }
  }
}
