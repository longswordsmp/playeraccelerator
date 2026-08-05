'use strict';

/**
 * Default guild configuration.
 *
 * This object is deep-merged into every guild's `Configuration` document, which
 * means: adding a new option here automatically rolls out to existing guilds
 * with a safe default, and removing one never breaks stored data.
 *
 * Everything that a studio might reasonably want to change lives here and is
 * editable at runtime through `/config`.
 */

const { COLORS, BRAND } = require('./branding');

/** Punishment vocabulary shared by every automod module. */
const ACTIONS = Object.freeze(['none', 'delete', 'warn', 'timeout', 'kick', 'ban']);

/** Helper producing a consistently shaped automod module. */
const mod = (enabled, action, threshold, extra = {}) => ({
  enabled,
  action,
  threshold,
  /** Delete the offending message in addition to the punishment. */
  deleteMessage: true,
  /** Timeout duration in minutes when `action` is `timeout`. */
  duration: 10,
  ...extra,
});

const DEFAULT_CONFIG = {
  // ── Identity ───────────────────────────────────────────────────────────────
  brand: {
    name: BRAND.name,
    /** Applied to the guild itself by /setup. */
    serverName: BRAND.serverName,
    /** Guild description — only accepted by Discord on Community servers. */
    description: BRAND.description,
    tagline: BRAND.tagline,
    slogan: BRAND.slogan,
    footer: BRAND.footer,
    logoUrl: BRAND.logoUrl,
    bannerUrl: BRAND.bannerUrl,
    websiteUrl: BRAND.websiteUrl,
  },

  theme: {
    primary: COLORS.primary,
    accent: COLORS.accent,
    success: COLORS.success,
    warning: COLORS.warning,
    danger: COLORS.danger,
    info: COLORS.info,
    /**
     * Attach the per-panel header artwork from `brand/panels/` to each public
     * panel. Turn off if you would rather the panels stayed text-only, or if
     * the extra upload per refresh is unwelcome on a metered host.
     */
    panelImages: true,
  },

  // ── Wiring produced by /setup ──────────────────────────────────────────────
  /** roleKey -> role id */
  roles: {},
  /** channelKey -> channel id */
  channels: {},
  /** categoryKey -> category id */
  categories: {},
  /** logKey -> channel id */
  logChannels: {},
  /** panelKey -> { channelId, messageId } so panels can be refreshed in place */
  panels: {},

  setup: {
    completed: false,
    completedAt: null,
    completedBy: null,
    version: 1,
  },

  // ── Tickets ────────────────────────────────────────────────────────────────
  tickets: {
    enabled: true,
    /** Naming pattern. {number} {user} {type} are substituted. */
    nameFormat: 'ticket-{number}',
    /** Maximum simultaneously open tickets per member. */
    maxOpenPerUser: 3,
    /** Ping the support role when a ticket opens. */
    pingSupport: true,
    /** Open the project form modal automatically after creation. */
    autoOpenForm: true,
    /** Ask for a review when a completed ticket closes. */
    requestReview: true,
    /** Generate an HTML transcript on close. */
    transcripts: true,
    /** Also write a Markdown transcript alongside the HTML one. */
    markdownTranscripts: false,
    /** Move the channel to the archive category on close instead of deleting. */
    archiveOnClose: true,
    /** Auto-delete an archived ticket after N days (0 disables). */
    autoDeleteArchivedAfterDays: 30,
    /** Close inactive tickets automatically after N hours (0 disables). */
    inactivityCloseHours: 0,
    /** Warn before auto-closing, N hours of inactivity. */
    inactivityWarnHours: 0,
    /** Default priority applied to new tickets. */
    defaultPriority: 'normal',
    /** Ticket type keys that are currently accepting submissions. */
    enabledTypes: [],
    /** Public claim announcements inside the ticket. */
    announceClaims: true,
  },

  // ── Business operations ────────────────────────────────────────────────────
  business: {
    /**
     * IANA name, not a fixed offset. `America/New_York` is EST in winter and
     * EDT in summer, so "12 PM" stays 12 PM local across the DST switch —
     * which a hard-coded `UTC-5` would not.
     */
    timezone: 'America/New_York',
    /**
     * 0 = Sunday … 6 = Saturday. `null` means closed.
     * Open every day, 12:00–21:00. Everything outside that window is closed,
     * and the status panel switches itself to "away" automatically.
     */
    hours: {
      0: { open: '12:00', close: '21:00' },
      1: { open: '12:00', close: '21:00' },
      2: { open: '12:00', close: '21:00' },
      3: { open: '12:00', close: '21:00' },
      4: { open: '12:00', close: '21:00' },
      5: { open: '12:00', close: '21:00' },
      6: { open: '12:00', close: '21:00' },
    },
    /** Target first-response time in minutes, used for SLA reporting. */
    responseTargetMinutes: 240,
    /** Shown when the studio is closed. */
    outOfHoursMessage: 'We are currently outside office hours (12 PM – 9 PM Eastern, daily). Your ticket is logged and will be answered when we reopen.',
    currency: 'USD',
    currencySymbol: '$',
    /** Expose lifetime customer spend on customer profiles. */
    trackSpending: true,
    /** Orders completed before a customer is offered the VIP role. */
    vipThresholdOrders: 3,
    /** Lifetime spend that also qualifies a customer for VIP (0 disables). */
    vipThresholdSpend: 500,
  },

  status: {
    current: 'offline',
    /** Custom one-line note appended to the status panel. */
    note: '',
    updatedAt: null,
    updatedBy: null,
    /** Master switch for deriving the status from the schedule at all. */
    autoFromHours: true,
    /**
     * Currently following the schedule: open means online, closed means away.
     * Set to false the moment someone pins a status by hand, and back to true
     * by `/status set:Auto`.
     */
    auto: true,
  },

  queue: {
    enabled: true,
    /** Maximum concurrent in-progress projects before the queue is "full". */
    concurrentCapacity: 3,
    /** Average working days a project occupies, used for ETA maths. */
    averageProjectDays: 5,
    /** Publish the queue panel publicly. */
    publicQueue: true,
  },

  reviews: {
    enabled: true,
    /** Reviews require staff approval before they are published. */
    requireApproval: false,
    /** Automatically publish approved reviews to the reviews channel. */
    autoPublish: true,
    /** Minimum rating that is auto-published without manual review. */
    autoPublishMinRating: 1,
    /** Allow customers to submit a review only once per ticket. */
    onePerTicket: true,
    /** Reviews at or above this rating are eligible to be featured. */
    featureThreshold: 5,
    /** Automatically pin newly featured reviews. */
    pinFeatured: true,
  },

  portfolio: {
    enabled: true,
    /** Require the customer to have granted permission before publishing. */
    requireCustomerPermission: true,
    /** Publish new entries to the portfolio channel automatically. */
    autoPublish: true,
  },

  promotion: {
    enabled: true,
    /** Minimum concurrent players an applicant should have. Informational. */
    minPlayerCount: 5,
    /** Audience size advertised in the programme copy. */
    audienceSize: '100+ concurrent viewers',
    /** Automatically archive applications after a decision. */
    autoArchive: true,
  },

  announcements: {
    /** Default to @everyone pings on announcements. */
    pingEveryone: false,
    /** Role id pinged for stream notifications (empty disables). */
    streamPingRoleId: '',
  },

  // ── Membership automation ──────────────────────────────────────────────────
  autoRoles: {
    /** Roles granted to every human on join (role ids). */
    onJoin: [],
    /** Roles granted to bots on join. */
    onBotJoin: [],
    /** Role granted on first completed order. */
    onFirstPurchase: '',
    /** Role granted when a customer reaches VIP thresholds. */
    onVip: '',
  },

  /**
   * Membership verification.
   *
   * When enabled, joining does NOT grant the Verified role — the member has to
   * press the button on the verify panel first. That single deliberate action
   * is what stops a scripted raid account from reaching your public channels,
   * because a self-bot joining en masse will not press it.
   */
  verify: {
    enabled: true,
    /** Role granted on successful verification (set by /setup). */
    roleId: '',
    /** Minimum account age in days. 0 disables the check. */
    minAccountAgeDays: 0,
    /** Log every verification to the audit stream. */
    log: true,
    /** Greet the member in the ticket channel once they verify. */
    welcomeAfterVerify: true,
  },

  /**
   * Referral tracking, which gates the free portfolio commission programme.
   *
   * The bot correlates each join against the invite whose use count changed, so
   * a referral only counts once the invited person has actually joined — an
   * unused invite link is worth nothing.
   */
  referrals: {
    enabled: true,
    /** Successful invites needed to unlock a free commission application. */
    requiredForFreeCommission: 3,
    /** Only count invitees whose account is at least this many days old. */
    minInviteeAccountAgeDays: 7,
    /** Stop counting someone who leaves again within this many hours (0 = off). */
    revokeIfLeaveWithinHours: 24,
    /** Announce when a member unlocks the programme. */
    announceUnlock: true,
  },

  /**
   * Time-boxed launch promotion.
   *
   * While the window is open the referral gate on the free-commission ticket
   * type is waived for the listed services, so the offer the announcement makes
   * and the behaviour of the ticket panel cannot drift apart. `/launch end`
   * closes it early; the scheduler closes it automatically at `endsAt`.
   */
  launch: {
    enabled: false,
    startedAt: null,
    endsAt: null,
    /** Ticket types the waiver applies to. */
    serviceTypes: ['minecraft-plugin'],
    /** Skip the referral requirement for those services while open. */
    waiveReferralGate: true,
    /** Cap on free slots accepted during the window. 0 = unlimited. */
    maxSlots: 0,
    /** Slots claimed so far, incremented as free tickets open. */
    claimedSlots: 0,
    /** Message id of the published announcement, so it can be closed out. */
    announcementChannelId: '',
    announcementMessageId: '',
  },

  welcome: {
    enabled: true,
    /** Post the welcome embed in the welcome channel. */
    channelMessage: true,
    /** Send the welcome embed as a direct message too. */
    directMessage: false,
    /** Nudge new members in the ticket channel, then clean it up. */
    ticketNudge: true,
    /** How long the nudge survives, in seconds. */
    ticketNudgeSeconds: 15,
  },

  // ── Moderation & security ──────────────────────────────────────────────────
  moderation: {
    enabled: true,
    /** Role ids exempt from every automod module. */
    ignoredRoles: [],
    /** Channel ids exempt from every automod module. */
    ignoredChannels: [],
    /** User ids exempt from every automod module. */
    whitelistedUsers: [],
    /** Staff roles are always exempt. */
    exemptStaff: true,
    /** Notify the offender by DM when action is taken. */
    dmOnPunish: true,
    /** Warnings expire after N days (0 = never). */
    warningExpiryDays: 90,
    /**
     * Escalation ladder — when a member's active warning count reaches `at`,
     * `action` is applied automatically.
     */
    escalation: [
      { at: 3, action: 'timeout', duration: 60 },
      { at: 5, action: 'timeout', duration: 1440 },
      { at: 7, action: 'kick', duration: 0 },
      { at: 10, action: 'ban', duration: 0 },
    ],
    /** Require a confirmation prompt for destructive commands. */
    confirmDestructive: true,
  },

  automod: {
    enabled: true,
    modules: {
      spam: mod(true, 'timeout', 5, { window: 5, duration: 10 }),
      flood: mod(true, 'timeout', 8, { window: 3, duration: 10 }),
      repeatedMessages: mod(true, 'warn', 3, { window: 30 }),
      emojiSpam: mod(true, 'delete', 12),
      stickerSpam: mod(true, 'delete', 3, { window: 10 }),
      gifSpam: mod(true, 'delete', 4, { window: 15 }),
      attachmentSpam: mod(true, 'delete', 5, { window: 15 }),
      mentionSpam: mod(true, 'timeout', 6, { duration: 30 }),
      everyonePing: mod(true, 'warn', 1),
      herePing: mod(true, 'warn', 1),
      ghostPing: mod(true, 'warn', 1),
      inviteLinks: mod(true, 'warn', 1),
      scamLinks: mod(true, 'ban', 1, { duration: 0 }),
      phishingLinks: mod(true, 'ban', 1, { duration: 0 }),
      malwareLinks: mod(true, 'ban', 1, { duration: 0 }),
      tokenGrabbers: mod(true, 'ban', 1, { duration: 0 }),
      suspiciousUrls: mod(true, 'delete', 1),
      massDm: mod(true, 'timeout', 5, { window: 60, duration: 60 }),
      fakeNitro: mod(true, 'timeout', 1, { duration: 60 }),
      capsAbuse: mod(true, 'delete', 70, { minLength: 12 }),
      symbolAbuse: mod(true, 'delete', 60, { minLength: 12 }),
      newlineAbuse: mod(true, 'delete', 15),
      zalgo: mod(true, 'delete', 1),
      unicodeAbuse: mod(true, 'delete', 40, { minLength: 10 }),
      profanity: mod(true, 'warn', 1),
      slurs: mod(true, 'timeout', 1, { duration: 1440 }),
      offensiveLanguage: mod(false, 'warn', 1),
      advertising: mod(true, 'warn', 1),
      selfPromotion: mod(true, 'delete', 1),
      nsfwImages: mod(false, 'delete', 1),
    },
    /** Custom blocked words added by staff. */
    customWords: [],
    /** Custom regular expressions (stored as strings, compiled defensively). */
    customPatterns: [],
    /** Words explicitly allowed even if a filter would flag them. */
    allowedWords: [],
  },

  links: {
    enabled: true,
    /** Only allow links to these domains (empty = allow all but the blacklist). */
    whitelist: [],
    /** Always blocked domains. */
    blacklist: [],
    /** Block link shorteners outright. */
    blockShorteners: false,
    /** Allow links posted by staff regardless of filters. */
    allowStaff: true,
    /** Channel ids where links are always permitted. */
    allowedChannels: [],
  },

  antiRaid: {
    enabled: true,
    /** Joins within `joinWindow` seconds that trigger raid mode. */
    joinThreshold: 8,
    joinWindow: 10,
    /** Leaves within the same window that raise an alert. */
    leaveThreshold: 10,
    /** Accounts younger than N days are treated as suspicious. */
    minAccountAgeDays: 7,
    /** Action for accounts below the age threshold during raid mode. */
    newAccountAction: 'kick',
    /** Bots joining within the window that trigger a lockdown. */
    botJoinThreshold: 3,
    /** Automatic response when raid mode engages. */
    autoLockdown: true,
    /** Slowmode (seconds) applied to public channels during raid mode. */
    raidSlowmode: 15,
    /** Minutes raid mode stays active without new triggers. */
    raidDurationMinutes: 10,
    /** Alert staff with a role ping. */
    alertStaff: true,
  },

  antiNuke: {
    enabled: true,
    /** Users exempt from anti-nuke (owner is always exempt). */
    whitelist: [],
    /** Punishment applied to an offender: strip | kick | ban | none. */
    punishment: 'strip',
    /** Attempt to recreate deleted channels and roles. */
    attemptRestore: true,
    limits: {
      channelDelete: { max: 2, window: 20 },
      channelCreate: { max: 5, window: 20 },
      roleDelete: { max: 2, window: 20 },
      roleCreate: { max: 5, window: 20 },
      roleUpdate: { max: 6, window: 20 },
      memberBan: { max: 3, window: 30 },
      memberKick: { max: 5, window: 30 },
      webhookCreate: { max: 2, window: 20 },
      webhookDelete: { max: 2, window: 20 },
      emojiDelete: { max: 5, window: 20 },
      emojiCreate: { max: 10, window: 20 },
      permissionChange: { max: 4, window: 20 },
      memberRoleAdd: { max: 8, window: 20 },
    },
  },

  logging: {
    enabled: true,
    /** Persist important events to MongoDB in addition to channel logs. */
    persist: true,
    events: {
      messageDelete: true,
      messageUpdate: true,
      messageBulkDelete: true,
      memberJoin: true,
      memberLeave: true,
      memberUpdate: true,
      memberBoost: true,
      nicknameChange: true,
      roleChange: true,
      userUpdate: true,
      voiceJoin: true,
      voiceLeave: true,
      voiceMove: true,
      voiceStateUpdate: true,
      channelCreate: true,
      channelDelete: true,
      channelUpdate: true,
      roleCreate: true,
      roleDelete: true,
      roleUpdate: true,
      webhookUpdate: true,
      inviteCreate: true,
      inviteDelete: true,
      emojiUpdate: true,
      guildUpdate: true,
      moderation: true,
      commandUsage: true,
      ticketEvents: true,
      reviewEvents: true,
      orderEvents: true,
      securityEvents: true,
      errors: true,
    },
    /** Channels excluded from message logging (e.g. bot spam). */
    ignoredChannels: [],
  },

  security: {
    /** Flag accounts younger than N days when they join. */
    suspiciousAccountAgeDays: 7,
    /** Require members to pass account checks before speaking. */
    quarantineSuspicious: false,
    /** Notify staff about flagged accounts. */
    alertOnSuspicious: true,
    /** Global command cooldown fallback, in seconds. */
    defaultCooldown: 3,
    /** Interactions per minute a single user may trigger before throttling. */
    interactionRateLimit: 30,
  },

  lockdown: {
    active: false,
    reason: '',
    startedAt: null,
    startedBy: null,
    /** Channel ids that were locked, so unlock restores exactly what changed. */
    lockedChannels: [],
  },

  backups: {
    enabled: true,
    /** Automatic structure snapshot every N hours (0 disables). */
    intervalHours: 24,
    /** Snapshots retained on disk. */
    retain: 14,
  },

  reports: {
    /** Daily staff summary. */
    daily: true,
    /** Weekly business report. */
    weekly: true,
    /** UTC hour at which reports are generated. */
    hourUtc: 8,
  },
};

module.exports = { DEFAULT_CONFIG, ACTIONS };
