'use strict';

/**
 * Ticket lifecycle.
 *
 * Owns creation, claiming, transfer, priority, membership, closing, reopening,
 * archiving and deletion. Every state change writes to MongoDB first and only
 * then touches Discord, so a failed API call can never leave the database
 * describing a reality that does not exist.
 */

const { ChannelType, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');

const { Ticket, Counter, User, StaffStats, GuildStats } = require('../database/models');
const configService = require('./configService');
const logService = require('./logService');
const transcriptService = require('./transcriptService');
const statisticsService = require('./statisticsService');
const embeds = require('../utils/embeds');
const components = require('../utils/components');
const permissions = require('../utils/permissions');
const errors = require('../utils/errors');
const validators = require('../utils/validators');
const { TICKET_TYPE_MAP, PRIORITIES, STATUSES } = require('../config/server');
const { EMOJIS, COLORS } = require('../config/branding');
const { safeSend, attempt, fetchMember, resolveTextChannel, safeDm } = require('../utils/discord');
const { timestamp, duration, safeField, padId, truncate } = require('../utils/formatters');
const { logger } = require('../utils/logger');

const log = logger.child('tickets');

/** Statuses that count as "the ticket is live". */
const OPEN_STATUSES = ['open', 'claimed', 'pending'];

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Build the ticket header embed shown at the top of every ticket channel.
 * @param {object} ticket
 * @param {object} config
 * @param {object} [extra]
 */
function ticketEmbed(ticket, config, extra = {}) {
  const type = TICKET_TYPE_MAP[ticket.type];
  const priority = PRIORITIES[ticket.priority] ?? PRIORITIES.normal;

  const statusLabel = {
    open: `${EMOJIS.info} Awaiting staff`,
    claimed: `${EMOJIS.success} In progress`,
    pending: `${EMOJIS.clock} Waiting on customer`,
    closed: `${EMOJIS.lock} Closed`,
    archived: '🗄️ Archived',
  }[ticket.status] ?? ticket.status;

  const fields = [
    { name: 'Ticket', value: `\`#${padId(ticket.number)}\``, inline: true },
    { name: 'Customer', value: `<@${ticket.userId}>`, inline: true },
    { name: 'Service', value: `${type?.emoji ?? EMOJIS.ticket} ${ticket.typeLabel || type?.label || ticket.type}`, inline: true },
    { name: 'Status', value: statusLabel, inline: true },
    { name: 'Priority', value: `${priority.emoji} ${priority.label}`, inline: true },
    { name: 'Assigned', value: ticket.assignedTo ? `<@${ticket.assignedTo}>` : '_Unassigned_', inline: true },
    { name: 'Opened', value: timestamp(ticket.createdAt, 'relative'), inline: true },
    { name: 'Response Target', value: type?.responseTime ?? 'Within 12 hours', inline: true },
    { name: 'Developer Status', value: `${STATUSES[config?.status?.current ?? 'offline']?.emoji ?? ''} ${STATUSES[config?.status?.current ?? 'offline']?.label ?? 'Unknown'}`, inline: true },
  ];

  if (ticket.subject) fields.push({ name: 'Subject', value: safeField(ticket.subject, 1024), inline: false });

  return embeds.base({
    config,
    color: extra.color ?? type?.color ?? COLORS.primary,
    title: `${type?.emoji ?? EMOJIS.ticket} Ticket #${padId(ticket.number)}`,
    description:
      extra.description ??
      `Thank you for contacting **${config?.brand?.name ?? 'us'}**.\n` +
      'A member of the team will be with you shortly. In the meantime, please share ' +
      'as much detail as you can — the more we know, the faster we can help.',
    fields,
    footer: `Opened by ${ticket.username || ticket.userId}`,
  });
}

/**
 * Render the submitted project form as a clean summary embed.
 * @param {object} ticket
 * @param {object} config
 */
function formEmbed(ticket, config) {
  const form = ticket.form ?? {};
  const entries = Object.entries(form).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');
  if (!entries.length) return null;

  return embeds.base({
    config,
    color: COLORS.accent,
    title: `${EMOJIS.order} Project Brief`,
    description: 'Submitted by the customer. Staff can request changes at any time.',
    fields: entries.map(([name, value]) => ({
      name,
      value: safeField(value, 1024),
      inline: String(value).length <= 60,
    })),
    footer: `Ticket #${padId(ticket.number)}`,
  });
}

// ── Permission construction ──────────────────────────────────────────────────

/**
 * Build the overwrite set for a ticket channel.
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 * @param {string} ownerId
 * @param {string[]} [participants]
 */
function ticketOverwrites(guild, config, ownerId, participants = []) {
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ],
    },
  ];

  const customerPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.AddReactions,
  ];

  for (const userId of [ownerId, ...participants]) {
    if (userId) overwrites.push({ id: userId, allow: customerPermissions });
  }

  for (const roleId of permissions.staffRoleIds(config)) {
    overwrites.push({
      id: roleId,
      allow: [...customerPermissions, PermissionFlagsBits.ManageMessages],
    });
  }

  return overwrites;
}

