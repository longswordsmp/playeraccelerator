'use strict';

/**
 * /invites — referral progress toward a free commission, and the leaderboard.
 */

const { SlashCommandBuilder, ChannelType } = require('discord.js');

const inviteService = require('../../services/inviteService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const errors = require('../../utils/errors');
const permissions = require('../../utils/permissions');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer, attempt } = require('../../utils/discord');
const { progressBar, medal, timestamp, truncate } = require('../../utils/formatters');

module.exports = {
  access: 'everyone',
  cooldown: 10,
  requiresSetup: true,

  data: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Your referral progress toward a free commission, and your invite link.')
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName('me')
      .setDescription('Show your progress and get your personal invite link.'))
    .addSubcommand((sub) => sub
      .setName('leaderboard')
      .setDescription('Who has invited the most people who stayed.'))
    .addSubcommand((sub) => sub
      .setName('check')
      .setDescription('Check another member\'s referral progress (staff only).')
      .addUserOption((option) => option.setName('user').setDescription('Whose progress.').setRequired(true))),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember }} context
   */
  async execute(interaction, { config, member }) {
    const sub = interaction.options.getSubcommand();

    if (config.referrals?.enabled === false) {
      throw new errors.ConflictError('Referral tracking is disabled on this server.');
    }

    // ── Leaderboard ─────────────────────────────────────────────────────────
    if (sub === 'leaderboard') {
      await safeDefer(interaction, { ephemeral: true });
      const top = await inviteService.leaderboard(interaction.guildId, 15);

      if (!top.length) {
        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: 'No referrals yet',
            description: 'Nobody has invited anyone who stayed. Run `/invites me` to get your link and be first.',
          })],
        }, { ephemeral: true });
      }

      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: `${EMOJIS.users} Referral Leaderboard`,
          description: top
            .map((entry, index) => (
              `${medal(index)} <@${entry.userId}> — **${entry.referrals?.count ?? 0}**` +
              `${entry.referrals?.unlockedFreeCommission ? ` ${EMOJIS.star}` : ''}`
            ))
            .join('\n'),
          footer: `${EMOJIS.star} = free commission unlocked`,
        })],
      }, { ephemeral: true });
    }

    // ── Staff lookup ────────────────────────────────────────────────────────
    if (sub === 'check') {
      permissions.assertLevel(member, 'support', config, 'check other members\' referrals');
      const target = interaction.options.getUser('user');
      const state = await inviteService.progress(interaction.guildId, target.id, config);

      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          author: { name: target.tag, iconURL: target.displayAvatarURL({ size: 128 }) },
          title: `${EMOJIS.users} Referral Record`,
          description: state.unlocked
            ? `${EMOJIS.success} Unlocked — **${state.count}** credited referrals.`
            : `**${state.count}/${state.required}** credited referrals.`,
          fields: [
            { name: 'Credited', value: String(state.count), inline: true },
            { name: 'Revoked', value: String(state.revoked.length), inline: true },
            { name: 'Claimed', value: String(state.used), inline: true },
            ...(state.invitedBy ? [{ name: 'Invited by', value: `<@${state.invitedBy}>` }] : []),
            ...(state.credited.length
              ? [{
                name: 'Who they brought',
                value: truncate(state.credited.map((entry) => `<@${entry.userId}> · ${timestamp(entry.joinedAt, 'relative')}`).join('\n'), 1024),
              }]
              : []),
            ...(state.revoked.length
              ? [{
                name: 'Revoked',
                value: truncate(state.revoked.map((entry) => `<@${entry.userId}> — ${entry.revokedReason || 'revoked'}`).join('\n'), 1024),
              }]
              : []),
          ],
        })],
      }, { ephemeral: true });
    }

    // ── Own progress + link ─────────────────────────────────────────────────
    await safeDefer(interaction, { ephemeral: true });
    const state = await inviteService.progress(interaction.guildId, member.id, config);

    // Reuse an existing permanent link rather than minting a new one each time.
    const target = interaction.guild.channels.cache.get(config.channels?.verify)
      ?? interaction.guild.channels.cache.get(config.channels?.welcome)
      ?? interaction.guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText && channel.viewable);

    let link = null;
    if (target) {
      const existing = await attempt(() => interaction.guild.invites.fetch(), { label: 'fetch invites' });
      const mine = existing?.find((invite) => invite.inviterId === member.id && invite.maxAge === 0 && invite.maxUses === 0);
      const invite = mine ?? await attempt(
        () => interaction.guild.invites.create(target.id, {
          maxAge: 0, maxUses: 0, unique: true, reason: `Referral link for ${interaction.user.tag}`,
        }),
        { label: 'create referral invite' },
      );
      if (invite) {
        link = `https://discord.gg/${invite.code}`;
        await inviteService.refresh(interaction.guild);
      }
    }

    return safeReply(interaction, {
      embeds: [embeds.base({
        config,
        title: `${EMOJIS.users} Your Referral Progress`,
        description: state.unlocked
          ? `${EMOJIS.success} **Unlocked.** You can apply for a free portfolio commission.\n\n` +
            'Applications are still reviewed individually — unlocking means you can apply, not that you are accepted.'
          : `**${state.count} of ${state.required}**\n${progressBar(state.count, state.required, 14)}\n\n` +
            `**${state.remaining}** more to go.`,
        fields: [
          ...(link
            ? [{ name: 'Your invite link', value: `\`\`\`\n${link}\n\`\`\`\nShare this exact link — credit follows the link that was used.` }]
            : [{ name: 'Invite link', value: `${EMOJIS.warning} I could not create one. I need **Create Invite** permission.` }]),
          ...(state.credited.length
            ? [{
              name: `Credited (${state.count})`,
              value: truncate(
                state.credited
                  .slice(-8)
                  .reverse()
                  .map((entry) => `${EMOJIS.bullet} <@${entry.userId}> · ${timestamp(entry.joinedAt, 'relative')}`)
                  .join('\n'),
                1024,
              ),
            }]
            : []),
          {
            name: 'What counts',
            value:
              `${EMOJIS.bullet} They join through your link and stay\n` +
              `${EMOJIS.bullet} Their account is at least ${config.referrals?.minInviteeAccountAgeDays ?? 7} days old\n` +
              `${EMOJIS.bullet} Not a bot, not an alt of yours, not already counted`,
          },
        ],
        footer: 'Progress updates automatically the moment someone joins.',
      })],
      components: components.rows([
        components.button({ id: customId.build('referral', 'leaderboard'), label: 'Leaderboard', emoji: '🏆', style: 'secondary' }),
        ...(state.unlocked
          ? [components.button({ id: customId.build('ticket', 'quickOpen', 'free-commission'), label: 'Apply Now', emoji: EMOJIS.star, style: 'success' })]
          : []),
      ]),
    }, { ephemeral: true });
  },
};
