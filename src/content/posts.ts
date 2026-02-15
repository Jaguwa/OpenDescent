/**
 * Post Service — Gossip-based post broadcasting and timeline management
 *
 * Posts propagate through the network using a gossip protocol:
 * - Each post has hopCount and maxHops (default 3)
 * - Receiving peer stores, re-gossips if hopCount < maxHops
 * - Dedup via seenPostIds set (pruned for posts > 24h old)
 */

import * as crypto from 'crypto';
import type { DecentraNode } from '../network/node.js';
import { PROTOCOLS } from '../network/node.js';
import type { LocalStore } from '../storage/store.js';
import type { Post, PostReaction, PostComment, PeerId } from '../types/index.js';

export class PostService {
  private node: DecentraNode;
  private store: LocalStore;
  private seenPostIds: Map<string, number> = new Map(); // postId -> timestamp
  private onPostCallbacks: ((post: Post) => void)[] = [];
  private onInteractionCallbacks: ((data: { type: string; postId: string; authorId: string }) => void)[] = [];

  constructor(node: DecentraNode, store: LocalStore) {
    this.node = node;
    this.store = store;

    // Wire protocol handlers
    this.node.setPostBroadcastHandler(async (data: string) => {
      await this.handleIncomingPost(data);
    });

    this.node.setPostInteractionHandler(async (data: string) => {
      return this.handleInteraction(data);
    });

    // Prune seen posts every 10 minutes
    setInterval(() => this.pruneSeenPosts(), 10 * 60 * 1000);
  }

  onPost(callback: (post: Post) => void): void {
    this.onPostCallbacks.push(callback);
  }

  onInteraction(callback: (data: { type: string; postId: string; authorId: string }) => void): void {
    this.onInteractionCallbacks.push(callback);
  }

  async createPost(content: string, mediaAttachments: Post['mediaAttachments'] = []): Promise<Post> {
    const post: Post = {
      postId: crypto.randomUUID(),
      authorId: this.node.getPeerId(),
      authorName: this.node.getIdentity().displayName,
      content,
      mediaAttachments,
      timestamp: Date.now(),
      signature: '', // simplified — in production, sign with Ed25519
      likeCount: 0,
      commentCount: 0,
      liked: false,
      hopCount: 0,
      maxHops: 3,
    };

    // Store locally
    await this.store.storePost(post);
    this.seenPostIds.set(post.postId, post.timestamp);

    // Broadcast to peers
    await this.broadcastPost(post);

    return post;
  }

  private async broadcastPost(post: Post): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(post));
    await this.node.broadcastToAll(PROTOCOLS.POST_BROADCAST, data);
  }

  private async handleIncomingPost(data: string): Promise<void> {
    try {
      const post: Post = JSON.parse(data);

      // Dedup check
      if (this.seenPostIds.has(post.postId)) return;
      this.seenPostIds.set(post.postId, post.timestamp);

      // Store locally
      await this.store.storePost(post);

      // Notify UI
      for (const cb of this.onPostCallbacks) cb(post);

      // Re-gossip if under max hops
      if (post.hopCount < post.maxHops) {
        const forwarded = { ...post, hopCount: post.hopCount + 1 };
        const fwdData = new TextEncoder().encode(JSON.stringify(forwarded));
        await this.node.broadcastToAll(PROTOCOLS.POST_BROADCAST, fwdData);
      }
    } catch (error) {
      console.error('[PostService] Error handling incoming post:', error);
    }
  }

  async likePost(postId: string): Promise<void> {
    const myId = this.node.getPeerId();
    const existing = await this.store.getReaction(postId, myId);
    if (existing) return; // already liked

    const reaction: PostReaction = {
      reactionId: crypto.randomUUID(),
      postId,
      authorId: myId,
      type: 'like',
      timestamp: Date.now(),
      signature: '',
    };

    await this.store.storeReaction(reaction);

    // Update post like count locally
    const post = await this.store.getPost(postId);
    if (post) {
      post.likeCount = (post.likeCount || 0) + 1;
      post.liked = true;
      await this.store.storePost(post);
    }

    // Send interaction to peers
    const data = new TextEncoder().encode(JSON.stringify({
      type: 'like',
      reaction,
    }));
    await this.node.broadcastToAll(PROTOCOLS.POST_INTERACTION, data);
  }

  async unlikePost(postId: string): Promise<void> {
    const myId = this.node.getPeerId();
    await this.store.deleteReaction(postId, myId);

    const post = await this.store.getPost(postId);
    if (post) {
      post.likeCount = Math.max(0, (post.likeCount || 0) - 1);
      post.liked = false;
      await this.store.storePost(post);
    }

    const data = new TextEncoder().encode(JSON.stringify({
      type: 'unlike',
      postId,
      authorId: myId,
    }));
    await this.node.broadcastToAll(PROTOCOLS.POST_INTERACTION, data);
  }

  async commentOnPost(postId: string, content: string): Promise<PostComment> {
    const comment: PostComment = {
      commentId: crypto.randomUUID(),
      postId,
      authorId: this.node.getPeerId(),
      authorName: this.node.getIdentity().displayName,
      content,
      timestamp: Date.now(),
      signature: '',
    };

    await this.store.storeComment(comment);

    // Update post comment count
    const post = await this.store.getPost(postId);
    if (post) {
      post.commentCount = (post.commentCount || 0) + 1;
      await this.store.storePost(post);
    }

    // Broadcast
    const data = new TextEncoder().encode(JSON.stringify({
      type: 'comment',
      comment,
    }));
    await this.node.broadcastToAll(PROTOCOLS.POST_INTERACTION, data);

    return comment;
  }

  private async handleInteraction(data: string): Promise<string> {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'like') {
        const reaction: PostReaction = msg.reaction;
        const existing = await this.store.getReaction(reaction.postId, reaction.authorId);
        if (!existing) {
          await this.store.storeReaction(reaction);
          const post = await this.store.getPost(reaction.postId);
          if (post) {
            post.likeCount = (post.likeCount || 0) + 1;
            await this.store.storePost(post);
          }
          for (const cb of this.onInteractionCallbacks) cb({ type: 'like', postId: reaction.postId, authorId: reaction.authorId });
        }
      } else if (msg.type === 'unlike') {
        await this.store.deleteReaction(msg.postId, msg.authorId);
        const post = await this.store.getPost(msg.postId);
        if (post) {
          post.likeCount = Math.max(0, (post.likeCount || 0) - 1);
          await this.store.storePost(post);
        }
        for (const cb of this.onInteractionCallbacks) cb({ type: 'unlike', postId: msg.postId, authorId: msg.authorId });
      } else if (msg.type === 'comment') {
        const comment: PostComment = msg.comment;
        await this.store.storeComment(comment);
        const post = await this.store.getPost(comment.postId);
        if (post) {
          post.commentCount = (post.commentCount || 0) + 1;
          await this.store.storePost(post);
        }
        for (const cb of this.onInteractionCallbacks) cb({ type: 'comment', postId: comment.postId, authorId: comment.authorId });
      }

      return 'OK';
    } catch (error) {
      console.error('[PostService] Error handling interaction:', error);
      return 'ERROR';
    }
  }

  private pruneSeenPosts(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [postId, ts] of this.seenPostIds) {
      if (ts < cutoff) this.seenPostIds.delete(postId);
    }
  }
}
