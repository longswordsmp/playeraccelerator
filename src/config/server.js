'use strict';

/**
 * Server blueprint — the declarative description of the guild that `/setup`
 * builds. Everything the setup engine creates is derived from this file, so a
 * studio can re-brand the whole server by editing data instead of code.
 *
 * Permission model
 * ────────────────
 * Each category declares an `access` preset which the setup engine expands into
 * real permission overwrites (see `services/setupService.js`):
 *
 *   public     — everyone can read; only staff can post
 *   community  — everyone can read and post
 *   readonly   — everyone can read, nobody but staff can post
 *   staff      — hidden from @everyone, visible to staff roles
 *   tickets    — hidden from @everyone; ticket channels get per-user overwrites
 */

/** Role keys are stable identifiers stored in the guild configuration. */
const ROLES = Object.freeze([
  {
    key: 'owner',
    name: '👑 Owner',
    color: 0xf8fafc,
    hoist: true,
    mentionable: false,
    staff: true,
    admin: true,
    permissions: ['Administrator'],
    description: 'Studio owner. Full control over the server.',
  },
  {
    key: 'leadDeveloper',
    name: '⚡ Lead Developer',
    color: 0x8b5cf6,
    hoist: true,
    mentionable: true,
    staff: true,
    admin: true,
    permissions: [
      'ManageGuild', 'ManageChannels', 'ManageRoles', 'ManageMessages', 'ManageNicknames',
      'KickMembers', 'BanMembers', 'ModerateMembers', 'ViewAuditLog', 'MentionEveryone',
    ],
    description: 'Leads projects, manages the queue and the development team.',
  },
  {
    key: 'developer',
    name: '💻 Developer',
    color: 0x6366f1,
    hoist: true,
    mentionable: true,
    staff: true,
    permissions: ['ManageMessages', 'ModerateMembers', 'ManageThreads', 'ViewAuditLog'],
    description: 'Builds and delivers customer projects.',
  },
  {
    key: 'manager',
    name: '🛡️ Manager',
    color: 0x0ea5e9,
    hoist: true,
    mentionable: true,
    staff: true,
    permissions: [
      'ManageMessages', 'ManageNicknames', 'KickMembers', 'ModerateMembers', 'ViewAuditLog',
    ],
    description: 'Operations and moderation management.',
  },
  {
    key: 'support',
    name: '🎫 Support Team',
    color: 0x38bdf8,
    hoist: true,
    mentionable: true,
    staff: true,
    permissions: ['ManageMessages', 'ModerateMembers'],
    description: 'Handles tickets and first-line customer support.',
  },
  {
    key: 'vip',
    name: '💎 VIP Customer',
    color: 0xfbbf24,
    hoist: true,
    mentionable: false,
    permissions: [],
    description: 'Returning customers with priority handling.',
  },
  {
    key: 'customer',
    name: '🛒 Customer',
    color: 0x22c55e,
    hoist: true,
    mentionable: false,
    permissions: [],
    description: 'Has completed at least one order.',
  },
  {
    key: 'verified',
    name: '✅ Verified',
    color: 0x94a3b8,
    hoist: false,
    mentionable: false,
    permissions: [],
    description: 'Default role granted to every member on join.',
  },
  {
    key: 'bot',
    name: '🤖 Bot',
    color: 0x64748b,
    hoist: false,
    mentionable: false,
    permissions: [],
    description: 'Applied to integrations and bots.',
  },
  {
    key: 'muted',
    name: '🔇 Muted',
    color: 0x475569,
    hoist: false,
    mentionable: false,
    permissions: [],
    /** Denied everywhere by the setup engine. */
    mutedRole: true,
    description: 'Restricted from speaking anywhere in the server.',
  },
]);

/**
 * Category + channel blueprint, created in array order so the sidebar reads
 * top-to-bottom exactly as declared.
 *
 * `panel` marks a channel that receives an auto-generated interactive panel.
 * `logKey` marks a channel that becomes a logging destination.
 */
