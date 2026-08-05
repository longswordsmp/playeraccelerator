'use strict';

/**
 * Time-boxed launch promotion.
 *
 * The point of putting this in the configuration rather than writing a one-off
 * announcement by hand is that the offer and the software have to agree. If the
 * announcement says "just open a ticket" while the ticket panel still demands
 * three referrals, the first person to try is told no — in public, on launch
 * day. So the window that the announcement describes is the same window the
 * ticket gate consults, and it closes itself when it expires.
 */

const configService = require('./configService');
const embeds = require('../utils/embeds');
const components = require('../utils/components');
const customId = require('../utils/customId');
const assets = require('../utils/assets');
const { TICKET_TYPE_MAP } = require('../config/server');
const { EMOJIS, COLORS } = require('../config/branding');
const { attempt } = require('../utils/discord');
const { plural } = require('../utils/formatters');
const { logger } = require('../utils/logger');

const log = logger.child('launch');

/** Is the promotion currently running? */
function isOpen(config) {
  const launch = config?.launch;
  if (!launch?.enabled) return false;
  if (!launch.endsAt) return true;
  return new Date(launch.endsAt).getTime() > Date.now();
}

/**
 * Free slots left, or `Infinity` when uncapped.
 * @returns {number}
 */
function remainingSlots(config) {
  const max = config?.launch?.maxSlots ?? 0;
  if (!max) return Infinity;
  return Math.max(0, max - (config.launch.claimedSlots ?? 0));
}

/**
 * Does the promotion waive the referral requirement for this ticket type?
 *
 * Only the `free-commission` type is gated in the first place, so that is the
 * only type this can affect. `launch.serviceTypes` describes what the free work
 * covers and is used for the announcement copy, not for the gate.
 */
function waivesReferralGate(config, ticketType) {
  if (ticketType !== 'free-commission') return false;
  if (!isOpen(config)) return false;
  if (config.launch?.waiveReferralGate === false) return false;
  return remainingSlots(config) > 0;
}

/** Milliseconds left in the window, or `null` when it has no end. */
function timeRemaining(config) {
  const endsAt = config?.launch?.endsAt;
  if (!endsAt) return null;
  return Math.max(0, new Date(endsAt).getTime() - Date.now());
}

/** Human labels for the services the offer covers. */
function serviceLabels(config) {
  return (config?.launch?.serviceTypes ?? [])
    .map((key) => TICKET_TYPE_MAP[key]?.label ?? key);
}

/**
 * Open the promotion window.
 *
 * @param {import('discord.js').Guild} guild
 * @param {{ days?: number, serviceTypes?: string[], maxSlots?: number }} [options]
 * @returns {Promise<object>} the refreshed configuration
 */
async function start(guild, { days = 7, serviceTypes, maxSlots } = {}) {
  const now = new Date();
  const endsAt = new Date(now.getTime() + days * 86_400_000);

  await configService.update(guild, (cfg) => {
    cfg.setPath('launch.enabled', true);
    cfg.setPath('launch.startedAt', now);
    cfg.setPath('launch.endsAt', endsAt);
    // A restart resets the counter: slots are per-window, and carrying a count
    // over from a previous promotion would silently close the new one.
    cfg.setPath('launch.claimedSlots', 0);
    if (serviceTypes?.length) cfg.setPath('launch.serviceTypes', serviceTypes);
    if (maxSlots !== undefined && maxSlots !== null) cfg.setPath('launch.maxSlots', maxSlots);
  });

  log.info('Launch promotion opened', { guildId: guild.id, days, endsAt: endsAt.toISOString() });
  return configService.get(guild, { fresh: true });
}

/**
 * Close the window. Leaves `startedAt`/`endsAt` in place so the record of when
 * it ran survives, and so the announcement can be edited to say it has ended.
 */
async function end(guild) {
  await configService.update(guild, (cfg) => cfg.setPath('launch.enabled', false));
  log.info('Launch promotion closed', { guildId: guild.id });
  return configService.get(guild, { fresh: true });
}

/**
 * Record a claimed slot. Called once a free ticket has actually been created,
 * never before — a failed creation must not burn a slot.
 */
async function claimSlot(guild) {
  await configService.update(guild, (cfg) => {
    cfg.setPath('launch.claimedSlots', (cfg.getPath('launch.claimedSlots', 0) ?? 0) + 1);
  });
}

// ── Presentation ─────────────────────────────────────────────────────────────

/** The studio's display name, however the guild has configured it. */
const studioName = (config) => config?.brand?.name || 'The studio';

/**
 * Build the launch announcement.
 *
 * @param {object} config
 * @param {{ ended?: boolean }} [options]
 */
