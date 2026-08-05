'use strict';

/**
 * /promotion — manage promotion partnership applications.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const promotionService = require('../../services/promotionService');
const embeds = require('../../utils/embeds');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const permissions = require('../../utils/permissions');
const { Promotion } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { padId, table, truncate } = require('../../utils/formatters');

module.exports = {
  access: 'support',
  cooldown: 3,
  requiresSetup: true,

  data: new SlashCommandBuilder()
    .setName('promotion')
    .setDescription('Review promotion partnership applications.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)

    .addSubcommand((sub) => sub
      .setName('list')
      .setDescription('List applications.')
      .addStringOption((option) => option
        .setName('status')
        .setDescription('Filter by status.')
        .addChoices(...Object.entries(promotionService.STATUS_META).map(([value, meta]) => ({ name: meta.label, value })))))

    .addSubcommand((sub) => sub
      .setName('view')
      .setDescription('Show an application in full.')
      .addIntegerOption((option) => option.setName('number').setDescription('Application number.').setRequired(true).setMinValue(1)))

    .addSubcommand((sub) => sub
      .setName('approve')
      .setDescription('Approve an application.')
      .addIntegerOption((option) => option.setName('number').setDescription('Application number.').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('message').setDescription('Message sent to the applicant.')))

    .addSubcommand((sub) => sub
      .setName('decline')
      .setDescription('Decline an application.')
      .addIntegerOption((option) => option.setName('number').setDescription('Application number.').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('reason').setDescription('Reason sent to the applicant.').setRequired(true)))

    .addSubcommand((sub) => sub
      .setName('changes')
      .setDescription('Ask the applicant for more information.')
      .addIntegerOption((option) => option.setName('number').setDescription('Application number.').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('message').setDescription('What you need to know.').setRequired(true)))

    .addSubcommand((sub) => sub
      .setName('note')
      .setDescription('Add an internal note to an application.')
      .addIntegerOption((option) => option.setName('number').setDescription('Application number.').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('content').setDescription('The note.').setRequired(true)))

    .addSubcommand((sub) => sub
      .setName('promoted')
      .setDescription('Mark an approved application as actually promoted.')
      .addIntegerOption((option) => option.setName('number').setDescription('Application number.').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('notes').setDescription('How and when it was promoted.')))

    .addSubcommand((sub) => sub
      .setName('archive')
      .setDescription('Archive an application.')
      .addIntegerOption((option) => option.setName('number').setDescription('Application number.').setRequired(true).setMinValue(1))),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember }} context
   */
  async execute(interaction, { config, member }) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    if (sub === 'list') {
      await safeDefer(interaction, { ephemeral: true });
      const status = interaction.options.getString('status');
      const query = { guildId: guild.id };
      if (status) query.status = status;

      const applications = await Promotion.find(query).sort({ createdAt: -1 }).limit(20).lean();
      if (!applications.length) {
        return safeReply(interaction, {
          embeds: [embeds.notice('No applications match that filter.', 'info', config)],
        }, { ephemeral: true });
      }

      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: `${EMOJIS.promotion} Promotion Applications`,
          description: table(
            ['ID', 'Server', 'Players', 'Status'],
            applications.map((application) => [
              `#${padId(application.number, 3)}`,
              truncate(application.serverName, 22),
              application.playerCount !== null && application.playerCount !== undefined ? String(application.playerCount) : '—',
              promotionService.STATUS_META[application.status]?.label ?? application.status,
            ]),
          ),
          footer: `${applications.length} shown`,
        })],
      }, { ephemeral: true });
    }

    const application = await promotionService.byNumber(guild.id, interaction.options.getInteger('number'));

    switch (sub) {
      case 'view':
        return safeReply(interaction, {
          embeds: [promotionService.applicationEmbed(application, config)],
          components: ['approved', 'declined', 'archived'].includes(application.status)
            ? []
            : promotionService.reviewControls(application._id.toString()),
        }, { ephemeral: true });

      case 'approve': {
        permissions.assertLevel(member, 'manager', config, 'approve promotion applications');
        await promotionService.decide({
          guild,
          application,
          status: 'approved',
          actor: member,
          reason: validators.clean(interaction.options.getString('message') ?? '', { max: 900 }),
          config,
        });
        return safeReply(interaction, {
          embeds: [embeds.success({
            config,
            title: 'Application Approved',
            description: `**${truncate(application.serverName, 120)}** has been approved. The applicant has been notified.`,
          })],
        }, { ephemeral: true });
      }

      case 'decline': {
        permissions.assertLevel(member, 'manager', config, 'decline promotion applications');
        await promotionService.decide({
          guild,
          application,
          status: 'declined',
          actor: member,
          reason: validators.text(interaction.options.getString('reason'), 'Reason', { max: 900 }),
          config,
        });
        return safeReply(interaction, {
          embeds: [embeds.warning({
            config,
            title: 'Application Declined',
            description: 'The applicant has been notified with your reason.',
          })],
        }, { ephemeral: true });
      }

      case 'changes': {
        await promotionService.decide({
          guild,
          application,
          status: 'changes-requested',
          actor: member,
          reason: validators.text(interaction.options.getString('message'), 'Message', { max: 900 }),
          config,
        });
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Information Requested', description: 'The applicant has been asked for more detail.' })],
        }, { ephemeral: true });
      }

      case 'note': {
        await promotionService.addNote(application, validators.text(interaction.options.getString('content'), 'Note', { max: 900 }), member);
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Note Added', description: 'Internal notes are never shown to the applicant.' })],
        }, { ephemeral: true });
      }

      case 'promoted': {
        permissions.assertLevel(member, 'manager', config, 'record completed promotions');
        await promotionService.markPromoted(
          guild,
          application,
          member,
          validators.clean(interaction.options.getString('notes') ?? '', { max: 500 }),
          config,
        );
        return safeReply(interaction, {
          embeds: [embeds.success({
            config,
            title: 'Promotion Recorded',
            description: `**${truncate(application.serverName, 120)}** has been marked as promoted.`,
          })],
        }, { ephemeral: true });
      }

      case 'archive': {
        await promotionService.decide({ guild, application, status: 'archived', actor: member, reason: '', config });
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Application Archived', description: `\`#${padId(application.number, 3)}\` has been archived.` })],
        }, { ephemeral: true });
      }

      default:
        throw new errors.ValidationError('Unknown subcommand.');
    }
  },
};