const CATEGORIES = Object.freeze([
  {
    key: 'information',
    name: '══════ 📢 INFORMATION ══════',
    access: 'public',
    channels: [
      { key: 'welcome', name: '👋│welcome', topic: 'Welcome to the studio — start here.', access: 'readonly', panel: 'welcome' },
      { key: 'rules', name: '📜│rules', topic: 'Community guidelines. Membership implies acceptance.', access: 'readonly', panel: 'rules' },
      { key: 'faq', name: '❓│faq', topic: 'Answers to the questions we are asked most.', access: 'readonly', panel: 'faq' },
      { key: 'announcements', name: '📢│announcements', topic: 'Studio updates, releases and maintenance notices.', access: 'readonly' },
      { key: 'pricing', name: '💰│pricing', topic: 'Service pricing and quotation policy.', access: 'readonly', panel: 'pricing' },
      { key: 'portfolio', name: '📁│portfolio', topic: 'Selected work delivered by the studio.', access: 'readonly', panel: 'portfolio' },
      { key: 'reviews', name: '⭐│reviews', topic: 'Verified customer reviews.', access: 'readonly', panel: 'reviews' },
      { key: 'tos', name: '📄│tos', topic: 'Terms of Service governing all engagements.', access: 'readonly', panel: 'tos' },
    ],
  },
  {
    key: 'orders',
    name: '══════ 🛒 ORDERS ══════',
    access: 'public',
    channels: [
      { key: 'createTicket', name: '🎫│create-ticket', topic: 'Open a request — orders, support, partnerships.', access: 'readonly', panel: 'ticket' },
      { key: 'activeOrders', name: '📋│active-orders', topic: 'Projects currently in development.', access: 'readonly' },
      { key: 'completedOrders', name: '✅│completed-orders', topic: 'Delivered projects.', access: 'readonly' },
      { key: 'orderStatus', name: '📦│order-status', topic: 'Live delivery status for active engagements.', access: 'readonly' },
    ],
  },
  {
    key: 'tickets',
    name: '══════ 🎟️ ACTIVE TICKETS ══════',
    access: 'tickets',
    /** Ticket channels are created here at runtime. */
    channels: [],
    ticketParent: true,
  },
  {
    key: 'archive',
    name: '══════ 🗄️ TICKET ARCHIVE ══════',
    access: 'staff',
    channels: [],
    archiveParent: true,
  },
  {
    key: 'community',
    name: '══════ 💬 COMMUNITY ══════',
    access: 'community',
    channels: [
      { key: 'general', name: '💬│general', topic: 'General discussion.' },
      { key: 'showcase', name: '🎉│showcase', topic: 'Show what you built.' },
      { key: 'media', name: '📸│media', topic: 'Screenshots, clips and media.' },
      { key: 'suggestions', name: '💡│suggestions', topic: 'Ideas for the studio and this server.' },
    ],
  },
  {
    key: 'status',
    name: '══════ 📈 STATUS ══════',
    access: 'public',
    channels: [
      { key: 'developerStatus', name: '🟢│developer-status', topic: 'Live availability of the development team.', access: 'readonly', panel: 'status' },
      { key: 'workingHours', name: '🕒│working-hours', topic: 'Office hours and expected response times.', access: 'readonly', panel: 'hours' },
      { key: 'statistics', name: '📊│statistics', topic: 'Live studio performance metrics.', access: 'readonly', panel: 'statistics' },
      { key: 'queue', name: '📅│queue', topic: 'Current project queue and estimated start times.', access: 'readonly', panel: 'queue' },
    ],
  },
  {
    key: 'staff',
    name: '══════ 🔒 STAFF ══════',
    access: 'staff',
    channels: [
      { key: 'staffChat', name: '💬│staff-chat', topic: 'Internal team coordination.' },
      { key: 'ticketLogs', name: '📂│ticket-logs', topic: 'Ticket lifecycle events.', logKey: 'ticket' },
      { key: 'auditLogs', name: '📑│audit-logs', topic: 'Server audit stream.', logKey: 'audit' },
      { key: 'modLogs', name: '⚠️│mod-logs', topic: 'Moderation actions.', logKey: 'moderation' },
      { key: 'botLogs', name: '🤖│bot-logs', topic: 'Runtime, errors and command usage.', logKey: 'bot' },
      { key: 'securityLogs', name: '🛡️│security-logs', topic: 'AutoMod, anti-raid and anti-nuke events.', logKey: 'security' },
      { key: 'reports', name: '📝│reports', topic: 'Member reports awaiting review.', logKey: 'report' },
      { key: 'staffPerformance', name: '📊│staff-performance', topic: 'Team performance and leaderboards.', panel: 'performance' },
      { key: 'businessReports', name: '📈│business-reports', topic: 'Automated daily and weekly business summaries.', logKey: 'business' },
    ],
  },
]);

