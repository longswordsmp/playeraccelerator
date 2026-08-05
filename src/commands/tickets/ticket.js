'use strict';

/**
 * /ticket — the full ticket lifecycle from one command.
 *
 * Everything here is also reachable through the buttons on the ticket panel;
 * the command exists for staff who prefer the keyboard and for scripting.
 */

const { SlashCommandBuilder } = require('discord.js');

const ticketService = require('../../services/ticketService');
const transcriptService = require('../../services/transcriptService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const permissions = require('../../utils/permissions');
const { Ticket } = require('../../database/models');
const { TICKET_TYPES, PRIORITIES } = require('../../config/server');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { padId, timestamp, duration, table, truncate } = require('../../utils/formatters');
const { AttachmentBuilder } = require('discord.js');

module.exports = {
  access: 'everyone',
  cooldown: 5,
  requiresSetup: true,

  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Open, manage and inspect support tickets.')
    .setDMPermission(false)

    .addSubcommand((sub) => sub
      .setName('open')
      .setDescription('Open a new ticket.')
      .addStringOption((option) => option
        .setName('service')
        .setDescription('What do you need?')
        .setRequired(true)
        .addChoices(...TICKET_TYPES.slice(0, 25).map((type) => ({ name: `${type.emoji} ${type.label}`, value: type.key })))))

    .addSubcommand((sub) => sub
      .setName('close')
      .setDescription('Close this ticket.')
      .addStringOption((option) => option.setName('reason').setDescription('Why is it being closed?'))
      .addBooleanOption((option) => option.setName('request-review').setDescription('Ask the customer for a review (default: yes).')))

    .addSubcommand((sub) => sub
      .setName('reopen')
      .setDescription('Reopen a closed ticket.')
      .addIntegerOption((option) => option.setName('number').setDescription('Ticket number, if you are not in the channel.').setMinValue(1)))

    .addSubcommand((sub) => sub
      .setName('claim')
      .setDescription('Claim this ticket.'))

    .addSubcommand((sub) => sub
      .setName('unclaim')
      .setDescription('Release this ticket back to the pool.'))

    .addSubcommand((sub) => sub
      .setName('transfer')
      .setDescription('Transfer this ticket to another staff member.')
      .addUserOption((option) => option.setName('staff').setDescription('Who takes it over.').setRequired(true)))

    .addSubcommand((sub) => sub
      .setName('priority')
      .setDescription('Set the priority of this ticket.')
      .addStringOption((option) => option
        .setName('level')
        .setDescription('Priority level.')
        .setRequired(true)
        .addChoices(...Object.entries(PRIORITIES).map(([value, meta]) => ({ name: `${meta.emoji} ${meta.label}`, value })))))

    .addSubcommand((sub) => sub
      .setName('rename')
      .setDescription('Rename this ticket channel.')
      .addStringOption((option) => option.setName('name').setDescription('New name (the ticket number is kept).').setRequired(true)))

    .addSubcommand((sub) => sub
      .setName('add')
      .setDescription('Give someone access to this ticket.')
      .addUserOption((option) => option.setName('member').setDescription('Who to add.').setRequired(true)))

    .addSubcommand((sub) => sub
      .setName('remove')
      .setDescription('Remove someone from this ticket.')
      .addUserOption((option) => option.setName('member').setDescription('Who to remove.').setRequired(true)))

    .addSubcommand((sub) => sub
      .setName('note')
      .setDescription('Add an internal staff note (never shown to the customer).')
      .addStringOption((option) => option.setName('content').setDescription('The note.').setRequired(true)))

    .addSubcommand((sub) => sub
      .setName('notes')
      .setDescription('Read the internal notes on this ticket.'))

    .addSubcommand((sub) => sub
      .setName('transcript')
      .setDescription('Generate or retrieve the transcript for this ticket.')
      .addIntegerOption((option) => option.setName('number').setDescription('Ticket number, if you are not in the channel.').setMinValue(1)))

    .addSubcommand((sub) => sub
      .setName('delete')
      .setDescription('Permanently delete this ticket channel (the record is kept).'))

    .addSubcommand((sub) => sub
      .setName('info')
      .setDescription('Show the full detail of a ticket.')
      .addIntegerOption((option) => option.setName('number').setDescription('Ticket number. Defaults to this channel.').setMinValue(1)))

    .addSubcommand((sub) => sub
      .setName('list')
      .setDescription('List tickets.')
      .addStringOption((option) => option
        .setName('status')
        .setDescription('Filter by status.')
        .addChoices(
          { name: 'Open', value: 'open' },
          { name: 'Claimed', value: 'claimed' },
          { name: 'Waiting on customer', value: 'pending' },
          { name: 'Closed', value: 'closed' },
          { name: 'Archived', value: 'archived' },
        ))
      .addUserOption((option) => option.setName('customer').setDescription('Filter by customer.'))
      .addUserOption((option) => option.setName('staff').setDescription('Filter by assigned staff member.'))),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember }} context
   */
  async execute(interaction, { config, member }) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    // ── Open ────────────────────────────────────────────────────────────────
    if (sub === 'open') {
      await safeDefer(interaction, { ephemeral: true });
      const { ticket, channel } = await ticketService.create({
        guild,
        user: interaction.user,
        type: interaction.options.getString('service'),
        config,
      });

      return safeReply(interaction, {
        embeds: [embeds.success({
          config,
          title: 'Ticket Created',
          description: `Your ticket **#${padId(ticket.number)}** is ready in <#${channel.id}>.`,
          fields: [{ name: 'Next', value: 'Head to the channel and tell us what you need. A project form is waiting there.' }],
        })],
        components: components.rows([
          components.button({ url: `https://discord.com/channels/${guild.id}/${channel.id}`, label: 'Open Ticket', emoji: EMOJIS.ticket }),
        ]),
      }, { ephemeral: true });
    }

    // ── List ────────────────────────────────────────────────────────────────
    if (sub === 'list') {
      permissions.assertLevel(member, 'support', config, 'list tickets');
      await safeDefer(interaction, { ephemeral: true });

      const query = { guildId: guild.id };
      const status = interaction.options.getString('status');
      const customer = interaction.options.getUser('customer');
      const staff = interaction.options.getUser('staff');
      if (status) query.status = status;
      if (customer) query.userId = customer.id;
      if (staff) query.assignedTo = staff.id;

      const tickets = await Ticket.find(query).sort({ createdAt: -1 }).limit(20).lean();
      if (!tickets.length) {
        return safeReply(interaction, {
          embeds: [embeds.notice('No tickets match that filter.', 'info', config)],
        }, { ephemeral: true });
      }

      const rows = tickets.map((ticket) => [
        `#${padId(ticket.number)}`,
        truncate(ticket.typeLabel || ticket.type, 16),
        ticket.status,
        ticket.assignedName ? truncate(ticket.assignedName, 14) : '—',
        new Date(ticket.createdAt).toISOString().slice(5, 10),
      ]);

      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: `${EMOJIS.ticket} Tickets`,
          description: table(['ID', 'Service', 'Status', 'Staff', 'Date'], rows),
          footer: `${tickets.length} shown`,
        })],
      }, { ephemeral: true });
    }

    // ── Everything else operates on a specific ticket ───────────────────────
    const explicitNumber = interaction.options.getInteger('number');
    let ticket;
    if (explicitNumber) {
      ticket = await Ticket.findOne({ guildId: guild.id, number: explicitNumber });
      if (!ticket) throw new errors.NotFoundError(`Ticket \`#${padId(explicitNumber)}\` does not exist.`);
    } else {
      ticket = await ticketService.resolve(interaction);
    }

    switch (sub) {
      case 'info': {
        ticketService.assertAccess(ticket, member, config);
        const isStaff = permissions.isStaff(member, config);

        return safeReply(interaction, {
          embeds: [
            ticketService.ticketEmbed(ticket, config),
            ...(ticketService.formEmbed(ticket, config) ? [ticketService.formEmbed(ticket, config)] : []),
            ...(isStaff
              ? [embeds.info({
                config,
                title: 'Service Metrics',
                fields: [
                  { name: 'First response', value: ticket.firstResponseMinutes !== null ? duration(ticket.firstResponseMinutes * 60_000, { compact: true }) : '_pending_', inline: true },
                  { name: 'Average reply', value: ticket.averageResponseMinutes !== null ? duration(ticket.averageResponseMinutes * 60_000, { compact: true }) : '—', inline: true },
                  { name: 'Messages', value: String(ticket.messageCount), inline: true },
                  { name: 'Reopened', value: String(ticket.reopenCount), inline: true },
                  { name: 'Notes', value: String(ticket.notes.length), inline: true },
                  { name: 'Transcript', value: ticket.transcript?.generated ? 'Available' : 'Not generated', inline: true },
                  ...(ticket.closedAt ? [{ name: 'Closed', value: `${timestamp(ticket.closedAt, 'relative')} by ${ticket.closedByName}` }] : []),
                ],
              })]
              : []),
          ],
        }, { ephemeral: true });
      }

      case 'close': {
        ticketService.assertAccess(ticket, member, config);
        await safeDefer(interaction, { ephemeral: true });
        const { ticket: closed } = await ticketService.close({
          guild,
          ticket,
          actor: member,
          config,
          reason: interaction.options.getString('reason') ?? '',
          requestReview: interaction.options.getBoolean('request-review') ?? true,
        });
        return safeReply(interaction, {
          embeds: [embeds.success({
            config,
            title: 'Ticket Closed',
            description: `Ticket **#${padId(closed.number)}** is closed. A transcript has been archived.`,
          })],
        }, { ephemeral: true });
      }

      case 'reopen': {
        permissions.assertLevel(member, 'support', config, 'reopen tickets');
        await ticketService.reopen(guild, ticket, member, config);
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Ticket Reopened', description: `Ticket **#${padId(ticket.number)}** is open again.` })],
        }, { ephemeral: true });
      }

      case 'claim': {
        permissions.assertLevel(member, 'support', config, 'claim tickets');
        await ticketService.claim(guild, ticket, member, config);
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Claimed', description: `You are now handling ticket **#${padId(ticket.number)}**.` })],
        }, { ephemeral: true });
      }

      case 'unclaim': {
        permissions.assertLevel(member, 'support', config, 'release tickets');
        await ticketService.unclaim(guild, ticket, member, config);
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Released', description: `Ticket **#${padId(ticket.number)}** is back in the pool.` })],
        }, { ephemeral: true });
      }

      case 'transfer': {
        permissions.assertLevel(member, 'support', config, 'transfer tickets');
        const target = await guild.members.fetch(interaction.options.getUser('staff').id).catch(() => null);
        if (!target) throw new errors.NotFoundError('That member is not in this server.');
        await ticketService.transfer(guild, ticket, member, target, config);
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Transferred', description: `Ticket **#${padId(ticket.number)}** now belongs to <@${target.id}>.` })],
        }, { ephemeral: true });
      }

      case 'priority': {
        permissions.assertLevel(member, 'support', config, 'change ticket priority');
        const level = interaction.options.getString('level');
        await ticketService.setPriority(guild, ticket, level, member, config);
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Priority Updated', description: `Ticket **#${padId(ticket.number)}** is now **${PRIORITIES[level].label}**.` })],
        }, { ephemeral: true });
      }

      case 'rename': {
        permissions.assertLevel(member, 'support', config, 'rename tickets');
        const name = validators.channelName(interaction.options.getString('name'));
        await ticketService.rename(guild, ticket, name, member, config);
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Renamed', description: `The channel is now \`${ticket.channelName}\`.` })],
        }, { ephemeral: true });
      }

      case 'add': {
        ticketService.assertAccess(ticket, member, config, { staffOnly: true });
        const target = await guild.members.fetch(interaction.options.getUser('member').id).catch(() => null);
        if (!target) throw new errors.NotFoundError('That member is not in this server.');
        await ticketService.addMember(guild, ticket, target, member, config);
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Member Added', description: `<@${target.id}> can now see this ticket.` })],
        }, { ephemeral: true });
      }

      case 'remove': {
        ticketService.assertAccess(ticket, member, config, { staffOnly: true });
        const target = await guild.members.fetch(interaction.options.getUser('member').id).catch(() => null);
        if (!target) throw new errors.NotFoundError('That member is not in this server.');
        await ticketService.removeMember(guild, ticket, target, member, config);
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Member Removed', description: `<@${target.id}> no longer has access.` })],
        }, { ephemeral: true });
      }

      case 'note': {
        permissions.assertLevel(member, 'support', config, 'add internal notes');
        const content = validators.text(interaction.options.getString('content'), 'Note', { max: 2000 });
        await ticketService.addNote(guild, ticket, content, member, config);
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Note Added', description: 'Saved. Internal notes are never shown to the customer.' })],
        }, { ephemeral: true });
      }

      case 'notes': {
        permissions.assertLevel(member, 'support', config, 'read internal notes');
        if (!ticket.notes.length) {
          return safeReply(interaction, {
            embeds: [embeds.notice('This ticket has no internal notes.', 'info', config)],
          }, { ephemeral: true });
        }
        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.note} Internal Notes · #${padId(ticket.number)}`,
            fields: ticket.notes.slice(-10).map((note) => ({
              name: `${note.authorName || 'Staff'} · ${new Date(note.createdAt).toISOString().slice(0, 16).replace('T', ' ')}`,
              value: truncate(note.content, 1000),
            })),
            footer: `${ticket.notes.length} note(s) total`,
          })],
        }, { ephemeral: true });
      }

      case 'transcript': {
        ticketService.assertAccess(ticket, member, config);
        await safeDefer(interaction, { ephemeral: true });

        // Serve the stored transcript when one exists.
        if (ticket.transcript?.generated && ticket.transcript.htmlPath) {
          const file = await transcriptService.read(ticket.transcript.htmlPath);
          if (file) {
            return safeReply(interaction, {
              embeds: [embeds.success({
                config,
                title: 'Transcript',
                description: `Ticket **#${padId(ticket.number)}** · ${ticket.transcript.messageCount} messages`,
                fields: ticket.transcript.url ? [{ name: 'Link', value: `[Open in browser](${ticket.transcript.url})` }] : [],
              })],
              files: [new AttachmentBuilder(file.buffer, { name: file.name })],
            }, { ephemeral: true });
          }
        }

        // Otherwise generate one now, if the channel still exists.
        const channel = ticket.channelId ? guild.channels.cache.get(ticket.channelId) : null;
        if (!channel) {
          throw new errors.NotFoundError('No stored transcript exists and the ticket channel is gone, so one cannot be generated.');
        }

        const transcript = await transcriptService.generate(channel, ticket, {
          markdown: config.tickets?.markdownTranscripts === true,
          brandName: config.brand?.name,
        });
        ticket.transcript = {
          generated: true,
          htmlPath: transcript.htmlPath,
          markdownPath: transcript.markdownPath,
          url: transcript.url,
          messageCount: transcript.messageCount,
          generatedAt: new Date(),
        };
        await ticket.save();

        const file = await transcriptService.read(transcript.htmlPath);
        return safeReply(interaction, {
          embeds: [embeds.success({
            config,
            title: 'Transcript Generated',
            description: `Ticket **#${padId(ticket.number)}** · ${transcript.messageCount} messages captured.`,
          })],
          files: file ? [new AttachmentBuilder(file.buffer, { name: file.name })] : [],
        }, { ephemeral: true });
      }

      case 'delete': {
        permissions.assertLevel(member, 'manager', config, 'delete tickets');
        await safeReply(interaction, {
          embeds: [embeds.warning({
            config,
            title: 'Delete this ticket?',
            description:
              `The channel for ticket **#${padId(ticket.number)}** will be permanently deleted along with its messages.\n\n` +
              'The database record, statistics and any generated transcript are kept.',
          })],
          components: components.confirmation('ticket', 'confirmDelete', [ticket._id.toString()], { confirmLabel: 'Delete Channel' }),
        }, { ephemeral: true });
        return null;
      }

      default:
        throw new errors.ValidationError('Unknown subcommand.');
    }
  },
};
