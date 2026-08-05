'use strict';

/**
 * Ticket select menus: service picker, priority picker, member management and
 * transfer.
 */

const ticketService = require('../../services/ticketService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const errors = require('../../utils/errors');
const { Ticket } = require('../../database/models');
const { PRIORITIES, TICKET_TYPE_MAP } = require('../../config/server');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { padId } = require('../../utils/formatters');

/** Resolve the ticket a menu refers to. */
async function resolveTicket(interaction, args) {
  const [ticketId] = args;
  const ticket = ticketId
    ? await Ticket.findOne({ _id: ticketId, guildId: interaction.guildId })
    : await Ticket.byChannel(interaction.guildId, interaction.channelId);
  if (!ticket) throw new errors.NotFoundError('That ticket no longer exists.');
  return ticket;
}

module.exports = {
  namespace: 'ticket',
  access: 'everyone',

  actions: {
    // ── Service picker → create the ticket ────────────────────────────────
    select: {
      async run(interaction, { config }) {
        const type = interaction.values[0];
        const definition = TICKET_TYPE_MAP[type];
        if (!definition) throw new errors.ValidationError('That service category is not recognised.');

        await safeDefer(interaction, { ephemeral: true });

        const { ticket, channel } = await ticketService.create({
          guild: interaction.guild,
          user: interaction.user,
          type,
          config,
        });

        await safeReply(interaction, {
          embeds: [embeds.success({
            config,
            title: 'Ticket Created',
            description:
              `Your **${definition.label}** request is open in <#${channel.id}>.\n\n` +
              `Expected first response: **${definition.responseTime}**.`,
          })],
          components: components.rows([
            components.button({
              url: `https://discord.com/channels/${interaction.guildId}/${channel.id}`,
              label: `Open Ticket #${padId(ticket.number)}`,
              emoji: EMOJIS.ticket,
            }),
          ]),
        }, { ephemeral: true });

        // Prompt for the project brief inside the new channel.
        if (config.tickets?.autoOpenForm !== false) {
          const { safeSend } = require('../../utils/discord');
          await safeSend(channel, {
            content: `<@${interaction.user.id}>`,
            embeds: [embeds.info({
              config,
              title: `${EMOJIS.order} Tell us about your project`,
              description:
                'Filling in the short form below gets you an accurate quote much faster. ' +
                'You can also just start typing — a member of the team will pick it up either way.',
            })],
            components: components.rows([
              components.button({
                id: customId.build('ticket', 'order', ticket._id.toString()),
                label: definition.form === 'promotion' ? 'Open Application' : 'Open Project Form',
                emoji: EMOJIS.pencil,
                style: 'primary',
              }),
            ]),
          });
        }

        return null;
      },
    },

    // ── Priority ──────────────────────────────────────────────────────────
    prioritySelect: {
      access: 'support',
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        const level = interaction.values[0];
        await ticketService.setPriority(interaction.guild, ticket, level, member, config);
        return interaction.update({
          embeds: [embeds.notice(`Priority set to **${PRIORITIES[level].label}**.`, 'success', config)],
          components: [],
        }).catch(() => null);
      },
    },

    // ── Membership ────────────────────────────────────────────────────────
    addMember: {
      access: 'support',
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        const target = await interaction.guild.members.fetch(interaction.values[0]).catch(() => null);
        if (!target) throw new errors.NotFoundError('That member is not in this server.');
        await ticketService.addMember(interaction.guild, ticket, target, member, config);
        return interaction.update({
          embeds: [embeds.notice(`<@${target.id}> now has access to this ticket.`, 'success', config)],
          components: [],
        }).catch(() => null);
      },
    },

    removeMember: {
      access: 'support',
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        const target = await interaction.guild.members.fetch(interaction.values[0]).catch(() => null);
        if (!target) throw new errors.NotFoundError('That member is not in this server.');
        await ticketService.removeMember(interaction.guild, ticket, target, member, config);
        return interaction.update({
          embeds: [embeds.notice(`<@${target.id}> has been removed from this ticket.`, 'success', config)],
          components: [],
        }).catch(() => null);
      },
    },

    transferTo: {
      access: 'support',
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        const target = await interaction.guild.members.fetch(interaction.values[0]).catch(() => null);
        if (!target) throw new errors.NotFoundError('That member is not in this server.');
        await ticketService.transfer(interaction.guild, ticket, member, target, config);
        return interaction.update({
          embeds: [embeds.notice(`Ticket transferred to <@${target.id}>.`, 'success', config)],
          components: [],
        }).catch(() => null);
      },
    },
  },
};