/** Voice channels created under the STAFF and COMMUNITY categories. */
const VOICE_CHANNELS = Object.freeze([
  { key: 'staffOffice', name: '🎙️ Staff Office', category: 'staff', access: 'staff' },
  { key: 'waitingRoom', name: '🎧 Waiting Room', category: 'community', access: 'community' },
  { key: 'meetingRoom', name: '💼 Meeting Room', category: 'community', access: 'community' },
]);

/**
 * Ticket categories offered by the select menu. `form` picks which modal flow
 * runs after the channel is created.
 */
const TICKET_TYPES = Object.freeze([
  {
    key: 'discord-bot',
    label: 'Discord Bot Development',
    emoji: '🤖',
    description: 'Custom bots, dashboards and Discord integrations.',
    form: 'order',
    color: 0x6366f1,
    responseTime: 'Under 4 hours during office hours',
  },
  {
    key: 'website',
    label: 'Website Development',
    emoji: '🌐',
    description: 'Marketing sites, web apps, storefronts and dashboards.',
    form: 'order',
    color: 0x38bdf8,
    responseTime: 'Under 4 hours during office hours',
  },
  {
    key: 'minecraft-plugin',
    label: 'Minecraft Plugin Development',
    emoji: '🧩',
    description: 'Spigot, Paper, Velocity and Fabric development.',
    form: 'order',
    color: 0x22c55e,
    responseTime: 'Under 4 hours during office hours',
  },
  {
    key: 'custom-software',
    label: 'Custom Software',
    emoji: '⚙️',
    description: 'Desktop tools, services, automation and internal systems.',
    form: 'order',
    color: 0x8b5cf6,
    responseTime: 'Under 6 hours during office hours',
  },
  {
    key: 'api',
    label: 'API Development',
    emoji: '🔌',
    description: 'REST and realtime APIs, integrations and backends.',
    form: 'order',
    color: 0x0ea5e9,
    responseTime: 'Under 6 hours during office hours',
  },
  {
    key: 'bug-report',
    label: 'Bug Report',
    emoji: '🐞',
    description: 'Report a defect in delivered work or in this server.',
    form: 'bug',
    color: 0xef4444,
    responseTime: 'Under 2 hours during office hours',
    priority: 'high',
  },
  {
    key: 'support',
    label: 'General Support',
    emoji: '💬',
    description: 'Questions about services, billing or an existing project.',
    form: 'support',
    color: 0x64748b,
    responseTime: 'Under 6 hours during office hours',
  },
  {
    key: 'free-commission',
    label: 'Free Portfolio Commission',
    emoji: '🎨',
    description: 'Apply for a free build. Selection is at our discretion.',
    form: 'freeCommission',
    color: 0xfbbf24,
    responseTime: 'Reviewed within 3 business days',
    priority: 'low',
  },
  {
    key: 'promotion',
    label: 'Promotion Partnership',
    emoji: '📢',
    description: 'Apply to have your Minecraft server featured on stream.',
    form: 'promotion',
    color: 0xa855f7,
    responseTime: 'Reviewed within 5 business days',
    priority: 'low',
  },
  {
    key: 'other',
    label: 'Other',
    emoji: '❓',
    description: 'Anything that does not fit the categories above.',
    form: 'support',
    color: 0x94a3b8,
    responseTime: 'Under 12 hours',
  },
]);