// ── Creation ─────────────────────────────────────────────────────────────────

/**
 * Create a ticket: database record first, then the Discord channel.
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {import('discord.js').User} params.user
 * @param {string} params.type ticket type key
 * @param {object} [params.config]
 * @param {string} [params.subject]
 * @returns {Promise<{ ticket: object, channel: import('discord.js').TextChannel }>}
 */
async function create({ guild, user, type, config = null, subject = '' }) {
  const cfg = config ?? (await configService.get(guild));

  if (!cfg.tickets?.enabled) {
    throw new errors.ConflictError('The ticket system is currently disabled. Please try again later.');
  }
  if (!configService.isConfigured(cfg)) {
    throw new errors.ConfigurationError('This server is not set up yet. An administrator needs to run `/setup`.');
  }

  const typeDefinition = TICKET_TYPE_MAP[type];
  if (!typeDefinition) throw new errors.ValidationError('That service category is not recognised.');

  const enabledTypes = cfg.tickets.enabledTypes ?? [];
  if (enabledTypes.length && !enabledTypes.includes(type)) {
    throw new errors.ConflictError('That service is not currently accepting new requests.');
  }

  // One customer must not be able to spam the queue.
  const openCount = await Ticket.countOpenFor(guild.id, user.id);
  const max = cfg.tickets.maxOpenPerUser ?? 3;
  if (openCount >= max) {
    throw new errors.ConflictError(
      `You already have **${openCount}** open ticket${openCount === 1 ? '' : 's'}. ` +
      `Please continue there, or close one before opening another (limit: ${max}).`,
    );
  }

  const parentId = cfg.categories?.tickets;
  const parent = parentId ? guild.channels.cache.get(parentId) : null;
  if (parent && parent.children.cache.size >= 50) {
    // Discord hard-limits a category to 50 channels.
    throw new errors.DiscordLimitationError(
      'The active tickets category has reached Discord\'s 50-channel limit. ' +
      'Staff need to close or archive some tickets before new ones can be opened.',
    );
  }

  const number = await Counter.next(guild.id, 'ticket');
  const priority = typeDefinition.priority ?? cfg.tickets.defaultPriority ?? 'normal';

  // 1. Persist first — a ticket that exists in Discord but not in the database
  //    is unrecoverable; the reverse is trivially cleaned up.
  const ticket = await Ticket.create({
    guildId: guild.id,
    number,
    userId: user.id,
    username: user.tag ?? user.username,
    type,
    typeLabel: typeDefinition.label,
    priority,
    subject: subject ? truncate(subject, 200) : '',
    status: 'open',
  });

  // 2. Create the channel.
  const channelName = (cfg.tickets.nameFormat ?? 'ticket-{number}')
    .replace('{number}', padId(number))
    .replace('{user}', (user.username ?? 'user').toLowerCase().replace(/[^a-z0-9-]/g, ''))
    .replace('{type}', type)
    .slice(0, 100);

  let channel;
  try {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: parent?.id,
      topic: `Ticket #${padId(number)} · ${typeDefinition.label} · Customer: ${user.tag ?? user.username} (${user.id})`,
      permissionOverwrites: ticketOverwrites(guild, cfg, user.id),
      reason: `Ticket #${padId(number)} opened by ${user.tag ?? user.username}`,
    });
  } catch (err) {
    // Roll the record back so the counter is the only thing consumed.
    await Ticket.deleteOne({ _id: ticket._id }).catch(() => null);
    throw err;
  }

  ticket.channelId = channel.id;
  ticket.channelName = channel.name;
  await ticket.save();

  // 3. Post the header and controls.
  const header = await safeSend(channel, {
    content: cfg.tickets.pingSupport ? mentionSupport(cfg) : undefined,
    embeds: [ticketEmbed(ticket, cfg)],
    components: components.ticketControls({ status: ticket.status, claimed: false, ticketId: ticket._id.toString() }),
  });

  if (header) {
    ticket.panelMessageId = header.id;
    await ticket.save();
    await attempt(() => header.pin(), { label: 'pin ticket header' });
  }

  // 4. Telemetry.
  await Promise.all([
    User.bump(guild.id, user.id, { 'stats.totalTickets': 1, 'stats.openTickets': 1 }),
    User.updateOne({ guildId: guild.id, userId: user.id }, { $set: { lastTicketAt: new Date() } }),
    GuildStats.bump(guild.id, { 'tickets.opened': 1, [`tickets.byType.${type}`]: 1 }),
    logService.record(guild, {
      category: 'ticket',
      event: 'ticket.create',
      title: `${EMOJIS.ticket} Ticket Opened`,
      summary: `Ticket #${padId(number)} — ${typeDefinition.label}`,
      actorId: user.id,
      actorName: user.tag ?? user.username,
      channelId: channel.id,
      fields: { Service: typeDefinition.label, Priority: PRIORITIES[priority].label },
    }, cfg),
  ]);

  statisticsService.invalidate(guild.id);
  log.info(`Ticket #${padId(number)} created`, { guildId: guild.id, userId: user.id, type });

  return { ticket, channel };
}

