'use strict';

/**
 * /portfolio — publish and manage case studies.
 */

const { SlashCommandBuilder } = require('discord.js');

const portfolioService = require('../../services/portfolioService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const permissions = require('../../utils/permissions');
const { Portfolio, Order } = require('../../database/models');
const { TICKET_TYPES, TICKET_TYPE_MAP } = require('../../config/server');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { padId, table, truncate } = require('../../utils/formatters');

module.exports = {
  access: 'everyone',
  cooldown: 5,
  requiresSetup: true,

  data: new SlashCommandBuilder()
    .setName('portfolio')
    .setDescription('Browse and manage the studio portfolio.')
    .setDMPermission(false)

    .addSubcommand((sub) => sub
      .setName('view')
      .setDescription('Browse published work.')
      .addStringOption((option) => option
        .setName('category')
        .setDescription('Filter by category.')
        .addChoices(...TICKET_TYPES.slice(0, 25).map((type) => ({ name: type.label, value: type.key })))))

    .addSubcommand((sub) => sub
      .setName('add')
      .setDescription('Publish a new case study (staff only).')
      .addStringOption((option) => option.setName('title').setDescription('Project title.').setRequired(true))
      .addStringOption((option) => option
        .setName('category')
        .setDescription('Which service category.')
        .setRequired(true)
        .addChoices(...TICKET_TYPES.slice(0, 25).map((type) => ({ name: type.label, value: type.key }))))
      .addStringOption((option) => option.setName('description').setDescription('What was built and why.').setRequired(true))
      .addStringOption((option) => option.setName('technologies').setDescription('Comma separated, e.g. Node.js, MongoDB'))
      .addStringOption((option) => option.setName('image').setDescription('Image URL shown on the card.'))
      .addStringOption((option) => option.setName('demo').setDescription('Live demo URL.'))
      .addStringOption((option) => option.setName('github').setDescription('Source repository URL.'))
      .addStringOption((option) => option.setName('video').setDescription('Video URL.'))
      .addUserOption((option) => option.setName('customer').setDescription('The client, if they may be credited.'))
      .addBooleanOption((option) => option.setName('permission').setDescription('The customer has agreed to be credited.'))
      .addBooleanOption((option) => option.setName('anonymise').setDescription('Publish without naming the client.'))
      .addIntegerOption((option) => option.setName('order').setDescription('Link to an order number.').setMinValue(1))
      .addBooleanOption((option) => option.setName('featured').setDescription('Feature it immediately.')))

    .addSubcommand((sub) => sub
      .setName('edit')
      .setDescription('Edit a case study (staff only).')
      .addIntegerOption((option) => option.setName('number').setDescription('Entry number.').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('title').setDescription('New title.'))
      .addStringOption((option) => option.setName('description').setDescription('New description.'))
      .addStringOption((option) => option.setName('technologies').setDescription('Comma separated technologies.'))
      .addStringOption((option) => option.setName('image').setDescription('New image URL.'))
      .addStringOption((option) => option.setName('demo').setDescription('New demo URL.'))
      .addStringOption((option) => option.setName('github').setDescription('New repository URL.')))

    .addSubcommand((sub) => sub
      .setName('feature')
      .setDescription('Feature or unfeature an entry (staff only).')
      .addIntegerOption((option) => option.setName('number').setDescription('Entry number.').setRequired(true).setMinValue(1))
      .addBooleanOption((option) => option.setName('featured').setDescription('Feature it (default: true).')))

    .addSubcommand((sub) => sub
      .setName('remove')
      .setDescription('Delete a case study (staff only).')
      .addIntegerOption((option) => option.setName('number').setDescription('Entry number.').setRequired(true).setMinValue(1)))

    .addSubcommand((sub) => sub
      .setName('list')
      .setDescription('List every entry (staff only).')),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember }} context
   */
  async execute(interaction, { config, member }) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    // ── Public browsing ─────────────────────────────────────────────────────
    if (sub === 'view') {
      await safeDefer(interaction, { ephemeral: true });
      const category = interaction.options.getString('category');
      const entries = await Portfolio.showcase(guild.id, { category, limit: 5 });

      if (!entries.length) {
        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: 'Nothing published yet',
            description: category
              ? `No case studies in **${TICKET_TYPE_MAP[category]?.label ?? category}** yet.`
              : 'The portfolio is still being populated. Check back shortly.',
          })],
          components: components.rows([
            components.button({ id: customId.build('ticket', 'open'), label: 'Start a Project', emoji: EMOJIS.ticket, style: 'primary' }),
          ]),
        }, { ephemeral: true });
      }

      return safeReply(interaction, {
        embeds: entries.map((entry) => portfolioService.entryEmbed(entry, config)),
        components: components.rows([
          components.button({ id: customId.build('portfolio', 'browse'), label: 'Browse by Category', emoji: EMOJIS.portfolio, style: 'secondary' }),
          components.button({ id: customId.build('ticket', 'open'), label: 'Start a Project', emoji: EMOJIS.ticket, style: 'primary' }),
        ]),
      }, { ephemeral: true });
    }

    // ── Everything else is staff-only ───────────────────────────────────────
    permissions.assertLevel(member, 'developer', config, 'manage the portfolio');

    if (sub === 'list') {
      const entries = await Portfolio.find({ guildId: guild.id }).sort({ number: -1 }).limit(25).lean();
      if (!entries.length) {
        return safeReply(interaction, {
          embeds: [embeds.notice('The portfolio is empty. Add an entry with `/portfolio add`.', 'info', config)],
        }, { ephemeral: true });
      }
      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: `${EMOJIS.portfolio} Portfolio Entries`,
          description: table(
            ['ID', 'Title', 'Category', 'State'],
            entries.map((entry) => [
              `#${padId(entry.number, 3)}`,
              truncate(entry.title, 22),
              truncate(TICKET_TYPE_MAP[entry.category]?.label ?? entry.category, 16),
              entry.featured ? 'featured' : entry.published ? 'live' : 'draft',
            ]),
          ),
          footer: `${entries.length} entries`,
        })],
      }, { ephemeral: true });
    }

    if (sub === 'add') {
      await safeDefer(interaction, { ephemeral: true });
      const orderNumber = interaction.options.getInteger('order');
      const linkedOrder = orderNumber
        ? await Order.findOne({ guildId: guild.id, number: orderNumber })
        : null;
      if (orderNumber && !linkedOrder) throw new errors.NotFoundError(`Order \`#${padId(orderNumber)}\` does not exist.`);

      const customer = interaction.options.getUser('customer');
      const technologies = (interaction.options.getString('technologies') ?? '')
        .split(',')
        .map((tech) => validators.clean(tech, { max: 30, allowNewlines: false }))
        .filter(Boolean)
        .slice(0, 12);

      const entry = await portfolioService.add({
        guild,
        actor: member,
        config,
        data: {
          title: validators.text(interaction.options.getString('title'), 'Title', { max: 150, allowNewlines: false }),
          category: interaction.options.getString('category'),
          description: validators.text(interaction.options.getString('description'), 'Description', { max: 2000 }),
          technologies,
          images: [interaction.options.getString('image')].filter(Boolean).map((url) => validators.url(url, { label: 'Image' })),
          demoUrl: interaction.options.getString('demo') ? validators.url(interaction.options.getString('demo'), { label: 'Demo' }) : '',
          githubUrl: interaction.options.getString('github') ? validators.url(interaction.options.getString('github'), { label: 'GitHub' }) : '',
          videoUrl: interaction.options.getString('video') ? validators.url(interaction.options.getString('video'), { label: 'Video' }) : '',
          customerId: customer?.id ?? linkedOrder?.userId ?? '',
          customerName: customer?.tag ?? linkedOrder?.username ?? '',
          customerPermission: interaction.options.getBoolean('permission') ?? false,
          anonymised: interaction.options.getBoolean('anonymise') ?? false,
          orderId: linkedOrder?._id ?? null,
          orderNumber: linkedOrder?.number ?? null,
          completedAt: linkedOrder?.completedAt ?? new Date(),
          featured: interaction.options.getBoolean('featured') ?? false,
        },
      });

      return safeReply(interaction, {
        embeds: [
          embeds.success({
            config,
            title: 'Portfolio Entry Published',
            description: `Entry \`#${padId(entry.number, 3)}\` is live in the portfolio channel.`,
          }),
          portfolioService.entryEmbed(entry, config),
        ],
      }, { ephemeral: true });
    }

    const entry = await portfolioService.byNumber(guild.id, interaction.options.getInteger('number'));

    if (sub === 'edit') {
      const technologiesRaw = interaction.options.getString('technologies');
      const changes = {
        title: interaction.options.getString('title')
          ? validators.text(interaction.options.getString('title'), 'Title', { max: 150, allowNewlines: false })
          : undefined,
        description: interaction.options.getString('description')
          ? validators.text(interaction.options.getString('description'), 'Description', { max: 2000 })
          : undefined,
        technologies: technologiesRaw
          ? technologiesRaw.split(',').map((tech) => validators.clean(tech, { max: 30, allowNewlines: false })).filter(Boolean).slice(0, 12)
          : undefined,
        images: interaction.options.getString('image')
          ? [validators.url(interaction.options.getString('image'), { label: 'Image' })]
          : undefined,
        demoUrl: interaction.options.getString('demo')
          ? validators.url(interaction.options.getString('demo'), { label: 'Demo' })
          : undefined,
        githubUrl: interaction.options.getString('github')
          ? validators.url(interaction.options.getString('github'), { label: 'GitHub' })
          : undefined,
      };

      if (Object.values(changes).every((value) => value === undefined)) {
        throw new errors.ValidationError('No changes were provided.');
      }

      await portfolioService.edit(guild, entry, changes, member, config);
      return safeReply(interaction, {
        embeds: [embeds.success({ config, title: 'Entry Updated', description: `Entry \`#${padId(entry.number, 3)}\` has been updated.` })],
      }, { ephemeral: true });
    }

    if (sub === 'feature') {
      const featured = interaction.options.getBoolean('featured') ?? true;
      await portfolioService.setFeatured(guild, entry, featured, member, config);
      return safeReply(interaction, {
        embeds: [embeds.success({
          config,
          title: featured ? 'Entry Featured' : 'Entry Unfeatured',
          description: `Entry \`#${padId(entry.number, 3)}\` has been ${featured ? 'featured and pinned' : 'unfeatured'}.`,
        })],
      }, { ephemeral: true });
    }

    // remove
    permissions.assertLevel(member, 'manager', config, 'delete portfolio entries');
    await portfolioService.remove(guild, entry, member, config);
    return safeReply(interaction, {
      embeds: [embeds.warning({ config, title: 'Entry Removed', description: `Entry \`#${padId(entry.number, 3)}\` has been deleted.` })],
    }, { ephemeral: true });
  },
};
