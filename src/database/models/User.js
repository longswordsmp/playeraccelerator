'use strict';

/**
 * Member record.
 *
 * One document per (guild, user). Holds identity, lifecycle, activity and the
 * denormalised counters that dashboards read — keeping `/statistics` and
 * `/customer` fast without aggregating the whole ticket collection every time.
 */

const { Schema, model } = require('mongoose');

const userSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },

    // ── Identity (denormalised so records survive the user leaving) ──────────
    username: { type: String, default: '' },
    displayName: { type: String, default: '' },
    avatar: { type: String, default: '' },

    // ── Lifecycle ───────────────────────────────────────────────────────────
    accountCreatedAt: { type: Date, default: null },
    firstJoinedAt: { type: Date, default: Date.now },
    lastJoinedAt: { type: Date, default: Date.now },
    leftAt: { type: Date, default: null },
    joinCount: { type: Number, default: 1 },
    inGuild: { type: Boolean, default: true },

    // ── Status flags ────────────────────────────────────────────────────────
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
    isCustomer: { type: Boolean, default: false },
    isVip: { type: Boolean, default: false },
    isStaff: { type: Boolean, default: false },
    customerSince: { type: Date, default: null },

    // ── Denormalised counters ───────────────────────────────────────────────
    stats: {
      totalTickets: { type: Number, default: 0 },
      openTickets: { type: Number, default: 0 },
      totalOrders: { type: Number, default: 0 },
      completedOrders: { type: Number, default: 0 },
      cancelledOrders: { type: Number, default: 0 },
      reviewsSubmitted: { type: Number, default: 0 },
      averageRatingGiven: { type: Number, default: 0 },
      messagesSent: { type: Number, default: 0 },
      totalSpent: { type: Number, default: 0 },
    },

    // ── Moderation summary (details live in the Moderation collection) ──────
    moderation: {
      activeWarnings: { type: Number, default: 0 },
      totalWarnings: { type: Number, default: 0 },
      timeouts: { type: Number, default: 0 },
      kicks: { type: Number, default: 0 },
      bans: { type: Number, default: 0 },
      lastActionAt: { type: Date, default: null },
      /** Raised by the account-safety heuristics on join. */
      flagged: { type: Boolean, default: false },
      flagReason: { type: String, default: '' },
    },

    // ── Referrals ───────────────────────────────────────────────────────────
    referrals: {
      /** Who invited this member, resolved at join time. */
      invitedBy: { type: String, default: null },
      /** The invite code they arrived through. */
      inviteCode: { type: String, default: '' },
      /** Invitees who joined through this member and still count. */
      credited: [
        {
          userId: { type: String, required: true },
          username: { type: String, default: '' },
          joinedAt: { type: Date, default: Date.now },
          /** Cleared if they leave inside the grace window. */
          revoked: { type: Boolean, default: false },
          revokedReason: { type: String, default: '' },
        },
      ],
      /** Denormalised count of non-revoked credits. */
      count: { type: Number, default: 0 },
      /** Set once the free-commission threshold has been reached. */
      unlockedFreeCommission: { type: Boolean, default: false },
      unlockedAt: { type: Date, default: null },
      /** Free commissions already claimed against this progress. */
      freeCommissionsUsed: { type: Number, default: 0 },
    },

    /** Free-form staff notes attached to the member. */
    notes: [
      {
        content: { type: String, required: true },
        authorId: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    lastActivityAt: { type: Date, default: Date.now, index: true },
    lastTicketAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.index({ guildId: 1, userId: 1 }, { unique: true });
userSchema.index({ guildId: 1, isCustomer: 1, 'stats.completedOrders': -1 });
userSchema.index({ guildId: 1, lastActivityAt: -1 });
userSchema.index({ guildId: 1, 'referrals.count': -1 });
userSchema.index({ guildId: 1, 'referrals.invitedBy': 1 });

/**
 * Fetch or create the record for a member.
 * @param {string} guildId
 * @param {import('discord.js').User|{id: string, username?: string}} user
 * @param {object} [extra] additional fields applied on insert
 */
userSchema.statics.resolve = async function resolve(guildId, user, extra = {}) {
  const userId = typeof user === 'string' ? user : user.id;
  const identity = typeof user === 'string' ? {} : {
    username: user.username ?? user.tag ?? '',
    displayName: user.globalName ?? user.displayName ?? user.username ?? '',
    avatar: typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 128 }) : '',
    accountCreatedAt: user.createdAt ?? null,
  };

  return this.findOneAndUpdate(
    { guildId, userId },
    {
      $set: { ...identity, ...extra, lastActivityAt: new Date() },
      $setOnInsert: { guildId, userId, firstJoinedAt: new Date() },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
};

/** Increment one or more counters atomically. */
userSchema.statics.bump = function bump(guildId, userId, increments) {
  return this.updateOne(
    { guildId, userId },
    { $inc: increments, $set: { lastActivityAt: new Date() } },
    { upsert: true },
  );
};

/** Promote to customer on first completed order. */
userSchema.methods.markCustomer = function markCustomer() {
  if (!this.isCustomer) {
    this.isCustomer = true;
    this.customerSince = new Date();
  }
  return this;
};

module.exports = model('User', userSchema);