function announcement(config, { ended = false } = {}) {
  const services = serviceLabels(config);
  const remaining = remainingSlots(config);
  const endsAt = config.launch?.endsAt ? new Date(config.launch.endsAt) : null;
  const stamp = endsAt ? `<t:${Math.floor(endsAt.getTime() / 1000)}:R>` : 'soon';

  const list = services.length ? services.join(', ') : 'custom builds';

  const payload = {
    embeds: [embeds.panel({
      config,
      color: ended ? COLORS.muted : COLORS.accent,
      title: ended
        ? `${EMOJIS.success} Launch Week — Closed`
        : `${EMOJIS.bolt} Launch Week — Free ${list} Commissions`,
      description: ended
        ? 'The free launch-week slots have all been taken and the offer is now closed. '
          + 'Thank you to everyone who took one — the work is going straight into the portfolio.\n\n'
          + 'Paid quotes are open as normal, and the free-service programme is still available through referrals.'
        : `**${studioName(config)} is open, and for the first week the work is free.**\n\n`
          + `I am building this studio's portfolio, and the fastest way to do that is to build real things for real `
          + `people. So for the next week I am taking **${list.toLowerCase()} commissions at no charge**. `
          + 'No catch, no upsell, no "free tier" that turns into an invoice. You get the finished build and the '
          + 'source, I get something to show.\n\n'
          + `**To claim one: open a ticket.** That is the whole process.`,
      fields: ended
        ? []
        : [
          {
            name: `${EMOJIS.arrow} How to start`,
            value: config.channels?.createTicket
              ? `Head to <#${config.channels.createTicket}> and open a **Free Portfolio Commission** ticket. `
                + 'Tell me what you want built. I will come back with a yes and a timeline, or an honest no.'
              : 'Open a **Free Portfolio Commission** ticket and tell me what you want built.',
          },
          {
            name: `${EMOJIS.clock} Offer closes`,
            value: `${stamp}${endsAt ? ` · <t:${Math.floor(endsAt.getTime() / 1000)}:F>` : ''}`,
            inline: true,
          },
          {
            name: `${EMOJIS.ticket} Slots`,
            value: remaining === Infinity
              ? 'Uncapped — limited only by how much I can build in a week.'
              : `**${plural(remaining, 'slot')}** left of ${config.launch.maxSlots}.`,
            inline: true,
          },
          {
            name: `${EMOJIS.info} The honest small print`,
            value:
              `${EMOJIS.bullet} Small, self-contained projects — roughly a few hours of work\n`
              + `${EMOJIS.bullet} You get the source and documentation, same standard as paid work\n`
              + `${EMOJIS.bullet} The build goes in the public portfolio; say so if that is a problem\n`
              + `${EMOJIS.bullet} Commercial projects get a paid quote instead\n`
              + `${EMOJIS.bullet} First come, first served — I will tell you straight away if I am full`,
          },
        ],
      footer: ended ? 'Launch week has ended' : 'Launch week · building the portfolio in public',
    })],
    components: !ended && config.channels?.createTicket
      ? components.rows([
        components.button({
          id: customId.build('ticket', 'open'),
          label: 'Claim a Free Build',
          emoji: EMOJIS.bolt,
          style: 'success',
        }),
      ])
      : [],
  };

  return assets.attachPanelArt(payload, 'launch', config);
}

// ── Maintenance ──────────────────────────────────────────────────────────────

/**
 * Close an expired window and rewrite the announcement to say so.
 *
 * Editing the original message matters: an expired offer left standing is the
 * kind of thing people screenshot. Run from the scheduler.
 */
async function sweep(guild, config) {
  if (!config.launch?.enabled) return false;
  if (isOpen(config)) return false;

  const closed = await end(guild);

  const { announcementChannelId, announcementMessageId } = config.launch;
  if (announcementChannelId && announcementMessageId) {
    const channel = await attempt(() => guild.channels.fetch(announcementChannelId), { label: 'fetch launch channel' });
    const message = channel?.isTextBased()
      ? await attempt(() => channel.messages.fetch(announcementMessageId), { label: 'fetch launch announcement' })
      : null;

    if (message?.editable) {
      await attempt(
        () => message.edit({ ...announcement(closed, { ended: true }), attachments: [] }),
        { label: 'close out launch announcement' },
      );
    }
  }

  log.info('Launch promotion expired and was closed', { guildId: guild.id });
  return true;
}

module.exports = {
  isOpen,
  remainingSlots,
  waivesReferralGate,
  timeRemaining,
  serviceLabels,
  start,
  end,
  claimSlot,
  announcement,
  sweep,
};