/** Ticket priority definitions used across embeds, sorting and SLA maths. */
const PRIORITIES = Object.freeze({
  low: { label: 'Low', emoji: '🟦', weight: 1, color: 0x64748b, sla: 24 * 60 },
  normal: { label: 'Normal', emoji: '🟩', weight: 2, color: 0x6366f1, sla: 8 * 60 },
  high: { label: 'High', emoji: '🟧', weight: 3, color: 0xf59e0b, sla: 2 * 60 },
  urgent: { label: 'Urgent', emoji: '🟥', weight: 4, color: 0xef4444, sla: 30 },
});

/** Developer availability states shown by the live status panel. */
const STATUSES = Object.freeze({
  online: { label: 'Online', emoji: '🟢', color: 0x22c55e, description: 'Available now and actively responding.', response: 'Within 30 minutes' },
  coding: { label: 'Coding', emoji: '💻', color: 0x6366f1, description: 'Heads-down on active development.', response: 'Within 2 hours' },
  streaming: { label: 'Streaming', emoji: '🎮', color: 0xa855f7, description: 'Live on stream — replies may be delayed.', response: 'Within 3 hours' },
  meeting: { label: 'In Meeting', emoji: '🎤', color: 0x0ea5e9, description: 'In a client meeting.', response: 'Within 2 hours' },
  busy: { label: 'Busy', emoji: '🟡', color: 0xf59e0b, description: 'Working through a backlog.', response: 'Within 6 hours' },
  away: { label: 'Away', emoji: '🌙', color: 0x94a3b8, description: 'Away from the desk.', response: 'Within 12 hours' },
  offline: { label: 'Offline', emoji: '🔴', color: 0x475569, description: 'Outside office hours.', response: 'Next business day' },
});

/** Order lifecycle. Ordered — index doubles as pipeline position. */
const ORDER_STATUSES = Object.freeze({
  pending: { label: 'Pending Review', emoji: '🕓', color: 0x94a3b8 },
  quoted: { label: 'Quoted', emoji: '💬', color: 0x38bdf8 },
  accepted: { label: 'Accepted', emoji: '🤝', color: 0x0ea5e9 },
  queued: { label: 'Queued', emoji: '📅', color: 0x6366f1 },
  'in-progress': { label: 'In Progress', emoji: '⚙️', color: 0x8b5cf6 },
  review: { label: 'Under Review', emoji: '🔍', color: 0xf59e0b },
  delivered: { label: 'Delivered', emoji: '📦', color: 0x22c55e },
  completed: { label: 'Completed', emoji: '✅', color: 0x22c55e },
  paused: { label: 'Paused', emoji: '⏸️', color: 0xf59e0b },
  cancelled: { label: 'Cancelled', emoji: '⛔', color: 0xef4444 },
});

/** Convenience lookups. */
const TICKET_TYPE_MAP = Object.freeze(Object.fromEntries(TICKET_TYPES.map((t) => [t.key, t])));
const ROLE_MAP = Object.freeze(Object.fromEntries(ROLES.map((r) => [r.key, r])));
const STAFF_ROLE_KEYS = Object.freeze(ROLES.filter((r) => r.staff).map((r) => r.key));
const ADMIN_ROLE_KEYS = Object.freeze(ROLES.filter((r) => r.admin).map((r) => r.key));

module.exports = {
  ROLES,
  ROLE_MAP,
  STAFF_ROLE_KEYS,
  ADMIN_ROLE_KEYS,
  CATEGORIES,
  VOICE_CHANNELS,
  TICKET_TYPES,
  TICKET_TYPE_MAP,
  PRIORITIES,
  STATUSES,
  ORDER_STATUSES,
};
