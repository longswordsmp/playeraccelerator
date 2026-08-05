'use strict';

/**
 * Referral tracker controls: progress, personal invite link, leaderboard.
 */

const { ChannelType } = require('discord.js');

const inviteService = require('../../services/inviteService');
const embeds = require('../../utils/embeds');
const errors = require('../../utils/errors');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer, attempt } = require('../../utils/discord');
const { progressBar, medal, timestamp, truncate } = require('../../utils/formatters');

/**
 * Build the progress embed for a member.
 * @param {object} state from inviteService.progress
 * @param {object} config
 */
function progressEmbed(state, config) {
  const recent = state.credited
    .slice(-8)
    .reverse()
    .map((entry) => `${EMOJIS.bullet} <@${entry.userId}> · joined ${timestamp(entry.joinedAt, 'relative')}`)
    .join('\n');

  return embeds.base({
    config,
    color: state.unlocked ? undefined : config.theme?.primary,
    title: `${EMOJIS.users} Referral Progress`,
    description: state.unlocked
      ? `${EMOJIS.success} **Unlocked.** You can apply for a free portfolio commission.\n\n` +
        'Open a **Free Portfolio Commission** ticket whenever you are ready. ' +
        'Applications are still reviewed individually — unlocking means you can apply, not that you are accepted.'
      : `**${state.count} of ${state.required}** referrals.\n${progressBar(state.count, state.required, 14)}\n\n` +
        `Invite **${state.remaining}** more ${state.remaining === 1 ? 'person who joins' : 'people who join'} and stays.`,
    fields: [
      ...(recent ? [{ name: `Credited (${state.count})`, value: truncate(recent, 1024) }] : []),
      ...(state.revoked.length
        ? [{
          name: `Not counted (${state.revoked.length})`,
          value: truncate(
            state.revoked.slice(-5).map((entry) => `${EMOJIS.bullet} <@${entry.userId}> — ${entry.revokedReason || 'revoked'}`).join('\n'),
            1024,
          ),
        }]
        : []),
      ...(state.used > 0 ? [{ name: 'Free commissions claimed', value: String(state.used), inline: true }] : []),
    ],
    footer: state.unlocked ? 'Thank you for growing the community.' : 'Progress updates automatically when someone joins.',
  });
}

module.exports = {
  namespace: 'referral',
  access: 'everyone',

  actions: {
    progress: {
      async run(interaction, { config, member }) {
        const state = await inviteService.progress(interaction.guildId, member.id, config);
        return safeReply(interaction, { embeds: [progressEmbed(state, config)] }, { ephemeral: true });
      },
    },

    /**
     * Mint a personal, permanent invite so referrals can be attributed.
     * Reuses an existing one rather than creating a new link every press.
     */
    link: {
      async run(interaction, { config, member }) {
        await safeDefer(interaction, { ephemeral: true });

        const target = interaction.guild.channels.cache.get(config.channels?.verify)
          ?? interaction.guild.channels.cache.get(config.channels?.welcome)
          ?? interaction.guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText && channel.viewable);

        if (!target) {
          throw new errors.ConfigurationError('There is no channel I can create an invite for. Ask an administrator to run `/setup`.');
        }

        const existing = await attempt(() => interaction.guild.invites.fetch(), { label: 'fetch invites' });
        const mine = existing?.find((invite) => invite.inviterId === member.id
          && invite.maxAge === 0
          && invite.maxUses === 0);

        const invite = mine ?? await attempt(
          () => interaction.guild.invites.create(target.id, {
            maxAge: 0,
            maxUses: 0,
            unique: true,
            reason: `Referral link for ${interaction.user.tag}`,
          }),
          { label: 'create referral invite' },
        );

        if (!invite) {
          throw new errors.PermissionError(
            'I could not create an invite. I need **Create Invite** permission in that channel.',
          );
        }

        // Keep the attribution cache in step with the new link.
        await inviteService.refresh(interaction.guild);
        const state = await inviteService.progress(interaction.guildId, member.id, config);

        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.link} Your Invite Link`,
            description:
              `\`\`\`\nhttps://discord.gg/${invite.code}\n\`\`\`\n` +
              'Share this exact link — referrals are only credited to the link that was actually used.',
            fields: [
              {
                name: 'Progress',
                value: state.unlocked
                  ? `${EMOJIS.success} Unlocked`
                  : `**${state.count}/${state.required}** · ${progressBar(state.count, state.required, 12)}`,
              },
              { name: 'Never expires', value: 'This link has no time limit and no use limit.', inline: true },
            ],
            footer: mine ? 'This is your existing link — it has not changed.' : 'Created just now.',
          })],
        }, { ephemeral: true });
      },
    },

    leaderboard: {
      async run(interaction, { config }) {
        await safeDefer(interaction, { ephemeral: true });
        const top = await inviteService.leaderboard(interaction.guildId, 10);

        if (!top.length) {
          return safeReply(interaction, {
            embeds: [embeds.info({
              config,
              title: 'No referrals yet',
              description: 'Nobody has invited anyone who stayed. You could be first — press **Get My Invite Link**.',
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
      },
    },
  },
};