/** Build the support role mention string. */
function mentionSupport(config) {
  const ids = [config.roles?.support, config.roles?.developer].filter(Boolean);
  return ids.length ? ids.map((id) => `<@&${id}>`).join(' ') : undefined;
}

// ── Lookup helpers ───────────────────────────────────────────────────────────

/**
 * Resolve a ticket from an interaction: prefer an explicit id, fall back to the
 * channel the interaction happened in.
 * @param {import('discord.js').Interaction} interaction
 * @param {string} [ticketId]
 */
async function resolve(interaction, ticketId) {
  const ticket = ticketId
    ? await Ticket.findOne({ _id: validators.objectId(ticketId, 'ticket'), guildId: interaction.guildId })
    : await Ticket.byChannel(interaction.guildId, interaction.channelId);

  if (!ticket) throw new errors.NotFoundError('This channel is not a ticket, or the ticket record no longer exists.');
  return ticket;
}

/**
 * Assert the actor may act on this ticket: staff always may; the customer may
 * only act on their own ticket, and only for customer-safe actions.
 * @param {object} ticket
 * @param {import('discord.js').GuildMember} member
 * @param {object} config
 * @param {{ staffOnly?: boolean }} [options]
 */
function assertAccess(ticket, member, config, { staffOnly = false } = {}) {
  const isStaff = permissions.isStaff(member, config);
  if (isStaff) return true;
  if (staffOnly) throw new errors.PermissionError('Only the support team can do that.');
  if (ticket.userId === member.id || ticket.participants.includes(member.id)) return true;
  throw new errors.PermissionError('You do not have access to this ticket.');
}

/**
 * Refresh the pinned header message so the panel always reflects reality.
 * @param {import('discord.js').Guild} guild
 * @param {object} ticket
 * @param {object} config
 */
async function refreshPanel(guild, ticket, config) {
  if (!ticket.channelId || !ticket.panelMessageId) return;
  const channel = await resolveTextChannel(guild, ticket.channelId);
  if (!channel) return;
  const message = await attempt(() => channel.messages.fetch(ticket.panelMessageId), { label: 'fetch ticket panel' });
  if (!message) return;
  await attempt(() => message.edit({
    embeds: [ticketEmbed(ticket, config)],
    components: components.ticketControls({
      status: ticket.status,
      claimed: Boolean(ticket.assignedTo),
      ticketId: ticket._id.toString(),
    }),
  }), { label: 'edit ticket panel' });
}

// ── Claiming & assignment ────────────────────────────────────────────────────

/**
 * Claim a ticket for a staff member.
 * @param {import('discord.js').Guild} guild
 * @param {object} ticket
 * @param {import('discord.js').GuildMember} staff
 * @param {object} config
 */
async function claim(guild, ticket, staff, config) {
  if (!OPEN_STATUSES.includes(ticket.status)) {
    throw new errors.ConflictError('This ticket is closed and cannot be claimed.');
  }
  if (ticket.assignedTo === staff.id) {
    throw new errors.ConflictError('You have already claimed this ticket.');
  }
  if (ticket.assignedTo) {
    throw new errors.ConflictError(`This ticket is already claimed by <@${ticket.assignedTo}>. Use transfer instead.`);
  }

  const now = new Date();
  ticket.assignedTo = staff.id;
  ticket.assignedName = staff.user.tag ?? staff.user.username;
  ticket.claimedAt = now;
  ticket.status = 'claimed';
  ticket.assignmentHistory.push({ staffId: staff.id, staffName: ticket.assignedName, assignedAt: now });
  await ticket.save();

  await StaffStats.bump(guild.id, staff.id, { 'tickets.claimed': 1 }, ticket.assignedName);
  await refreshPanel(guild, ticket, config);

  if (config.tickets?.announceClaims !== false) {
    const channel = await resolveTextChannel(guild, ticket.channelId);
    await safeSend(channel, {
      embeds: [embeds.success({
        config,
        title: 'Ticket Claimed',
        description: `<@${staff.id}> is now handling this request and will respond shortly.`,
      })],
    });
  }

  await logService.record(guild, {
    category: 'ticket',
    event: 'ticket.claim',
    title: `${EMOJIS.claim} Ticket Claimed`,
    summary: `Ticket #${padId(ticket.number)} claimed`,
    actorId: staff.id,
    actorName: ticket.assignedName,
    channelId: ticket.channelId,
  }, config);

  return ticket;
}

/**
 * Release a claimed ticket back to the pool.
 */
