'use strict';

/**
 * Membership verification.
 *
 * A single deliberate button press. It is not a CAPTCHA and does not pretend to
 * be one — what it actually stops is the common case of a scripted raid, where
 * accounts join en masse and start posting without ever rendering the UI. It
 * also gives anti-raid a clean signal: unverified accounts hold no roles.
 */

const inviteService = require('../../services/inviteService');
const logService = require('../../services/logService');
const embeds = require('../../utils/embeds');
const componentsUtil = require('../../utils/components');
const errors = require('../../utils/errors');
const { User } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { safeReply, attempt } = require('../../utils/discord');
const { duration, plural } = require('../../utils/formatters');

module.exports = {
  namespace: 'verify',
  access: 'everyone',

  actions: {
    confirm: {
      async run(interaction, { config, member }) {
        const roleId = config.verify?.roleId || config.roles?.verified;
        if (!roleId) {
          throw new errors.ConfigurationError(
            'No verified role is configured yet. An administrator needs to run `/setup`.',
          );
        }

        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) {
          throw new errors.ConfigurationError('The verified role no longer exists. An administrator needs to re-run `/setup`.');
        }

        // Already done — say so plainly rather than silently re-granting.
        if (member.roles.cache.has(roleId)) {
          return safeReply(interaction, {
            embeds: [embeds.notice('You are already verified. Everything is open to you.', 'info', config)],
          }, { ephemeral: true });
        }

        // Optional account-age gate.
        const minAge = config.verify?.minAccountAgeDays ?? 0;
        const accountAge = Date.now() - interaction.user.createdTimestamp;
        if (minAge > 0 && accountAge < minAge * 86_400_000) {
          const wait = minAge * 86_400_000 - accountAge;
          throw new errors.ConflictError(
            `This server requires accounts to be at least **${plural(minAge, 'day')}** old before verifying. ` +
            `Your account qualifies in **${duration(wait)}**.`,
          );
        }

        if (!role.editable) {
          throw new errors.DiscordLimitationError(
            'I cannot assign the verified role — it sits at or above my highest role. ' +
            'An administrator needs to move my role higher in Server Settings → Roles.',
          );
        }

        const granted = await attempt(() => member.roles.add(role, 'Verified via the verify panel'), {
          label: 'grant verified role',
        });
        if (!granted) {
          throw new errors.AppError('I could not assign the role. Please tell a member of staff.');
        }

        await User.updateOne(
          { guildId: interaction.guildId, userId: member.id },
          {
            $set: { verified: true, verifiedAt: new Date() },
            $setOnInsert: { guildId: interaction.guildId, userId: member.id },
          },
          { upsert: true },
        ).catch(() => null);

        if (config.verify?.log !== false) {
          await logService.record(interaction.guild, {
            category: 'member',
            event: 'member.verify',
            title: `${EMOJIS.success} Member Verified`,
            summary: `${interaction.user.tag} verified`,
            actorId: member.id,
            actorName: interaction.user.tag,
            severity: 'debug',
            fields: { 'Account age': duration(accountAge, { parts: 1 }) },
          }, config);
        }

        // Show them where to go next, including their referral progress.
        const referral = await inviteService.progress(interaction.guildId, member.id, config).catch(() => null);
        const ticketChannel = config.channels?.createTicket;
        const freeChannel = config.channels?.freeCommissions;

        return safeReply(interaction, {
          embeds: [embeds.success({
            config,
            title: 'Verified',
            description:
              'Welcome in. The rest of the server is now open to you.\n\n' +
              [
                ticketChannel ? `${EMOJIS.ticket} <#${ticketChannel}> — start a project or ask a question` : null,
                freeChannel ? `${EMOJIS.star} <#${freeChannel}> — earn a free build through referrals` : null,
              ].filter(Boolean).join('\n'),
            fields: referral && config.referrals?.enabled
              ? [{
                name: 'Free commission progress',
                value: referral.unlocked
                  ? `${EMOJIS.success} Unlocked — you can apply whenever you like.`
                  : `**${referral.count}/${referral.required}** referrals. Use \`/invites\` for your link.`,
              }]
              : [],
          })],
          components: ticketChannel
            ? componentsUtil.rows([
              componentsUtil.button({
                url: `https://discord.com/channels/${interaction.guildId}/${ticketChannel}`,
                label: 'Start a Project',
                emoji: EMOJIS.ticket,
              }),
            ])
            : [],
        }, { ephemeral: true });
      },
    },
  },
};
