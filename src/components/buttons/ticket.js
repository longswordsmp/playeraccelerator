'use strict';

/**
 * Ticket buttons.
 *
 * Every action re-authorises from scratch: a custom ID is client-side data and
 * must never be treated as proof that the presser is allowed to do the thing.
 */

const { AttachmentBuilder } = require('discord.js');

const ticketService = require('../../services/ticketService');
const transcriptService = require('../../services/transcriptService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const errors = require('../../utils/errors');
const { TICKET_TYPES, PRIORITIES } = require('../../config/server');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer, safeSend, fetchMember } = require('../../utils/discord');
const { padId } = require('../../utils/formatters');
const { Ticket } = require('../../database/models');

/** Resolve the ticket referenced by a button, defaulting to the channel. */
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
    // ── Open the service picker ───────────────────────────────────────────
    open: {
      async run(interaction, { config }) {
        if (!config.tickets?.enabled) {
          throw new errors.ConflictError('The ticket system is temporarily closed. Please try again later.');
        }

        const enabled = config.tickets?.enabledTypes ?? [];
        const available = TICKET_TYPES.filter((type) => !enabled.length || enabled.includes(type.key));

        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.ticket} What do you need?`,
            description:
              'Choose the service that fits your request. You can add detail once your channel is open.\n\n' +
              'Not sure? Pick **General Support** and we will point you in the right direction.',
          })],
          components: [components.row(components.select({
            id: customId.build('ticket', 'select'),
            placeholder: 'Select a service…',
            options: available.map((type) => ({
              label: type.label,
              value: type.key,
              description: type.description,
              emoji: type.emoji,
            })),
          }))],
        }, { ephemeral: true });
      },
    },

    // ── Open a specific service directly, skipping the picker ─────────────
    quickOpen: {
      async run(interaction, { config, args }) {
        const [type] = args;
        if (!TICKET_TYPES.some((entry) => entry.key === type)) {
          throw new errors.ValidationError('That service category is not recognised.');
        }
        await safeDefer(interaction, { ephemeral: true });

        const { ticket, channel } = await ticketService.create({
          guild: interaction.guild,
          user: interaction.user,
          type,
          config,
        });

        // Take them straight to the form for this service.
        await safeSend(channel, {
          content: `<@${interaction.user.id}>`,
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.pencil} Complete your application`,
            description: 'Use the button below to open the form. The more detail you give, the better your chances.',
          })],
          components: components.rows([
            components.button({
              id: customId.build('ticket', 'order', ticket._id.toString()),
              label: 'Open Application Form',
              emoji: EMOJIS.pencil,
              style: 'primary',
            }),
          ]),
        });

        return safeReply(interaction, {
          embeds: [embeds.success({
            config,
            title: 'Application Started',
            description: `Continue in <#${channel.id}>.`,
          })],
        }, { ephemeral: true });
      },
    },

    // ── Claim / release ───────────────────────────────────────────────────
    claim: {
      access: 'support',
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        await ticketService.claim(interaction.guild, ticket, member, config);
        return safeReply(interaction, {
          embeds: [embeds.notice(`You are now handling ticket **#${padId(ticket.number)}**.`, 'success', config)],
        }, { ephemeral: true });
      },
    },

    unclaim: {
      access: 'support',
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        await ticketService.unclaim(interaction.guild, ticket, member, config);
        return safeReply(interaction, {
          embeds: [embeds.notice('Ticket released back to the pool.', 'success', config)],
        }, { ephemeral: true });
      },
    },

    // ── Close ─────────────────────────────────────────────────────────────
    close: {
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        ticketService.assertAccess(ticket, member, config);

        return interaction.showModal(components.modal({
          id: customId.build('ticket', 'closeSubmit', ticket._id.toString()),
          title: `Close Ticket #${padId(ticket.number)}`,
          fields: [
            {
              id: 'reason',
              label: 'Reason (optional)',
              style: 'paragraph',
              required: false,
              placeholder: 'Delivered and accepted / duplicate / no longer needed…',
              max: 500,
            },
          ],
        }));
      },
    },

    reopen: {
      access: 'support',
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        await ticketService.reopen(interaction.guild, ticket, member, config);
        return safeReply(interaction, {
          embeds: [embeds.notice(`Ticket **#${padId(ticket.number)}** has been reopened.`, 'success', config)],
        }, { ephemeral: true });
      },
    },

    // ── Delete ────────────────────────────────────────────────────────────
    delete: {
      access: 'manager',
      async run(interaction, { config, args }) {
        const ticket = await resolveTicket(interaction, args);
        return safeReply(interaction, {
          embeds: [embeds.warning({
            config,
            title: 'Delete this ticket channel?',
            description:
              `The channel for **#${padId(ticket.number)}** and all of its messages will be permanently removed.\n\n` +
              'The ticket record, statistics and transcript are kept.',
          })],
          components: components.confirmation('ticket', 'confirmDelete', [ticket._id.toString()], { confirmLabel: 'Delete Channel' }),
        }, { ephemeral: true });
      },
    },

    confirmDelete: {
      access: 'manager',
      async run(interaction, { config, args }) {
        const ticket = await resolveTicket(interaction, args);
        await interaction.update({
          embeds: [embeds.notice('Deleting the channel…', 'info', config)],
          components: [],
        }).catch(() => null);
        await ticketService.purge(interaction.guild, ticket, `Deleted by ${interaction.user.tag}`);
        return null;
      },
    },

    // ── Priority ──────────────────────────────────────────────────────────
    priority: {
      access: 'support',
      async run(interaction, { config, args }) {
        const ticket = await resolveTicket(interaction, args);
        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.priority} Set Priority`,
            description: `Ticket **#${padId(ticket.number)}** is currently **${PRIORITIES[ticket.priority].label}**.`,
          })],
          components: [components.row(components.select({
            id: customId.build('ticket', 'prioritySelect', ticket._id.toString()),
            placeholder: 'Choose a priority…',
            options: Object.entries(PRIORITIES).map(([key, meta]) => ({
              label: meta.label,
              value: key,
              emoji: meta.emoji,
              description: `Target first response: ${meta.sla >= 60 ? `${Math.round(meta.sla / 60)}h` : `${meta.sla}m`}`,
              default: key === ticket.priority,
            })),
          }))],
        }, { ephemeral: true });
      },
    },

    // ── Members ───────────────────────────────────────────────────────────
    members: {
      access: 'support',
      async run(interaction, { config, args }) {
        const ticket = await resolveTicket(interaction, args);

        // Resolve names so the remove menu reads as people, not snowflakes.
        // Anyone who has since left is still listed, so they can be cleaned up.
        const participants = await Promise.all(
          ticket.participants.slice(0, 25).map(async (id) => {
            const resolved = await fetchMember(interaction.guild, id);
            return { id, label: resolved?.user?.tag ?? `Left the server (${id})` };
          }),
        );

        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.users} Ticket Members`,
            description:
              `**Customer:** <@${ticket.userId}>\n` +
              `**Additional:** ${participants.length ? participants.map((entry) => `<@${entry.id}>`).join(', ') : '_none_'}`,
            footer: 'Pick someone to add, or use the remove menu below.',
          })],
          components: [
            components.row(components.userSelect({
              id: customId.build('ticket', 'addMember', ticket._id.toString()),
              placeholder: 'Add a member to this ticket…',
            })),
            ...(participants.length
              ? [components.row(components.select({
                id: customId.build('ticket', 'removeMember', ticket._id.toString()),
                placeholder: 'Remove a member…',
                options: participants.map((entry) => ({ label: entry.label, value: entry.id })),
              }))]
              : []),
          ],
        }, { ephemeral: true });
      },
    },

    // ── Overflow menu ─────────────────────────────────────────────────────
    manage: {
      access: 'support',
      async run(interaction, { config, args }) {
        const ticket = await resolveTicket(interaction, args);
        const id = ticket._id.toString();

        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.pencil} Manage Ticket #${padId(ticket.number)}`,
            description: 'Additional actions for this ticket.',
          })],
          components: [
            ...components.rows([
              components.button({ id: customId.build('ticket', 'rename', id), label: 'Rename', emoji: EMOJIS.pencil, style: 'secondary' }),
              components.button({ id: customId.build('ticket', 'note', id), label: 'Add Note', emoji: EMOJIS.note, style: 'secondary' }),
              components.button({ id: customId.build('ticket', 'transcript', id), label: 'Transcript', emoji: EMOJIS.transcript, style: 'secondary' }),
              components.button({ id: customId.build('ticket', 'order', id), label: 'Project Form', emoji: EMOJIS.order, style: 'primary' }),
            ]),
            components.row(components.userSelect({
              id: customId.build('ticket', 'transferTo', id),
              placeholder: 'Transfer this ticket to…',
            })),
          ],
        }, { ephemeral: true });
      },
    },

    rename: {
      access: 'support',
      async run(interaction, { args }) {
        const ticket = await resolveTicket(interaction, args);
        return interaction.showModal(components.modal({
          id: customId.build('ticket', 'renameSubmit', ticket._id.toString()),
          title: `Rename Ticket #${padId(ticket.number)}`,
          fields: [{
            id: 'name',
            label: 'New name',
            placeholder: 'website-redesign',
            max: 60,
          }],
        }));
      },
    },

    note: {
      access: 'support',
      async run(interaction, { args }) {
        const ticket = await resolveTicket(interaction, args);
        return interaction.showModal(components.modal({
          id: customId.build('ticket', 'noteSubmit', ticket._id.toString()),
          title: `Internal Note · #${padId(ticket.number)}`,
          fields: [{
            id: 'content',
            label: 'Note (staff only)',
            style: 'paragraph',
            placeholder: 'Context the next person on this ticket should know…',
            max: 1500,
          }],
        }));
      },
    },

    // ── Transcript ────────────────────────────────────────────────────────
    transcript: {
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        ticketService.assertAccess(ticket, member, config);
        await safeDefer(interaction, { ephemeral: true });

        let path = ticket.transcript?.htmlPath;
        if (!path) {
          const channel = ticket.channelId ? interaction.guild.channels.cache.get(ticket.channelId) : null;
          if (!channel) throw new errors.NotFoundError('No transcript exists and the channel is gone, so one cannot be generated.');
          const generated = await transcriptService.generate(channel, ticket, {
            markdown: config.tickets?.markdownTranscripts === true,
            brandName: config.brand?.name,
          });
          ticket.transcript = {
            generated: true,
            htmlPath: generated.htmlPath,
            markdownPath: generated.markdownPath,
            url: generated.url,
            messageCount: generated.messageCount,
            generatedAt: new Date(),
          };
          await ticket.save();
          path = generated.htmlPath;
        }

        const file = await transcriptService.read(path);
        if (!file) throw new errors.NotFoundError('The transcript file could not be read from disk.');

        return safeReply(interaction, {
          embeds: [embeds.success({
            config,
            title: 'Transcript',
            description: `Ticket **#${padId(ticket.number)}** · ${ticket.transcript.messageCount} messages`,
            fields: ticket.transcript.url ? [{ name: 'Link', value: `[Open in browser](${ticket.transcript.url})` }] : [],
          })],
          files: [new AttachmentBuilder(file.buffer, { name: file.name })],
        }, { ephemeral: true });
      },
    },

    // ── Project brief ─────────────────────────────────────────────────────
    order: {
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        ticketService.assertAccess(ticket, member, config);
        const forms = require('../forms');
        return interaction.showModal(forms.buildForm(ticket));
      },
    },
  },
};