async function unclaim(guild, ticket, staff, config) {
  if (!ticket.assignedTo) throw new errors.ConflictError('This ticket is not claimed.');
  if (ticket.assignedTo !== staff.id && !permissions.isManager(staff, config)) {
    throw new errors.PermissionError('Only the assigned staff member or a manager can release this ticket.');
  }

  const previous = ticket.assignedTo;
  const entry = ticket.assignmentHistory.at(-1);
  if (entry && !entry.releasedAt) entry.releasedAt = new Date();

  ticket.assignedTo = null;
  ticket.assignedName = '';
  ticket.claimedAt = null;
  ticket.status = 'open';
  await ticket.save();

  await refreshPanel(guild, ticket, config);
  await logService.record(guild, {
    category: 'ticket',
    event: 'ticket.unclaim',
    title: `${EMOJIS.transfer} Ticket Released`,
    summary: `Ticket #${padId(ticket.number)} released by <@${staff.id}> (was <@${previous}>)`,
    actorId: staff.id,
    channelId: ticket.channelId,
  }, config);

  return ticket;
}

/**
 * Transfer a ticket to another staff member.
 */
async function transfer(guild, ticket, fromMember, toMember, config) {
  if (!permissions.isStaff(toMember, config)) {
    throw new errors.ValidationError('Tickets can only be transferred to a member of the support team.');
  }
  if (ticket.assignedTo === toMember.id) {
    throw new errors.ConflictError('That staff member already owns this ticket.');
  }

  const previous = ticket.assignedTo;
  const entry = ticket.assignmentHistory.at(-1);
  if (entry && !entry.releasedAt) entry.releasedAt = new Date();

  ticket.assignedTo = toMember.id;
  ticket.assignedName = toMember.user.tag ?? toMember.user.username;
  ticket.claimedAt = new Date();
  ticket.status = 'claimed';
  ticket.assignmentHistory.push({
    staffId: toMember.id,
    staffName: ticket.assignedName,
    assignedAt: new Date(),
    transferredBy: fromMember.id,
  });
  await ticket.save();

  await Promise.all([
    StaffStats.bump(guild.id, toMember.id, { 'tickets.claimed': 1, 'tickets.transferredIn': 1 }, ticket.assignedName),
    previous ? StaffStats.bump(guild.id, previous, { 'tickets.transferredOut': 1 }) : null,
  ].filter(Boolean));

  await refreshPanel(guild, ticket, config);

  const channel = await resolveTextChannel(guild, ticket.channelId);
  await safeSend(channel, {
    embeds: [embeds.info({
      config,
      title: `${EMOJIS.transfer} Ticket Transferred`,
      description: `This ticket is now handled by <@${toMember.id}>.`,
      footer: `Transferred by ${fromMember.user.tag ?? fromMember.user.username}`,
    })],
  });

  await logService.record(guild, {
    category: 'ticket',
    event: 'ticket.transfer',
    title: `${EMOJIS.transfer} Ticket Transferred`,
    summary: `Ticket #${padId(ticket.number)} → <@${toMember.id}>`,
    actorId: fromMember.id,
    targetId: toMember.id,
    channelId: ticket.channelId,
  }, config);

  return ticket;
}

// ── Attributes ───────────────────────────────────────────────────────────────

/** Change ticket priority. */
async function setPriority(guild, ticket, priority, actor, config) {
  if (!PRIORITIES[priority]) throw new errors.ValidationError('Unknown priority level.');
  const previous = ticket.priority;
  ticket.priority = priority;
  await ticket.save();
  await refreshPanel(guild, ticket, config);

  const channel = await resolveTextChannel(guild, ticket.channelId);
  await safeSend(channel, {
    embeds: [embeds.info({
      config,
      color: PRIORITIES[priority].color,
      title: `${PRIORITIES[priority].emoji} Priority: ${PRIORITIES[priority].label}`,
      description: `Priority changed from **${PRIORITIES[previous]?.label ?? previous}** to **${PRIORITIES[priority].label}**.`,
      footer: `Set by ${actor.user.tag ?? actor.user.username}`,
    })],
  });

  await logService.record(guild, {
    category: 'ticket',
    event: 'ticket.priority',
    title: `${EMOJIS.priority} Priority Changed`,
    summary: `Ticket #${padId(ticket.number)}: ${previous} → ${priority}`,
    actorId: actor.id,
    channelId: ticket.channelId,
  }, config);

  return ticket;
}

/** Rename the ticket channel. */
async function rename(guild, ticket, name, actor, config) {
  const channel = await resolveTextChannel(guild, ticket.channelId);
  if (!channel) throw new errors.NotFoundError('The ticket channel no longer exists.');

  const finalName = `${padId(ticket.number)}-${name}`.slice(0, 100);
  await channel.setName(finalName, `Renamed by ${actor.user.tag ?? actor.user.username}`);
  ticket.channelName = finalName;
  await ticket.save();

  await logService.record(guild, {
    category: 'ticket',
    event: 'ticket.rename',
    title: `${EMOJIS.pencil} Ticket Renamed`,
    summary: `Ticket #${padId(ticket.number)} renamed to \`${finalName}\``,
    actorId: actor.id,
    channelId: ticket.channelId,
  }, config);

  return ticket;
}

