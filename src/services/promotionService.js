'use strict';

/**
 * Promotion partnership applications.
 *
 * Applicants submit a server for consideration; staff review, decide and
 * record the reasoning. The programme copy is explicit that meeting the
 * requirements does not guarantee promotion — the model and the messaging
 * both reflect that.
 */

const { Promotion, Counter } = require('../database/models');
const configService = require('./configService');
const logService = require('./logService');
const embeds = require('../utils/embeds');
const components = require('../utils/components');
const customId = require('../utils/customId');
const errors = require('../utils/errors');
const { EMOJIS, COLORS } = require('../config/branding');
const { safeSend, safeDm, fetchMember, attempt } = require('../utils/discord');
const { timestamp, truncate, safeField, padId, number: fmtNumber } = require('../utils/formatters');

/** Status presentation. */
const STATUS_META = {
  pending: { label: 'Pending Review', emoji: '🕓', color: COLORS.muted },
  reviewing: { label: 'Under Review', emoji: '🔍', color: COLORS.info },
  'changes-requested': { label: 'Changes Requested', emoji: '✏️', color: COLORS.warning },
  approved: { label: 'Approved', emoji: '✅', color: COLORS.success },
  declined: { label: 'Declined', emoji: '⛔', color: COLORS.danger },
  archived: { label: 'Archived', emoji: '🗄️', color: COLORS.muted },
};

/**
 * Render an application for staff review.
 * @param {object} application
 * @param {object} config
 */
function applicationEmbed(application, config) {
  const meta = STATUS_META[application.status] ?? STATUS_META.pending;
  const links = [
    application.website ? `[Website](${application.website})` : null,
    application.discordInvite ? `[Discord](${application.discordInvite})` : null,
    application.trailerUrl ? `[Trailer](${application.trailerUrl})` : null,
  ].filter(Boolean);

  return embeds.base({
    config,
    color: meta.color,
    title: `${EMOJIS.promotion} ${truncate(application.serverName, 180)}`,
    description: application.description ? safeField(application.description, 1500) : undefined,
    fields: [
      { name: 'Application', value: `\`#${padId(application.number, 3)}\``, inline: true },
      { name: 'Status', value: `${meta.emoji} ${meta.label}`, inline: true },
      { name: 'Applicant', value: `<@${application.userId}>`, inline: true },
      { name: 'Server IP', value: application.serverIp ? `\`${safeField(application.serverIp, 100)}\`` : '—', inline: true },
      { name: 'Version', value: safeField(application.version || '—', 60), inline: true },
      { name: 'Players', value: application.playerCount !== null && application.playerCount !== undefined ? fmtNumber(application.playerCount) : '—', inline: true },
      ...(application.features ? [{ name: 'Unique Features', value: safeField(application.features, 1024) }] : []),
      ...(application.pitch ? [{ name: 'Why feature this server?', value: safeField(application.pitch, 1024) }] : []),
      ...(links.length ? [{ name: 'Links', value: links.join(' · ') }] : []),
      ...(application.additional ? [{ name: 'Additional Information', value: safeField(application.additional, 1024) }] : []),
      ...(application.decisionAt
        ? [{ name: 'Decision', value: `${meta.label} by <@${application.decisionBy}> · ${timestamp(application.decisionAt, 'relative')}` }]
        : []),
      ...(application.decisionReason ? [{ name: 'Decision Note', value: safeField(application.decisionReason, 1024) }] : []),
      ...(application.staffNotes?.length
        ? [{
          name: `Internal Notes (${application.staffNotes.length})`,
          value: truncate(application.staffNotes.slice(-3).map((note) => `**${note.authorName || 'Staff'}:** ${note.content}`).join('\n'), 1024),
        }]
        : []),
    ],
    image: application.screenshots?.[0] ?? undefined,
    footer: `Submitted ${application.createdAt ? new Date(application.createdAt).toISOString().slice(0, 10) : 'recently'}`,
  });
}

/** Staff decision buttons. */
function reviewControls(applicationId) {
  return components.rows([
    components.button({ id: customId.build('promotion', 'approve', applicationId), label: 'Approve', emoji: EMOJIS.success, style: 'success' }),
    components.button({ id: customId.build('promotion', 'decline', applicationId), label: 'Decline', emoji: EMOJIS.error, style: 'danger' }),
    components.button({ id: customId.build('promotion', 'changes', applicationId), label: 'Request Changes', emoji: EMOJIS.pencil, style: 'secondary' }),
    components.button({ id: customId.build('promotion', 'note', applicationId), label: 'Add Note', emoji: EMOJIS.note, style: 'secondary' }),
  ]);
}

/**
 * Create an application from a submitted form.
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {import('discord.js').User} params.user
 * @param {object} params.data
 * @param {object} [params.ticket]
 * @param {object} params.config
 */
