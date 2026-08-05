'use strict';

/**
 * Quick actions on a filed report.
 */

const moderationService = require('../../services/moderationService');
const embeds = require('../../utils/embeds');
const errors = require('../../utils/errors');
const permissions = require('../../utils/permissions');
const { StaffStats } = require('../../database/models');
const { fetchMember, safeReply } = require('../../utils/discord');

/** Verify the bot and the actor can both act on the reported member. */
async function guardTarget(interaction, config, member, userId) {
  const target = await fetchMember(interaction.guild, userId);
  if (!target) throw new errors.NotFoundError('That member has left the server.');

  const actorCheck = permissions.canActOn(member, target);
  if (!actorCheck.ok) throw new errors.PermissionError(actorCheck.reason);

  const botCheck = permissions.botCanActOn(interaction.guild, target);
  if (!botCheck.ok) throw new errors.DiscordLimitationError(botCheck.reason);

  return target;
}

module.exports = {
  namespace: 'report',
  access: 'support',

  actions: {
    warn: {
      async run(interaction, { config, member, args }) {
        const target = await guardTarget(interaction, config, member, args[0]);
        const { case: record } = await moderationService.punish({
          guild: interaction.guild,
          type: 'warn',
          target: target.user,
          moderator: { id: member.id, tag: member.user.tag },
          reason: 'Actioned from a member report',
          config,
        });
        await StaffStats.bump(interaction.guildId, member.id, { 'moderation.reportsHandled': 1 }, member.user.tag);

        return safeReply(interaction, {
          embeds: [embeds.notice(`Warned <@${target.id}> — case \`#${record.caseId}\`.`, 'success', config)],
        }, { ephemeral: true });
      },
    },

    timeout: {
      async run(interaction, { config, member, args }) {
        const target = await guardTarget(interaction, config, member, args[0]);
        const { case: record } = await moderationService.punish({
          guild: interaction.guild,
          type: 'timeout',
          target: target.user,
          moderator: { id: member.id, tag: member.user.tag },
          reason: 'Actioned from a member report',
          duration: 3_600_000,
          config,
        });
        await StaffStats.bump(interaction.guildId, member.id, { 'moderation.reportsHandled': 1 }, member.user.tag);

        return safeReply(interaction, {
          embeds: [embeds.notice(`Timed out <@${target.id}> for one hour — case \`#${record.caseId}\`.`, 'success', config)],
        }, { ephemeral: true });
      },
    },

    dismiss: {
      async run(interaction, { config, member }) {
        await StaffStats.bump(interaction.guildId, member.id, { 'moderation.reportsHandled': 1 }, member.user.tag);
        // Strip the controls so the report is visibly resolved.
        await interaction.update({
          embeds: interaction.message.embeds,
          components: [],
        }).catch(() => null);
        return safeReply(interaction, {
          embeds: [embeds.notice(`Report dismissed by <@${member.id}>. No action taken.`, 'info', config)],
        }, { ephemeral: true, followUp: true });
      },
    },
  },
};