/**
 * Add a member to a ticket.
 */
async function addMember(guild, ticket, target, actor, config) {
  const channel = await resolveTextChannel(guild, ticket.channelId);
  if (!channel) throw new errors.NotFoundError('The ticket channel no longer exists.');
  if (ticket.participants.includes(target.id) || ticket.userId === target.id) {
    throw new errors.ConflictError('That member already has access to this ticket.');
  }

  await channel.permissionOverwrites.edit(target.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
    EmbedLinks: true,
  }, { reason: `Added to ticket by ${actor.user.tag ?? actor.user.username}` });

  ticket.participants.push(target.id);
  await ticket.save();

  await safeSend(channel, {
    embeds: [embeds.success({ config, title: 'Member Added', description: `<@${target.id}> has been added to this ticket.` })],
  });

  await logService.record(guild, {
    category: 'ticket',
    event: 'ticket.memberAdd',
    title: `${EMOJIS.add} Member Added`,
    summary: `<@${target.id}> added to ticket #${padId(ticket.number)}`,
    actorId: actor.id,
    targetId: target.id,
    channelId: ticket.channelId,
  }, config);

  return ticket;
}

/** Remove a member from a ticket. */
async function removeMember(guild, ticket, target, actor, config) {
  const channel = await resolveTextChannel(guild, ticket.channelId);
  if (!channel) throw new errors.NotFoundError('The ticket channel no longer exists.');
  if (target.id === ticket.userId) {
    throw new errors.ConflictError('The ticket owner cannot be removed. Close the ticket instead.');
  }

  await attempt(() => channel.permissionOverwrites.delete(target.id, `Removed from ticket by ${actor.user.tag}`), {
    label: 'remove ticket overwrite',
  });
  ticket.participants = ticket.participants.filter((id) => id !== target.id);
  await ticket.save();

  await safeSend(channel, {
    embeds: [embeds.warning({ config, title: 'Member Removed', description: `<@${target.id}> no longer has access to this ticket.` })],
  });

  await logService.record(guild, {
    category: 'ticket',
    event: 'ticket.memberRemove',
    title: `${EMOJIS.remove} Member Removed`,
    summary: `<@${target.id}> removed from ticket #${padId(ticket.number)}`,
    actorId: actor.id,
    targetId: target.id,
    channelId: ticket.channelId,
  }, config);

  return ticket;
}

/** Append an internal staff note. */
async function addNote(guild, ticket, content, author, config) {
  ticket.notes.push({
    content: truncate(content, 2000),
    authorId: author.id,
    authorName: author.user.tag ?? author.user.username,
    internal: true,
  });
  await ticket.save();

  await logService.record(guild, {
    category: 'ticket',
    event: 'ticket.note',
    title: `${EMOJIS.note} Internal Note`,
    summary: `Note added to ticket #${padId(ticket.number)}`,
    actorId: author.id,
    channelId: ticket.channelId,
    fields: { Note: truncate(content, 500) },
    severity: 'debug',
  }, config);

  return ticket;
}

// ── Closing ──────────────────────────────────────────────────────────────────

/**
 * Close a ticket: generate the transcript, update statistics, request a review
 * and move the channel to the archive (or delete it, per configuration).
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {object} params.ticket
 * @param {import('discord.js').GuildMember} params.actor
 * @param {object} params.config
 * @param {string} [params.reason]
 * @param {boolean} [params.requestReview]
 */
