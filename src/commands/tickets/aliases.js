'use strict';

/**
 * Top-level ticket verbs.
 *
 * `/ticket <sub>` covers everything, but staff live in these channels all day
 * and `/claim` is materially faster than `/ticket claim`. Each command here is a
 * thin wrapper that resolves the ticket from the current channel and delegates
 * to `ticketService` — no logic is duplicated.
 */

const { SlashCommandBuilder, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');

const ticketService = require('../../services/ticketService');
const transcriptService = require('../../services/transcriptService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const { PRIORITIES } = require('../../config/server');
const { safeReply, safeDefer } = require('../../utils/discord');
const { padId } = require('../../utils/formatters');

/** Build a ticket alias command. */
function build({ name, description, access, options = [], run, cooldown = 3, defaultPermission = PermissionFlagsBits.ManageMessages }) {
  const data = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDMPermission(false);
  if (defaultPermission) data.setDefaultMemberPermissions(defaultPermission);
  for (const apply of options) apply(data);
  return { access, cooldown, requiresSetup: true, data, execute: run };
}

// ── /claim ───────────────────────────────────────────────────────────────────
const claim = build({
  name: 'claim',
  description: 'Claim the ticket in this channel.',
  access: 'support',
  async run(interaction, { config, member }) {
    const ticket = await ticketService.resolve(interaction);
    await ticketService.claim(interaction.guild, ticket, member, config);
    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: 'Claimed',
        description: `You are handling ticket **#${padId(ticket.number)}**. The customer has been told.`,
      })],
    }, { ephemeral: true });
  },
});

// ── /unclaim ─────────────────────────────────────────────────────────────────
const unclaim = build({
  name: 'unclaim',
  description: 'Release the ticket in this channel back to the pool.',
  access: 'support',
  async run(interaction, { config, member }) {
    const ticket = await ticketService.resolve(interaction);
    await ticketService.unclaim(interaction.guild, ticket, member, config);
    return safeReply(interaction, {
      embeds: [embeds.success({ config, title: 'Released', description: `Ticket **#${padId(ticket.number)}** is unassigned again.` })],
    }, { ephemeral: true });
  },
});

// ── /close ───────────────────────────────────────────────────────────────────
const close = build({
  name: 'close',
  description: 'Close the ticket in this channel.',
  access: 'everyone',
  defaultPermission: null,
  options: [
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why it is being closed.')),
    (data) => data.addBooleanOption((option) => option.setName('transcript').setDescription('Generate a transcript (default: yes).')),
    (data) => data.addBooleanOption((option) => option.setName('review').setDescription('Ask the customer for a review (default: yes).')),
  ],
  async run(interaction, { config, member }) {
    const ticket = await ticketService.resolve(interaction);
    ticketService.assertAccess(ticket, member, config);
    await safeDefer(interaction, { ephemeral: true });

    // A per-close override of the guild transcript setting.
    const wantsTranscript = interaction.options.getBoolean('transcript');
    const effectiveConfig = wantsTranscript === false
      ? { ...config.toObject?.() ?? config, tickets: { ...config.tickets, transcripts: false } }
      : config;

    await ticketService.close({
      guild: interaction.guild,
      ticket,
      actor: member,
      config: effectiveConfig,
      reason: validators.clean(interaction.options.getString('reason') ?? '', { max: 500 }),
      requestReview: interaction.options.getBoolean('review') ?? true,
    });

    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: 'Ticket Closed',
        description: `Ticket **#${padId(ticket.number)}** is closed and archived.`,
      })],
    }, { ephemeral: true });
  },
});

// ── /reopen ──────────────────────────────────────────────────────────────────
const reopen = build({
  name: 'reopen',
  description: 'Reopen the closed ticket in this channel.',
  access: 'support',
  async run(interaction, { config, member }) {
    const ticket = await ticketService.resolve(interaction);
    await ticketService.reopen(interaction.guild, ticket, member, config);
    return safeReply(interaction, {
      embeds: [embeds.success({ config, title: 'Reopened', description: `Ticket **#${padId(ticket.number)}** is open again.` })],
    }, { ephemeral: true });
  },
});

// ── /priority ────────────────────────────────────────────────────────────────
const priority = build({
  name: 'priority',
  description: 'Set the priority of the ticket in this channel.',
  access: 'support',
  options: [
    (data) => data.addStringOption((option) => option
      .setName('level')
      .setDescription('Priority level.')
      .setRequired(true)
      .addChoices(...Object.entries(PRIORITIES).map(([value, meta]) => ({ name: `${meta.emoji} ${meta.label}`, value })))),
  ],
  async run(interaction, { config, member }) {
    const ticket = await ticketService.resolve(interaction);
    const level = interaction.options.getString('level');
    await ticketService.setPriority(interaction.guild, ticket, level, member, config);
    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: 'Priority Updated',
        description: `Ticket **#${padId(ticket.number)}** is now **${PRIORITIES[level].label}**.`,
      })],
    }, { ephemeral: true });
  },
});