async function create({ guild, user, data, ticket = null, config }) {
  if (config.promotion?.enabled === false) {
    throw new errors.ConflictError('The promotion partnership programme is not accepting applications right now.');
  }

  // One open application per applicant keeps the review queue honest.
  const existing = await Promotion.findOne({
    guildId: guild.id,
    userId: user.id,
    status: { $in: ['pending', 'reviewing', 'changes-requested'] },
  });
  if (existing) {
    throw new errors.ConflictError(
      `You already have an application under review (\`#${padId(existing.number, 3)}\`). ` +
      'Please wait for a decision before submitting another.',
    );
  }

  const number = await Counter.next(guild.id, 'promotion');
  const application = await Promotion.create({
    guildId: guild.id,
    number,
    userId: user.id,
    username: user.tag ?? user.username,
    ticketId: ticket?._id ?? null,
    ticketNumber: ticket?.number ?? null,
    serverName: data.serverName,
    serverIp: data.serverIp ?? '',
    version: data.version ?? '',
    description: data.description ?? '',
    features: data.features ?? '',
    playerCount: data.playerCount ?? null,
    website: data.website ?? '',
    discordInvite: data.discordInvite ?? '',
    trailerUrl: data.trailerUrl ?? '',
    screenshots: data.screenshots ?? [],
    pitch: data.pitch ?? '',
    additional: data.additional ?? '',
    status: 'pending',
  });

  // Post it for staff review.
  const reviewChannel = configService.logChannel(guild, config, 'report')
    ?? configService.channel(guild, config, 'staffChat');
  if (reviewChannel) {
    const message = await safeSend(reviewChannel, {
      embeds: [applicationEmbed(application, config)],
      components: reviewControls(application._id.toString()),
    });
    if (message) {
      application.reviewChannelId = reviewChannel.id;
      application.reviewMessageId = message.id;
      await application.save();
    }
  }

  await logService.record(guild, {
    category: 'business',
    event: 'promotion.submit',
    title: `${EMOJIS.promotion} Promotion Application`,
    summary: `${truncate(data.serverName, 120)} — application #${padId(number, 3)}`,
    actorId: user.id,
    actorName: user.tag,
  }, config);

  return application;
}

/**
 * Record a decision.
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {object} params.application
 * @param {'approved'|'declined'|'changes-requested'|'reviewing'|'archived'} params.status
 * @param {import('discord.js').GuildMember} params.actor
 * @param {string} [params.reason]
 * @param {object} params.config
 */
async function decide({ guild, application, status, actor, reason = '', config }) {
  if (!STATUS_META[status]) throw new errors.ValidationError('Unknown application status.');

  application.status = status;
  application.decisionBy = actor.id;
  application.decisionByName = actor.user?.tag ?? '';
  application.decisionAt = new Date();
  application.decisionReason = truncate(reason, 1000);
  await application.save();

  // Update the staff review message in place.
  if (application.reviewChannelId && application.reviewMessageId) {
    const channel = guild.channels.cache.get(application.reviewChannelId);
    const message = channel
      ? await attempt(() => channel.messages.fetch(application.reviewMessageId), { label: 'fetch promotion review' })
      : null;
    if (message) {
      await attempt(() => message.edit({
        embeds: [applicationEmbed(application, config)],
        components: ['approved', 'declined', 'archived'].includes(status) ? [] : reviewControls(application._id.toString()),
      }), { label: 'edit promotion review' });
    }
  }

  // Always tell the applicant, whatever the answer.
  const member = await fetchMember(guild, application.userId);
  if (member && ['approved', 'declined', 'changes-requested'].includes(status)) {
    const messages = {
      approved: {
        title: 'Your server has been approved for promotion',
        description:
          `**${truncate(application.serverName, 150)}** has been selected for promotion.\n\n` +
          'Our team will contact you in your ticket to arrange dates and details.',
        tone: 'success',
      },
      declined: {
        title: 'Promotion application declined',
        description:
          `Thank you for applying with **${truncate(application.serverName, 150)}**.\n\n` +
          'On this occasion we are not going ahead. Slots are limited and selection is based on fit with the audience — ' +
          'a decline is not a judgement on the quality of your server. You are welcome to apply again in the future.',
        tone: 'warning',
      },
      'changes-requested': {
        title: 'More information needed',
        description:
          `We would like to know more about **${truncate(application.serverName, 150)}** before deciding.\n\n` +
          'Please reply in your ticket with the details below.',
        tone: 'info',
      },
    }[status];

    await safeDm(member.user, {
      embeds: [embeds[messages.tone === 'success' ? 'success' : messages.tone === 'warning' ? 'warning' : 'info']({
        config,
        title: messages.title,
        description: messages.description,
        fields: reason ? [{ name: 'From our team', value: safeField(reason, 1024) }] : [],
        footer: `Application #${padId(application.number, 3)}`,
      })],
    });
  }

  await logService.record(guild, {
    category: 'business',
    event: `promotion.${status}`,
    title: `${STATUS_META[status].emoji} Promotion ${STATUS_META[status].label}`,
    summary: `${truncate(application.serverName, 120)} — #${padId(application.number, 3)}`,
    actorId: actor.id,
    targetId: application.userId,
    fields: reason ? { Reason: truncate(reason, 500) } : {},
  }, config);

  return application;
}

/** Append an internal note. */
async function addNote(application, content, author) {
  application.staffNotes.push({
    content: truncate(content, 1000),
    authorId: author.id,
    authorName: author.user?.tag ?? '',
  });
  await application.save();
  return application;
}

/** Mark an approved application as actually promoted. */
async function markPromoted(guild, application, actor, notes, config) {
  if (application.status !== 'approved') {
    throw new errors.ConflictError('Only approved applications can be marked as promoted.');
  }
  application.promoted = true;
  application.promotedAt = new Date();
  application.promotionNotes = truncate(notes, 500);
  if (config.promotion?.autoArchive !== false) application.status = 'archived';
  await application.save();

  await logService.record(guild, {
    category: 'business',
    event: 'promotion.completed',
    title: `${EMOJIS.promotion} Promotion Delivered`,
    summary: truncate(application.serverName, 150),
    actorId: actor.id,
  }, config);

  return application;
}

/** Look up an application by number. */
async function byNumber(guildId, num) {
  const application = await Promotion.findOne({ guildId, number: num });
  if (!application) throw new errors.NotFoundError(`Application \`#${padId(num, 3)}\` does not exist.`);
  return application;
}

module.exports = { STATUS_META, applicationEmbed, reviewControls, create, decide, addNote, markPromoted, byNumber };