async function close({ guild, ticket, actor, config, reason = '', requestReview = true }) {
  if (!OPEN_STATUSES.includes(ticket.status)) {
    throw new errors.ConflictError('This ticket is already closed.');
  }

  const channel = await resolveTextChannel(guild, ticket.channelId);
  const now = new Date();

  // 1. Transcript — do this before permissions change so history is readable.
  let transcript = null;
  if (config.tickets?.transcripts !== false && channel) {
    transcript = await transcriptService
      .generate(channel, ticket, {
        markdown: config.tickets?.markdownTranscripts === true,
        brandName: config.brand?.name,
      })
      .catch((err) => {
        log.warn(`Transcript generation failed for ticket #${padId(ticket.number)}`, { message: err.message });
        return null;
      });
  }

  // 2. Persist the close.
  ticket.status = 'closed';
  ticket.closedAt = now;
  ticket.closedBy = actor.id;
  ticket.closedByName = actor.user?.tag ?? actor.user?.username ?? 'System';
  ticket.closeReason = truncate(reason, 500);
  ticket.durationMinutes = Math.max(0, Math.round((now - ticket.createdAt) / 60_000));
  if (transcript) {
    ticket.transcript = {
      generated: true,
      htmlPath: transcript.htmlPath,
      markdownPath: transcript.markdownPath,
      url: transcript.url,
      messageCount: transcript.messageCount,
      generatedAt: now,
    };
  }
  await ticket.save();

  // 3. Statistics.
  await Promise.all([
    User.bump(guild.id, ticket.userId, { 'stats.openTickets': -1 }),
    GuildStats.bump(guild.id, {
      'tickets.closed': 1,
      'tickets.resolutionSum': ticket.durationMinutes,
      'tickets.resolutionCount': 1,
      ...(ticket.firstResponseMinutes !== null
        ? { 'tickets.firstResponseSum': ticket.firstResponseMinutes, 'tickets.firstResponseCount': 1 }
        : {}),
    }),
    ticket.assignedTo ? recordStaffClose(guild.id, ticket) : null,
  ].filter(Boolean));

  // 4. Close notice in-channel.
  const closeEmbed = embeds.base({
    config,
    color: COLORS.muted,
    title: `${EMOJIS.lock} Ticket Closed`,
    description: reason
      ? `This ticket has been closed.\n\n**Reason:** ${safeField(reason, 500)}`
      : 'This ticket has been closed. Thank you for working with us.',
    fields: [
      { name: 'Closed by', value: `<@${actor.id}>`, inline: true },
      { name: 'Duration', value: duration(ticket.durationMinutes * 60_000), inline: true },
      { name: 'Messages', value: String(transcript?.messageCount ?? ticket.messageCount ?? 0), inline: true },
      ...(ticket.firstResponseMinutes !== null
        ? [{ name: 'First response', value: duration(ticket.firstResponseMinutes * 60_000, { compact: true }), inline: true }]
        : []),
    ],
    footer: `Ticket #${padId(ticket.number)}`,
  });

  const files = [];
  if (transcript?.htmlPath) {
    const file = await transcriptService.read(transcript.htmlPath);
    if (file) files.push(new AttachmentBuilder(file.buffer, { name: file.name }));
  }

  if (channel) {
    await safeSend(channel, {
      embeds: [closeEmbed],
      components: components.ticketControls({ status: 'closed', claimed: false, ticketId: ticket._id.toString() }),
    });

    // 5. Lock the channel for the customer but keep it readable.
    await attempt(() => channel.permissionOverwrites.edit(ticket.userId, { SendMessages: false }), {
      label: 'lock ticket for customer',
    });
    for (const participant of ticket.participants) {
      await attempt(() => channel.permissionOverwrites.edit(participant, { SendMessages: false }), { label: 'lock participant' });
    }
  }

  // 6. Ship the transcript to the log channel.
  const ticketLog = configService.logChannel(guild, config, 'ticket');
  if (ticketLog) {
    await safeSend(ticketLog, {
      embeds: [embeds.base({
        config,
        color: COLORS.muted,
        title: `${EMOJIS.transcript} Transcript · Ticket #${padId(ticket.number)}`,
        fields: [
          { name: 'Customer', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Service', value: ticket.typeLabel || ticket.type, inline: true },
          { name: 'Handled by', value: ticket.assignedTo ? `<@${ticket.assignedTo}>` : '_Unassigned_', inline: true },
          { name: 'Opened', value: timestamp(ticket.createdAt, 'full'), inline: true },
          { name: 'Closed', value: timestamp(now, 'full'), inline: true },
          { name: 'Duration', value: duration(ticket.durationMinutes * 60_000), inline: true },
          ...(transcript?.url ? [{ name: 'Link', value: `[Open transcript](${transcript.url})`, inline: false }] : []),
        ],
        footer: `Closed by ${ticket.closedByName}`,
      })],
      files,
    });
  }

  // 7. Customer copy + review request.
  const customer = await fetchMember(guild, ticket.userId);
  if (customer) {
    await safeDm(customer.user, {
      embeds: [embeds.base({
        config,
        title: `${EMOJIS.lock} Your ticket has been closed`,
        description:
          `Ticket **#${padId(ticket.number)}** in **${guild.name}** is now closed.\n` +
          'A transcript is attached for your records. Reply in the server if you need anything else.',
        footer: `Ticket #${padId(ticket.number)}`,
      })],
      files,
    });
  }

  if (requestReview && config.tickets?.requestReview !== false && config.reviews?.enabled !== false) {
    // Lazy require avoids a module cycle between ticket and review services.
    const reviewService = require('./reviewService');
    await reviewService.requestReview({ guild, ticket, config }).catch((err) => {
      log.debug('Review request failed', { message: err.message });
    });
  }

  // 8. Archive.
  if (config.tickets?.archiveOnClose !== false) {
    await archive(guild, ticket, config);
  }

  await logService.record(guild, {
    category: 'ticket',
    event: 'ticket.close',
    title: `${EMOJIS.lock} Ticket Closed`,
    summary: `Ticket #${padId(ticket.number)} closed${reason ? `: ${truncate(reason, 200)}` : ''}`,
    actorId: actor.id,
    targetId: ticket.userId,
    channelId: ticket.channelId,
    fields: { Duration: duration(ticket.durationMinutes * 60_000), Messages: String(transcript?.messageCount ?? 0) },
  }, config);

  statisticsService.invalidate(guild.id);
  log.info(`Ticket #${padId(ticket.number)} closed`, { guildId: guild.id, by: actor.id });

  return { ticket, transcript };
}

/** Update the closing staff member's performance record. */
async function recordStaffClose(guildId, ticket) {
  const stats = await StaffStats.resolve(guildId, ticket.assignedTo, ticket.assignedName);
  stats.tickets.closed += 1;
  if (ticket.firstResponseMinutes !== null) stats.recordFirstResponse(ticket.firstResponseMinutes);
  if (ticket.durationMinutes !== null) stats.recordResolution(ticket.durationMinutes);
  if (ticket.averageResponseMinutes !== null) stats.responses.averageResponseMinutes = ticket.averageResponseMinutes;
  await stats.save();
}

/** Move a closed ticket channel into the archive category. */
async function archive(guild, ticket, config) {
  const channel = await resolveTextChannel(guild, ticket.channelId);
  const archiveId = config.categories?.archive;
  if (!channel || !archiveId) return ticket;

  const archiveCategory = guild.channels.cache.get(archiveId);
  if (!archiveCategory) return ticket;

  // Discord limits a category to 50 channels — purge the oldest archived ticket
  // rather than silently failing to archive the new one.
  if (archiveCategory.children.cache.size >= 50) {
    const oldest = await Ticket.findOne({ guildId: guild.id, status: 'archived', channelId: { $ne: '' } })
      .sort({ archivedAt: 1 })
      .exec();
    if (oldest) await purge(guild, oldest, 'Archive category full — oldest ticket removed automatically');
  }

  await attempt(() => channel.setParent(archiveId, { lockPermissions: false, reason: 'Ticket archived' }), {
    label: 'archive ticket channel',
  });
  await attempt(() => channel.permissionOverwrites.edit(ticket.userId, { ViewChannel: false }), {
    label: 'hide archived ticket from customer',
  });

  ticket.status = 'archived';
  ticket.archivedAt = new Date();
  const retentionDays = config.tickets?.autoDeleteArchivedAfterDays ?? 30;
  ticket.purgeAt = retentionDays > 0 ? new Date(Date.now() + retentionDays * 86_400_000) : null;
  await ticket.save();

  return ticket;
}

/** Reopen a closed ticket. */
async function reopen(guild, ticket, actor, config) {
  if (OPEN_STATUSES.includes(ticket.status)) throw new errors.ConflictError('This ticket is already open.');
  if (ticket.status === 'deleted') throw new errors.ConflictError('This ticket has been permanently deleted.');

  const channel = await resolveTextChannel(guild, ticket.channelId);
  if (!channel) throw new errors.NotFoundError('The ticket channel no longer exists and cannot be reopened.');

  ticket.status = ticket.assignedTo ? 'claimed' : 'open';
  ticket.reopenCount += 1;
  ticket.reopenedAt = new Date();
  ticket.closedAt = null;
  ticket.archivedAt = null;
  ticket.purgeAt = null;
  await ticket.save();

  // Restore access and move back to the active category.
  const parentId = config.categories?.tickets;
  if (parentId) await attempt(() => channel.setParent(parentId, { lockPermissions: false, reason: 'Ticket reopened' }), { label: 'unarchive channel' });
  await attempt(() => channel.permissionOverwrites.edit(ticket.userId, { ViewChannel: true, SendMessages: true }), { label: 'restore customer access' });
  for (const participant of ticket.participants) {
    await attempt(() => channel.permissionOverwrites.edit(participant, { ViewChannel: true, SendMessages: true }), { label: 'restore participant access' });
  }

  await safeSend(channel, {
    content: `<@${ticket.userId}>`,
    embeds: [embeds.success({
      config,
      title: 'Ticket Reopened',
      description: 'This ticket has been reopened. How can we help?',
      footer: `Reopened by ${actor.user?.tag ?? 'staff'}`,
    })],
  });

  await refreshPanel(guild, ticket, config);
  await Promise.all([
    User.bump(guild.id, ticket.userId, { 'stats.openTickets': 1 }),
    GuildStats.bump(guild.id, { 'tickets.reopened': 1 }),
    ticket.assignedTo ? StaffStats.bump(guild.id, ticket.assignedTo, { 'tickets.reopened': 1 }) : null,
    logService.record(guild, {
      category: 'ticket',
      event: 'ticket.reopen',
      title: `${EMOJIS.reopen} Ticket Reopened`,
      summary: `Ticket #${padId(ticket.number)} reopened`,
      actorId: actor.id,
      channelId: ticket.channelId,
    }, config),
  ].filter(Boolean));

  return ticket;
}

/**
 * Permanently delete a ticket channel. The database record is retained (marked
 * `deleted`) so history, transcripts and statistics survive.
 */
async function purge(guild, ticket, reason = 'Ticket deleted') {
  const channel = await resolveTextChannel(guild, ticket.channelId);
  if (channel) await attempt(() => channel.delete(reason), { label: 'delete ticket channel' });

  ticket.status = 'deleted';
  ticket.channelId = '';
  ticket.purgeAt = null;
  await ticket.save();

  await GuildStats.bump(guild.id, { 'tickets.deleted': 1 });
  return ticket;
}

/**
 * Track message activity inside a ticket for SLA reporting.
 * Called from the messageCreate event; deliberately cheap.
 *
 * @param {import('discord.js').Message} message
 * @param {object} config
 */
async function trackMessage(message, config) {
  if (!message.guild || message.author.bot) return;

  const ticket = await Ticket.byChannel(message.guild.id, message.channel.id);
  if (!ticket || !OPEN_STATUSES.includes(ticket.status)) return;

  const isStaff = permissions.isStaff(message.member, config);
  ticket.messageCount += 1;

  if (isStaff) {
    const hadFirstResponse = Boolean(ticket.firstStaffReplyAt);
    ticket.recordStaffReply(message.createdAt);
    // A staff reply moves the ticket out of "waiting on customer".
    if (ticket.status === 'pending') ticket.status = ticket.assignedTo ? 'claimed' : 'open';
    if (!hadFirstResponse && ticket.firstResponseMinutes !== null && ticket.assignedTo) {
      const stats = await StaffStats.resolve(message.guild.id, ticket.assignedTo, ticket.assignedName);
      stats.recordFirstResponse(ticket.firstResponseMinutes);
      await stats.save();
    }
  } else if (message.author.id === ticket.userId || ticket.participants.includes(message.author.id)) {
    ticket.recordCustomerMessage(message.createdAt);
  }

  await ticket.save();
}

/**
 * Close tickets that have gone quiet, and warn before doing so.
 * Invoked by the scheduler.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 */
async function sweepInactive(guild, config) {
  const closeHours = config.tickets?.inactivityCloseHours ?? 0;
  if (closeHours <= 0) return { warned: 0, closed: 0 };

  const warnHours = config.tickets?.inactivityWarnHours ?? 0;
  const now = Date.now();
  let warned = 0;
  let closed = 0;

  const stale = await Ticket.find({
    guildId: guild.id,
    status: { $in: OPEN_STATUSES },
    lastMessageAt: { $lte: new Date(now - Math.min(warnHours || closeHours, closeHours) * 3_600_000) },
  }).limit(50);

  for (const ticket of stale) {
    const idleHours = (now - new Date(ticket.lastMessageAt).getTime()) / 3_600_000;

    if (idleHours >= closeHours) {
      // eslint-disable-next-line no-await-in-loop -- bounded batch, sequential by design
      await close({
        guild,
        ticket,
        actor: { id: guild.members.me.id, user: guild.client.user },
        config,
        reason: `Automatically closed after ${closeHours} hours of inactivity.`,
      }).catch(() => null);
      closed += 1;
    } else if (warnHours > 0 && idleHours >= warnHours && ticket.status !== 'pending') {
      const channel = await resolveTextChannel(guild, ticket.channelId);
      if (channel) {
        // eslint-disable-next-line no-await-in-loop -- bounded batch
        await safeSend(channel, {
          content: `<@${ticket.userId}>`,
          embeds: [embeds.warning({
            config,
            title: 'Is this still needed?',
            description:
              `This ticket has been quiet for **${Math.round(idleHours)} hours**. ` +
              `It will close automatically after **${closeHours} hours** of inactivity.\n\n` +
              'Send a message here to keep it open.',
          })],
        });
        ticket.status = 'pending';
        await ticket.save();
        warned += 1;
      }
    }
  }

  return { warned, closed };
}

/** Delete archived tickets whose retention window has elapsed. */
async function sweepArchived(guild) {
  const due = await Ticket.find({ guildId: guild.id, status: 'archived', purgeAt: { $ne: null, $lte: new Date() } }).limit(25);
  for (const ticket of due) {
    // eslint-disable-next-line no-await-in-loop -- bounded batch
    await purge(guild, ticket, 'Retention window elapsed').catch(() => null);
  }
  return due.length;
}

module.exports = {
  OPEN_STATUSES,
  create,
  resolve,
  assertAccess,
  refreshPanel,
  ticketEmbed,
  formEmbed,
  ticketOverwrites,
  claim,
  unclaim,
  transfer,
  setPriority,
  rename,
  addMember,
  removeMember,
  addNote,
  close,
  archive,
  reopen,
  purge,
  trackMessage,
  sweepInactive,
  sweepArchived,
  mentionSupport,
};