// ── /rename ──────────────────────────────────────────────────────────────────
const rename = build({
  name: 'rename',
  description: 'Rename the ticket channel.',
  access: 'support',
  options: [
    (data) => data.addStringOption((option) => option.setName('name').setDescription('New name; the ticket number is preserved.').setRequired(true)),
  ],
  async run(interaction, { config, member }) {
    const ticket = await ticketService.resolve(interaction);
    const name = validators.channelName(interaction.options.getString('name'));
    await ticketService.rename(interaction.guild, ticket, name, member, config);
    return safeReply(interaction, {
      embeds: [embeds.success({ config, title: 'Renamed', description: `The channel is now \`${ticket.channelName}\`.` })],
    }, { ephemeral: true });
  },
});

// ── /add ─────────────────────────────────────────────────────────────────────
const add = build({
  name: 'add',
  description: 'Give someone access to this ticket.',
  access: 'support',
  options: [
    (data) => data.addUserOption((option) => option.setName('member').setDescription('Who to add.').setRequired(true)),
  ],
  async run(interaction, { config, member }) {
    const ticket = await ticketService.resolve(interaction);
    const target = await interaction.guild.members.fetch(interaction.options.getUser('member').id).catch(() => null);
    if (!target) throw new errors.NotFoundError('That member is not in this server.');
    await ticketService.addMember(interaction.guild, ticket, target, member, config);
    return safeReply(interaction, {
      embeds: [embeds.success({ config, title: 'Member Added', description: `<@${target.id}> can now see this ticket.` })],
    }, { ephemeral: true });
  },
});

// ── /remove ──────────────────────────────────────────────────────────────────
const remove = build({
  name: 'remove',
  description: 'Remove someone from this ticket.',
  access: 'support',
  options: [
    (data) => data.addUserOption((option) => option.setName('member').setDescription('Who to remove.').setRequired(true)),
  ],
  async run(interaction, { config, member }) {
    const ticket = await ticketService.resolve(interaction);
    const target = await interaction.guild.members.fetch(interaction.options.getUser('member').id).catch(() => null);
    if (!target) throw new errors.NotFoundError('That member is not in this server.');
    await ticketService.removeMember(interaction.guild, ticket, target, member, config);
    return safeReply(interaction, {
      embeds: [embeds.success({ config, title: 'Member Removed', description: `<@${target.id}> no longer has access.` })],
    }, { ephemeral: true });
  },
});

// ── /transcript ──────────────────────────────────────────────────────────────
const transcript = build({
  name: 'transcript',
  description: 'Generate or retrieve the transcript for this ticket.',
  access: 'everyone',
  defaultPermission: null,
  cooldown: 15,
  async run(interaction, { config, member }) {
    const ticket = await ticketService.resolve(interaction);
    ticketService.assertAccess(ticket, member, config);
    await safeDefer(interaction, { ephemeral: true });

    let filePath = ticket.transcript?.htmlPath;
    if (!filePath) {
      const channel = interaction.guild.channels.cache.get(ticket.channelId);
      if (!channel) throw new errors.NotFoundError('The ticket channel no longer exists, so a transcript cannot be generated.');
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
      filePath = generated.htmlPath;
    }

    const file = await transcriptService.read(filePath);
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
});

// ── /delete ──────────────────────────────────────────────────────────────────
const remove2 = build({
  name: 'delete',
  description: 'Permanently delete this ticket channel (the record is kept).',
  access: 'manager',
  cooldown: 10,
  async run(interaction, { config }) {
    const ticket = await ticketService.resolve(interaction);
    return safeReply(interaction, {
      embeds: [embeds.warning({
        config,
        title: 'Delete this ticket channel?',
        description:
          `The channel for **#${padId(ticket.number)}** and every message in it will be permanently removed.\n\n` +
          'The ticket record, its statistics and any generated transcript are kept.',
      })],
      components: components.confirmation('ticket', 'confirmDelete', [ticket._id.toString()], { confirmLabel: 'Delete Channel' }),
    }, { ephemeral: true });
  },
});

module.exports = [claim, unclaim, close, reopen, priority, rename, add, remove, transcript, remove2];
