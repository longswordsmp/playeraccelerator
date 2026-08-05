'use strict';

/**
 * Ticket modal submissions: close reason, rename, internal note, and the
 * project / free-commission / promotion forms.
 */

const ticketService = require('../../services/ticketService');
const orderService = require('../../services/orderService');
const promotionService = require('../../services/promotionService');
const forms = require('../forms');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const { Ticket } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer, safeSend, resolveTextChannel, attempt } = require('../../utils/discord');
const { padId } = require('../../utils/formatters');

/** Resolve the ticket a modal refers to. */
async function resolveTicket(interaction, args) {
  const [ticketId] = args;
  const ticket = ticketId
    ? await Ticket.findOne({ _id: validators.objectId(ticketId, 'ticket'), guildId: interaction.guildId })
    : await Ticket.byChannel(interaction.guildId, interaction.channelId);
  if (!ticket) throw new errors.NotFoundError('That ticket no longer exists.');
  return ticket;
}

module.exports = {
  namespace: 'ticket',
  access: 'everyone',

  actions: {
    // ── Close ─────────────────────────────────────────────────────────────
    closeSubmit: {
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        ticketService.assertAccess(ticket, member, config);
        await safeDefer(interaction, { ephemeral: true });

        const reason = validators.clean(interaction.fields.getTextInputValue('reason'), { max: 500 });
        await ticketService.close({ guild: interaction.guild, ticket, actor: member, config, reason });

        return safeReply(interaction, {
          embeds: [embeds.notice(`Ticket **#${padId(ticket.number)}** has been closed.`, 'success', config)],
        }, { ephemeral: true });
      },
    },

    // ── Rename ────────────────────────────────────────────────────────────
    renameSubmit: {
      access: 'support',
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        const name = validators.channelName(interaction.fields.getTextInputValue('name'));
        await ticketService.rename(interaction.guild, ticket, name, member, config);
        return safeReply(interaction, {
          embeds: [embeds.notice(`Renamed to \`${ticket.channelName}\`.`, 'success', config)],
        }, { ephemeral: true });
      },
    },

    // ── Internal note ─────────────────────────────────────────────────────
    noteSubmit: {
      access: 'support',
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        const content = validators.text(interaction.fields.getTextInputValue('content'), 'Note', { max: 1500 });
        await ticketService.addNote(interaction.guild, ticket, content, member, config);
        return safeReply(interaction, {
          embeds: [embeds.notice('Internal note saved. The customer cannot see it.', 'success', config)],
        }, { ephemeral: true });
      },
    },

    // ── Project brief → order ─────────────────────────────────────────────
    orderSubmit: {
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        ticketService.assertAccess(ticket, member, config);
        await safeDefer(interaction, { ephemeral: true });

        const brief = forms.parseBrief(interaction, ticket);
        const order = await orderService.createFromBrief({ guild: interaction.guild, ticket, brief, config });

        // Post the summary into the ticket so staff and customer share one view.
        const channel = await resolveTextChannel(interaction.guild, ticket.channelId);
        ticket.form = {
          'Project Name': brief.title,
          Description: brief.description,
          Budget: brief.budget.raw || 'Not specified',
          'Preferred Deadline': brief.deadline || 'Flexible',
          'Reference Links': brief.references.join('\n') || 'None provided',
          'Extra Notes': brief.notes || 'None',
        };
        await ticket.save();

        const summary = await safeSend(channel, {
          embeds: [
            orderService.orderEmbed(order, config),
            embeds.info({
              config,
              title: `${EMOJIS.success} Brief received`,
              description:
                'Thank you. A member of the team will review this and come back with a fixed-price quote.\n\n' +
                'Anything you forgot? Just add it to this channel.',
            }),
          ],
          components: components.rows([
            components.button({ id: customId.build('order', 'quote', order._id.toString()), label: 'Send Quote', emoji: EMOJIS.pricing, style: 'primary' }),
            components.button({ id: customId.build('order', 'status', order._id.toString()), label: 'Update Status', emoji: EMOJIS.order, style: 'secondary' }),
            components.button({ id: customId.build('order', 'assign', order._id.toString()), label: 'Assign', emoji: EMOJIS.staff, style: 'secondary' }),
          ]),
        });
        if (summary) await attempt(() => summary.pin(), { label: 'pin order summary' });

        await ticketService.refreshPanel(interaction.guild, ticket, config);

        return safeReply(interaction, {
          embeds: [embeds.notice(`Your brief was submitted as order **#${padId(order.number)}**.`, 'success', config)],
        }, { ephemeral: true });
      },
    },

    // ── Free commission application ───────────────────────────────────────
    freeCommissionSubmit: {
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        ticketService.assertAccess(ticket, member, config);
        await safeDefer(interaction, { ephemeral: true });

        const brief = forms.parseFreeCommission(interaction, ticket);
        const order = await orderService.createFromBrief({ guild: interaction.guild, ticket, brief, config });

        // Spend the referral unlock now that an application actually exists,
        // so the same three invites cannot be reused indefinitely.
        if (config.referrals?.enabled) {
          const inviteService = require('../../services/inviteService');
          await inviteService.consumeUnlock(interaction.guildId, interaction.user.id).catch(() => null);
        }

        ticket.form = {
          'Project Name': brief.title,
          Description: brief.description,
          Purpose: brief.requirements || '—',
          'Selection Case': brief.notes || '—',
        };
        await ticket.save();

        const channel = await resolveTextChannel(interaction.guild, ticket.channelId);
        await safeSend(channel, {
          embeds: [
            orderService.orderEmbed(order, config),
            embeds.warning({
              config,
              title: 'Free Commission — how this works',
              description:
                'Your application has been recorded and will be reviewed individually.\n\n' +
                `${EMOJIS.bullet} Acceptance is **not guaranteed** — most applications are declined for capacity reasons alone.\n` +
                `${EMOJIS.bullet} Selection is based on originality, usefulness and portfolio value.\n` +
                `${EMOJIS.bullet} Projects with a clear commercial purpose receive a paid quote instead.\n` +
                `${EMOJIS.bullet} Paid work always takes priority, so free builds have no committed deadline.`,
              footer: 'A decision usually takes up to three business days.',
            }),
          ],
        });

        return safeReply(interaction, {
          embeds: [embeds.notice('Your free commission application has been submitted.', 'success', config)],
        }, { ephemeral: true });
      },
    },

    // ── Promotion application ─────────────────────────────────────────────
    promotionSubmit: {
      async run(interaction, { config, member, args }) {
        const ticket = await resolveTicket(interaction, args);
        ticketService.assertAccess(ticket, member, config);
        await safeDefer(interaction, { ephemeral: true });

        const data = forms.parsePromotion(interaction);
        const application = await promotionService.create({
          guild: interaction.guild,
          user: interaction.user,
          data,
          ticket,
          config,
        });

        ticket.subject = data.serverName;
        ticket.form = {
          'Server Name': data.serverName,
          'Server IP': data.serverIp || '—',
          Version: data.version || '—',
          Description: data.description,
          'Unique Features': data.features || '—',
          'Player Count': data.playerCount !== null ? String(data.playerCount) : '—',
          Links: [data.website, data.discordInvite, data.trailerUrl].filter(Boolean).join('\n') || '—',
        };
        await ticket.save();

        const channel = await resolveTextChannel(interaction.guild, ticket.channelId);
        await safeSend(channel, {
          embeds: [
            promotionService.applicationEmbed(application, config),
            embeds.info({
              config,
              title: 'Application received',
              description:
                'Thank you. Your server will be reviewed individually against our audience fit.\n\n' +
                `${EMOJIS.bullet} Meeting the requirements does not guarantee promotion — slots are limited.\n` +
                `${EMOJIS.bullet} We look at stability, originality, moderation quality and how the server plays on camera.\n` +
                `${EMOJIS.bullet} You will receive a decision either way, usually within five business days.`,
            }),
          ],
        });

        return safeReply(interaction, {
          embeds: [embeds.notice(`Application \`#${padId(application.number, 3)}\` submitted for review.`, 'success', config)],
        }, { ephemeral: true });
      },
    },
  },
};
