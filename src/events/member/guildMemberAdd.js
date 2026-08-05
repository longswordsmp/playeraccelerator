'use strict';

/**
 * New member workflow.
 *
 *   1. record the member,
 *   2. run raid / account-safety checks (before granting anything),
 *   3. grant the automatic roles,
 *   4. publish the welcome embed,
 *   5. nudge them toward the ticket channel and clean the nudge up.
 */

const { Events } = require('discord.js');

const configService = require('../../services/configService');
const logService = require('../../services/logService');
const antiRaid = require('../../security/antiRaid');
const inviteService = require('../../services/inviteService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const content = require('../../config/content');
const { User, GuildStats } = require('../../database/models');
const { EMOJIS, COLORS } = require('../../config/branding');
const { safeSend, safeDm, attempt, deleteAfter } = require('../../utils/discord');
const { timestamp, duration } = require('../../utils/formatters');
const { logger } = require('../../utils/logger');

const log = logger.child('join');

module.exports = {
  name: Events.GuildMemberAdd,

  /**
   * @param {import('../../core/Client').StudioClient} client
   * @param {import('discord.js').GuildMember} member
   */
  async execute(client, member) {
    if (!member.guild) return;
    const config = await configService.get(member.guild);

    // ── 1. Persist ──────────────────────────────────────────────────────────
    const existing = await User.findOne({ guildId: member.guild.id, userId: member.id }).lean();
    await User.resolve(member.guild.id, member.user, {
      inGuild: true,
      lastJoinedAt: new Date(),
      leftAt: null,
      displayName: member.displayName,
    });
    if (existing) {
      await User.updateOne({ guildId: member.guild.id, userId: member.id }, { $inc: { joinCount: 1 } });
    }
    await GuildStats.bump(member.guild.id, { 'members.joins': 1 });

    // ── 2. Safety checks ────────────────────────────────────────────────────
    const raid = await antiRaid.onJoin(member, config);
    // If raid protection removed them, stop here.
    if (raid.action && ['kick', 'ban'].includes(raid.action)) return;

    // ── 2b. Referral attribution ────────────────────────────────────────────
    // Runs before the welcome so the nudge can mention their progress. Must not
    // be able to break the join flow, hence the catch.
    const referral = await inviteService.creditJoin(member, config).catch((err) => {
      log.debug('Referral attribution failed', { message: err.message });
      return null;
    });

    // ── 3. Automatic roles ──────────────────────────────────────────────────
    // With verification enabled, joining grants nothing — the member has to
    // press the verify button. That is the entire point of the gate.
    const verificationGates = config.verify?.enabled && !member.user.bot;
    const roleIds = member.user.bot
      ? config.autoRoles?.onBotJoin ?? []
      : verificationGates ? [] : config.autoRoles?.onJoin ?? [];

    const grantable = roleIds
      .map((roleId) => member.guild.roles.cache.get(roleId))
      .filter((role) => role && role.editable);

    if (grantable.length) {
      const granted = await attempt(() => member.roles.add(grantable, 'Automatic role assignment on join'), {
        label: 'auto role',
      });
      if (granted && !member.user.bot) {
        await User.updateOne({ guildId: member.guild.id, userId: member.id }, { $set: { verified: true } });
      } else if (!granted) {
        log.warn(`Could not assign auto-roles in ${member.guild.name} — check my role position.`);
      }
    }

    if (member.user.bot) return;

    // ── 4. Welcome ──────────────────────────────────────────────────────────
    if (config.welcome?.enabled === false) return;

    const doc = content.WELCOME;
    const ticketChannelId = config.channels?.createTicket;
    const rulesChannelId = config.channels?.rules;
    const verifyChannelId = config.channels?.verify;

    const welcomeEmbed = embeds.panel({
      config,
      color: COLORS.accent,
      title: `${EMOJIS.brand} Welcome to ${member.guild.name}`,
      description:
        `${doc.intro}\n\n` +
        [
          // Verification comes first when it gates everything else.
          verificationGates && verifyChannelId ? `${EMOJIS.success} <#${verifyChannelId}> — **verify here first**` : null,
          ticketChannelId ? `${EMOJIS.ticket} <#${ticketChannelId}> — start a project` : null,
          rulesChannelId ? `${EMOJIS.logs} <#${rulesChannelId}> — read the guidelines` : null,
        ].filter(Boolean).join('\n'),
      fields: [
        { name: 'What we build', value: 'Discord bots · Minecraft plugins · Websites · APIs · Automation · Custom software' },
        { name: 'How to start', value: 'Open a ticket, describe what you need, and you will get a fixed-price quote before any work begins.' },
        ...(referral?.inviterId
          ? [{ name: 'Invited by', value: `<@${referral.inviterId}>` }]
          : []),
      ],
      author: { name: member.user.tag, iconURL: member.user.displayAvatarURL({ size: 128 }) },
      footer: `Member #${member.guild.memberCount}`,
    });

    if (config.welcome?.channelMessage !== false) {
      const welcomeChannel = configService.channel(member.guild, config, 'welcome');
      const greeting = await safeSend(welcomeChannel, { content: `${member}`, embeds: [welcomeEmbed] });

      // Greetings are transient by default. The welcome channel's real content
      // is the pinned panel that tells people where to go; a run of joins
      // pushes it off the screen, so the next arrival sees a wall of greetings
      // for strangers and none of the orientation the channel exists to give.
      // Set `welcome.deleteAfterSeconds` to 0 to keep them permanently.
      const ttl = config.welcome?.deleteAfterSeconds ?? 60;
      if (ttl > 0) deleteAfter(greeting, ttl * 1000);
    }

    if (config.welcome?.directMessage) {
      await safeDm(member.user, { embeds: [welcomeEmbed] });
    }

    // ── 5. Nudge, auto-cleaned ──────────────────────────────────────────────
    // Point them at verification when it gates the server, and at the ticket
    // panel when it does not — nudging someone toward a channel they cannot
    // see yet would just be confusing.
    const nudgeChannelId = verificationGates ? (verifyChannelId ?? ticketChannelId) : ticketChannelId;
    if (config.welcome?.ticketNudge !== false && nudgeChannelId) {
      const nudgeChannel = member.guild.channels.cache.get(nudgeChannelId);
      const nudge = await safeSend(nudgeChannel, {
        content: `${member}`,
        embeds: [embeds.info({
          config,
          description: verificationGates
            ? `Welcome, ${member}! Press **Verify Me** below to unlock the server. ` +
              'This message disappears shortly to keep the channel clean.'
            : `Welcome, ${member}! Use the button below to open an order or request a service. ` +
              'This message disappears shortly to keep the channel clean.',
        })],
        components: components.rows([
          verificationGates
            ? components.button({ id: customId.build('verify', 'confirm'), label: 'Verify Me', emoji: EMOJIS.success, style: 'success' })
            : components.button({ id: customId.build('ticket', 'open'), label: 'Create Ticket', emoji: EMOJIS.ticket, style: 'primary' }),
        ]),
      });
      deleteAfter(nudge, (config.welcome?.ticketNudgeSeconds ?? 15) * 1000);
    }

    // ── Log ─────────────────────────────────────────────────────────────────
    await logService.record(member.guild, {
      category: 'member',
      event: 'memberJoin',
      title: `${EMOJIS.user} Member Joined`,
      summary: `${member.user.tag} joined the server`,
      actorId: member.id,
      actorName: member.user.tag,
      thumbnail: member.user.displayAvatarURL({ size: 128 }),
      fields: {
        'Account created': `${timestamp(member.user.createdAt, 'full')} (${duration(Date.now() - member.user.createdTimestamp)} old)`,
        'Member count': String(member.guild.memberCount),
        ...(existing ? { 'Previous visits': String((existing.joinCount ?? 1)) } : {}),
        ...(raid.flagged ? { Flagged: 'New account — heuristic only, no action taken' } : {}),
      },
    }, config);
  },
};
