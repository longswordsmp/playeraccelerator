'use strict';

/**
 * /config — runtime configuration without touching source code.
 *
 * Grouped by subsystem. Every write goes through `configService.update`, which
 * marks the correct sub-tree modified and invalidates the cache.
 */

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const configService = require('../../services/configService');
const panelService = require('../../services/panelService');
const businessService = require('../../services/businessService');
const embeds = require('../../utils/embeds');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const autoMod = require('../../security/autoMod');
const { Configuration } = require('../../database/models');
const { DEFAULT_CONFIG } = require('../../config/defaults');
const { TICKET_TYPES, PRIORITIES } = require('../../config/server');
const { MOD_ACTIONS } = require('../../config');
const { EMOJIS } = require('../../config/branding');
const { safeReply } = require('../../utils/discord');
const { keyValueBlock, truncate } = require('../../utils/formatters');

/** Sections that `/config view` and `/config apply section:` understand. */
const SECTIONS = [
  'brand', 'theme', 'tickets', 'business', 'reviews', 'portfolio', 'promotion',
  'queue', 'welcome', 'verify', 'referrals', 'autoRoles', 'moderation', 'automod',
  'links', 'antiRaid', 'antiNuke', 'logging', 'security', 'backups', 'reports',
];

/** Render a configuration section as a readable block. */
function renderSection(config, section) {
  const value = config[section];
  if (!value) return '_Unknown section._';

  const rows = [];
  const walk = (object, prefix = '') => {
    for (const [key, entry] of Object.entries(object ?? {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && !(entry instanceof Date)) {
        if (rows.length < 40) walk(entry, path);
      } else if (Array.isArray(entry)) {
        rows.push([path, entry.length ? `[${entry.length} item${entry.length === 1 ? '' : 's'}]` : '[]']);
      } else if (entry instanceof Date) {
        rows.push([path, entry.toISOString().slice(0, 16).replace('T', ' ')]);
      } else {
        rows.push([path, String(entry).slice(0, 40)]);
      }
    }
  };
  walk(value);
  return keyValueBlock(rows.slice(0, 30));
}

module.exports = {
  access: 'admin',
  cooldown: 3,
  requiresSetup: false,

  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('View and change how the bot behaves in this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)

    // ── View / reset ────────────────────────────────────────────────────────
    .addSubcommand((sub) => sub
      .setName('view')
      .setDescription('Show the current configuration.')
      .addStringOption((option) => option
        .setName('section')
        .setDescription('Which section to display.')
        .addChoices(...SECTIONS.map((section) => ({ name: section, value: section })))))

    // ── Bulk apply ──────────────────────────────────────────────────────────
    .addSubcommand((sub) => sub
      .setName('apply')
      .setDescription('Configure everything at once, or reset one section, to the shipped defaults.')
      .addStringOption((option) => option
        .setName('section')
        .setDescription('Reset just this one section instead of configuring everything.')
        .addChoices(...SECTIONS.map((section) => ({ name: section, value: section }))))
      .addStringOption((option) => option
        .setName('timezone')
        .setDescription('IANA timezone for your office hours. Default America/New_York.'))
      .addStringOption((option) => option
        .setName('open')
        .setDescription('Opening time, 24-hour HH:MM. Default 12:00.'))
      .addStringOption((option) => option
        .setName('close')
        .setDescription('Closing time, 24-hour HH:MM. Default 21:00.'))
      .addStringOption((option) => option
        .setName('days')
        .setDescription('Open days as numbers, 0 = Sunday. Default 0,1,2,3,4,5,6.'))
      .addBooleanOption((option) => option
        .setName('schedule-only')
        .setDescription('Only set the hours and status mode, leaving every other setting alone.'))
      .addBooleanOption((option) => option
        .setName('preview')
        .setDescription('Show what would change without saving anything.')))

    // ── Brand ───────────────────────────────────────────────────────────────
    .addSubcommand((sub) => sub
      .setName('brand')
      .setDescription('Set the studio name, tagline, footer and imagery.')
      .addStringOption((option) => option.setName('name').setDescription('Studio name shown across every embed.'))
      .addStringOption((option) => option.setName('server-name').setDescription('Name applied to the Discord server itself by /setup.'))
      .addStringOption((option) => option.setName('description').setDescription('Server description (Community servers only). Max 120 characters.'))
      .addStringOption((option) => option.setName('tagline').setDescription('Short tagline.'))
      .addStringOption((option) => option.setName('slogan').setDescription('Very short slogan, for banners and tight spaces.'))
      .addStringOption((option) => option.setName('footer').setDescription('Footer text on every embed.'))
      .addStringOption((option) => option.setName('logo').setDescription('Logo URL (used as the embed thumbnail).'))
      .addStringOption((option) => option.setName('banner').setDescription('Banner URL (used on panels).'))
      .addStringOption((option) => option.setName('website').setDescription('Website URL.')))

    .addSubcommand((sub) => sub
      .setName('theme')
      .setDescription('Set the embed colour palette.')
      .addStringOption((option) => option.setName('primary').setDescription('Primary colour, e.g. #6366F1'))
      .addStringOption((option) => option.setName('accent').setDescription('Accent colour for panels.'))
      .addStringOption((option) => option.setName('success').setDescription('Success colour.'))
      .addStringOption((option) => option.setName('warning').setDescription('Warning colour.'))
      .addStringOption((option) => option.setName('danger').setDescription('Danger colour.')))

    // ── Business ────────────────────────────────────────────────────────────
    .addSubcommand((sub) => sub
      .setName('business')
      .setDescription('Set the timezone, response targets and currency.')
      .addStringOption((option) => option.setName('timezone').setDescription('IANA timezone, e.g. Europe/Amsterdam'))
      .addIntegerOption((option) => option.setName('response-target').setDescription('First-response target in minutes.').setMinValue(5).setMaxValue(10080))
      .addStringOption((option) => option.setName('currency-symbol').setDescription('Currency symbol, e.g. $ or €'))
      .addStringOption((option) => option.setName('out-of-hours').setDescription('Message shown when the studio is closed.'))
      .addBooleanOption((option) => option.setName('track-spending').setDescription('Show lifetime customer spend on profiles.'))
      .addIntegerOption((option) => option.setName('vip-orders').setDescription('Completed orders needed for VIP status.').setMinValue(0).setMaxValue(100)))

    .addSubcommand((sub) => sub
      .setName('hours')
      .setDescription('Set office hours for one day of the week.')
      .addIntegerOption((option) => option
        .setName('day')
        .setDescription('Day of the week.')
        .setRequired(true)
        .addChoices(
          { name: 'Monday', value: 1 }, { name: 'Tuesday', value: 2 }, { name: 'Wednesday', value: 3 },
          { name: 'Thursday', value: 4 }, { name: 'Friday', value: 5 }, { name: 'Saturday', value: 6 },
          { name: 'Sunday', value: 0 },
        ))
      .addStringOption((option) => option.setName('open').setDescription('Opening time in 24-hour HH:MM. Omit to mark the day closed.'))
      .addStringOption((option) => option.setName('close').setDescription('Closing time in 24-hour HH:MM.')))

    // ── Tickets ─────────────────────────────────────────────────────────────
    .addSubcommand((sub) => sub
      .setName('tickets')
      .setDescription('Configure the ticket system.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Accept new tickets.'))
      .addIntegerOption((option) => option.setName('max-open').setDescription('Maximum open tickets per customer.').setMinValue(1).setMaxValue(25))
      .addBooleanOption((option) => option.setName('transcripts').setDescription('Generate an HTML transcript on close.'))
      .addBooleanOption((option) => option.setName('markdown-transcripts').setDescription('Also write a Markdown transcript.'))
      .addBooleanOption((option) => option.setName('request-review').setDescription('Ask for a review when a ticket closes.'))
      .addBooleanOption((option) => option.setName('archive-on-close').setDescription('Archive rather than delete closed tickets.'))
      .addIntegerOption((option) => option.setName('auto-delete-days').setDescription('Delete archived tickets after N days (0 = never).').setMinValue(0).setMaxValue(365))
      .addIntegerOption((option) => option.setName('inactivity-close-hours').setDescription('Close inactive tickets after N hours (0 = never).').setMinValue(0).setMaxValue(720))
      .addIntegerOption((option) => option.setName('inactivity-warn-hours').setDescription('Warn after N hours of inactivity (0 = never).').setMinValue(0).setMaxValue(720))
      .addStringOption((option) => option
        .setName('default-priority')
        .setDescription('Priority applied to new tickets.')
        .addChoices(...Object.entries(PRIORITIES).map(([value, meta]) => ({ name: meta.label, value })))))

    .addSubcommand((sub) => sub
      .setName('ticket-types')
      .setDescription('Enable or disable an individual ticket category.')
      .addStringOption((option) => option
        .setName('type')
        .setDescription('Ticket category.')
        .setRequired(true)
        .addChoices(...TICKET_TYPES.map((type) => ({ name: type.label, value: type.key }))))
      .addBooleanOption((option) => option.setName('enabled').setDescription('Accept requests for this category.').setRequired(true)))

    // ── Reviews / portfolio / promotion / queue ─────────────────────────────
    .addSubcommand((sub) => sub
      .setName('reviews')
      .setDescription('Configure the review system.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Collect customer reviews.'))
      .addBooleanOption((option) => option.setName('require-approval').setDescription('Reviews need staff approval before publishing.'))
      .addBooleanOption((option) => option.setName('auto-publish').setDescription('Publish approved reviews automatically.'))
      .addIntegerOption((option) => option.setName('auto-publish-min-rating').setDescription('Ratings below this need manual approval.').setMinValue(1).setMaxValue(5))
      .addIntegerOption((option) => option.setName('feature-threshold').setDescription('Minimum rating eligible to be featured.').setMinValue(1).setMaxValue(5)))

    .addSubcommand((sub) => sub
      .setName('queue')
      .setDescription('Configure the project queue.')
      .addIntegerOption((option) => option.setName('capacity').setDescription('Projects worked on simultaneously.').setMinValue(1).setMaxValue(50))
      .addIntegerOption((option) => option.setName('average-days').setDescription('Average working days per project, used for estimates.').setMinValue(1).setMaxValue(180))
      .addBooleanOption((option) => option.setName('public').setDescription('Publish the queue publicly.')))

    .addSubcommand((sub) => sub
      .setName('promotion')
      .setDescription('Configure the promotion partnership programme.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Accept promotion applications.'))
      .addIntegerOption((option) => option.setName('min-players').setDescription('Suggested minimum concurrent players.').setMinValue(0).setMaxValue(10000))
      .addStringOption((option) => option.setName('audience').setDescription('Audience size described in the programme copy.')))

    // ── Membership ──────────────────────────────────────────────────────────
    .addSubcommand((sub) => sub
      .setName('welcome')
      .setDescription('Configure the welcome workflow.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Welcome new members.'))
      .addBooleanOption((option) => option.setName('channel-message').setDescription('Post the welcome embed in the welcome channel.'))
      .addBooleanOption((option) => option.setName('direct-message').setDescription('Also send it by DM.'))
      .addBooleanOption((option) => option.setName('ticket-nudge').setDescription('Nudge new members in the ticket channel.'))
      .addIntegerOption((option) => option.setName('nudge-seconds').setDescription('How long the nudge survives.').setMinValue(5).setMaxValue(300))
      .addIntegerOption((option) => option.setName('delete-after').setDescription('Seconds before a greeting is removed. 0 keeps it forever.').setMinValue(0).setMaxValue(86400)))

    .addSubcommand((sub) => sub
      .setName('verify')
      .setDescription('Configure the verification gate.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Require members to press Verify before getting a role.'))
      .addRoleOption((option) => option.setName('role').setDescription('Role granted on verification.'))
      .addIntegerOption((option) => option.setName('min-account-age').setDescription('Minimum account age in days (0 = no check).').setMinValue(0).setMaxValue(365)))

    .addSubcommand((sub) => sub
      .setName('referrals')
      .setDescription('Configure referral tracking and the free commission gate.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Track referrals and gate free commissions behind them.'))
      .addIntegerOption((option) => option.setName('required').setDescription('Successful invites needed for a free commission.').setMinValue(1).setMaxValue(50))
      .addIntegerOption((option) => option.setName('min-invitee-age').setDescription('Ignore invitees whose account is newer than N days.').setMinValue(0).setMaxValue(365))
      .addIntegerOption((option) => option.setName('revoke-hours').setDescription('Revoke credit if the invitee leaves within N hours (0 = never).').setMinValue(0).setMaxValue(720))
      .addBooleanOption((option) => option.setName('announce').setDescription('Announce when someone unlocks the programme.')))

    .addSubcommand((sub) => sub
      .setName('autorole')
      .setDescription('Configure automatic role assignment.')
      .addRoleOption((option) => option.setName('on-join').setDescription('Role granted to every new member.'))
      .addRoleOption((option) => option.setName('on-bot-join').setDescription('Role granted to bots.'))
      .addRoleOption((option) => option.setName('on-purchase').setDescription('Role granted on the first completed order.'))
      .addRoleOption((option) => option.setName('on-vip').setDescription('Role granted when VIP thresholds are met.')))

    // ── Moderation / security ───────────────────────────────────────────────
    .addSubcommand((sub) => sub
      .setName('moderation')
      .setDescription('Configure moderation behaviour.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Enable the moderation system.'))
      .addBooleanOption((option) => option.setName('dm-on-punish').setDescription('Notify members by DM when action is taken.'))
      .addIntegerOption((option) => option.setName('warning-expiry-days').setDescription('Warnings stop counting after N days (0 = never).').setMinValue(0).setMaxValue(3650))
      .addBooleanOption((option) => option.setName('exempt-staff').setDescription('Exempt staff from AutoMod.'))
      .addRoleOption((option) => option.setName('ignore-role').setDescription('Add a role to the AutoMod exemption list.'))
      .addChannelOption((option) => option.setName('ignore-channel').setDescription('Add a channel to the AutoMod exemption list.').addChannelTypes(ChannelType.GuildText)))

    .addSubcommand((sub) => sub
      .setName('automod')
      .setDescription('Configure an individual AutoMod module.')
      .addStringOption((option) => option
        .setName('module')
        .setDescription('Which module to configure.')
        .setRequired(true)
        .setAutocomplete(true))
      .addBooleanOption((option) => option.setName('enabled').setDescription('Enable this module.'))
      .addStringOption((option) => option
        .setName('action')
        .setDescription('What happens when it triggers.')
        .addChoices(...MOD_ACTIONS.map((action) => ({ name: action, value: action }))))
      .addIntegerOption((option) => option.setName('threshold').setDescription('Trigger threshold.').setMinValue(1).setMaxValue(1000))
      .addIntegerOption((option) => option.setName('duration').setDescription('Timeout duration in minutes.').setMinValue(1).setMaxValue(40320))
      .addBooleanOption((option) => option.setName('delete-message').setDescription('Delete the offending message.')))

    .addSubcommand((sub) => sub
      .setName('words')
      .setDescription('Manage the custom word filter.')
      .addStringOption((option) => option
        .setName('action')
        .setDescription('What to do.')
        .setRequired(true)
        .addChoices(
          { name: 'Block a word', value: 'block' },
          { name: 'Unblock a word', value: 'unblock' },
          { name: 'Allow a word (overrides filters)', value: 'allow' },
          { name: 'Remove from allow list', value: 'unallow' },
          { name: 'List everything', value: 'list' },
        ))
      .addStringOption((option) => option.setName('word').setDescription('The word or phrase.')))

    .addSubcommand((sub) => sub
      .setName('links')
      .setDescription('Configure the link filter.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Enable link filtering.'))
      .addBooleanOption((option) => option.setName('block-shorteners').setDescription('Block URL shorteners.'))
      .addBooleanOption((option) => option.setName('allow-staff').setDescription('Exempt staff from the link filter.'))
      .addStringOption((option) => option
        .setName('list-action')
        .setDescription('Modify the allow or block list.')
        .addChoices(
          { name: 'Allow domain', value: 'whitelist' },
          { name: 'Block domain', value: 'blacklist' },
          { name: 'Remove from allow list', value: 'unwhitelist' },
          { name: 'Remove from block list', value: 'unblacklist' },
        ))
      .addStringOption((option) => option.setName('domain').setDescription('Domain, e.g. example.com')))

    .addSubcommand((sub) => sub
      .setName('antiraid')
      .setDescription('Configure raid protection.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Enable raid protection.'))
      .addIntegerOption((option) => option.setName('join-threshold').setDescription('Joins within the window that trigger raid mode.').setMinValue(2).setMaxValue(100))
      .addIntegerOption((option) => option.setName('join-window').setDescription('Detection window in seconds.').setMinValue(5).setMaxValue(600))
      .addIntegerOption((option) => option.setName('min-account-age').setDescription('Accounts younger than N days are treated as suspicious.').setMinValue(0).setMaxValue(365))
      .addStringOption((option) => option
        .setName('new-account-action')
        .setDescription('Action for new accounts during a raid.')
        .addChoices({ name: 'none', value: 'none' }, { name: 'kick', value: 'kick' }, { name: 'ban', value: 'ban' }))
      .addBooleanOption((option) => option.setName('auto-lockdown').setDescription('Lock the server automatically during a raid.'))
      .addIntegerOption((option) => option.setName('slowmode').setDescription('Slowmode applied during a raid, in seconds.').setMinValue(0).setMaxValue(21600)))

    .addSubcommand((sub) => sub
      .setName('antinuke')
      .setDescription('Configure anti-nuke protection.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Enable anti-nuke.'))
      .addStringOption((option) => option
        .setName('punishment')
        .setDescription('Response when a limit is exceeded.')
        .addChoices(
          { name: 'strip dangerous roles', value: 'strip' },
          { name: 'kick', value: 'kick' },
          { name: 'ban', value: 'ban' },
          { name: 'log only', value: 'none' },
        ))
      .addBooleanOption((option) => option.setName('attempt-restore').setDescription('Try to recreate deleted channels and roles.'))
      .addUserOption((option) => option.setName('whitelist').setDescription('Exempt a user from anti-nuke.'))
      .addUserOption((option) => option.setName('unwhitelist').setDescription('Remove a user from the anti-nuke exemption list.')))

    // ── Logging / backups / reports ─────────────────────────────────────────
    .addSubcommand((sub) => sub
      .setName('logging')
      .setDescription('Configure event logging.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Enable logging.'))
      .addBooleanOption((option) => option.setName('persist').setDescription('Also store logs in the database.'))
      .addStringOption((option) => option.setName('event').setDescription('Event key to toggle, e.g. messageDelete').setAutocomplete(true))
      .addBooleanOption((option) => option.setName('event-enabled').setDescription('Whether that event is logged.'))
      .addChannelOption((option) => option.setName('ignore-channel').setDescription('Exclude a channel from message logging.').addChannelTypes(ChannelType.GuildText)))

    .addSubcommand((sub) => sub
      .setName('channel')
      .setDescription('Re-point a log destination at a different channel.')
      .addStringOption((option) => option
        .setName('log')
        .setDescription('Which log stream.')
        .setRequired(true)
        .addChoices(
          { name: 'Ticket events', value: 'ticket' },
          { name: 'Server audit', value: 'audit' },
          { name: 'Moderation', value: 'moderation' },
          { name: 'Bot / errors', value: 'bot' },
          { name: 'Security', value: 'security' },
          { name: 'Reports', value: 'report' },
          { name: 'Business reports', value: 'business' },
        ))
      .addChannelOption((option) => option.setName('destination').setDescription('Target channel.').setRequired(true).addChannelTypes(ChannelType.GuildText)))

    .addSubcommand((sub) => sub
      .setName('backups')
      .setDescription('Configure automatic backups.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('Enable scheduled backups.'))
      .addIntegerOption((option) => option.setName('interval-hours').setDescription('Hours between snapshots (0 = disabled).').setMinValue(0).setMaxValue(720))
      .addIntegerOption((option) => option.setName('retain').setDescription('How many snapshots to keep.').setMinValue(1).setMaxValue(100)))

    .addSubcommand((sub) => sub
      .setName('reports')
      .setDescription('Configure automated business reports.')
      .addBooleanOption((option) => option.setName('daily').setDescription('Post a daily summary.'))
      .addBooleanOption((option) => option.setName('weekly').setDescription('Post a weekly report.'))
      .addIntegerOption((option) => option.setName('hour-utc').setDescription('UTC hour at which reports are generated.').setMinValue(0).setMaxValue(23))),

  /** Autocomplete for module and event keys. */
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const query = String(focused.value ?? '').toLowerCase();

    if (focused.name === 'module') {
      const matches = autoMod.MODULE_LIST
        .filter((module) => module.key.toLowerCase().includes(query) || module.label.toLowerCase().includes(query))
        .slice(0, 25)
        .map((module) => ({ name: module.label, value: module.key }));
      return interaction.respond(matches);
    }

    if (focused.name === 'event') {
      const config = await configService.get(interaction.guild);
      const matches = Object.keys(config.logging?.events ?? {})
        .filter((event) => event.toLowerCase().includes(query))
        .slice(0, 25)
        .map((event) => ({ name: event, value: event }));
      return interaction.respond(matches);
    }

    return interaction.respond([]);
  },

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object }} context
   */
  async execute(interaction, { config }) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    /** Collect `option -> config path` pairs that were actually provided. */
    const collect = (mapping) => {
      const changes = {};
      for (const [optionName, spec] of Object.entries(mapping)) {
        const value = spec.get(interaction, optionName);
        if (value === null || value === undefined) continue;
        changes[spec.path] = spec.transform ? spec.transform(value) : value;
      }
      return changes;
    };

    const str = (path, transform) => ({ path, transform, get: (i, name) => i.options.getString(name) });
    const bool = (path) => ({ path, get: (i, name) => i.options.getBoolean(name) });
    const int = (path, transform) => ({ path, transform, get: (i, name) => i.options.getInteger(name) });

    /** Apply changes and reply with a summary. */
    const apply = async (changes, { refresh = [], title = 'Configuration Updated' } = {}) => {
      if (!Object.keys(changes).length) {
        throw new errors.ValidationError('No options were provided — nothing was changed.');
      }
      await configService.setPaths(guild, changes);
      const fresh = await configService.get(guild, { fresh: true });

      for (const panel of refresh) {
        await panelService.refresh(guild, fresh, panel).catch(() => null);
      }

      return safeReply(interaction, {
        embeds: [embeds.success({
          config: fresh,
          title,
          description: 'The following settings were changed:',
          fields: [{
            name: 'Changes',
            value: keyValueBlock(Object.entries(changes).map(([path, value]) => [
              path,
              Array.isArray(value) ? `[${value.length}]` : truncate(String(value), 40),
            ])),
          }],
        })],
      }, { ephemeral: true });
    };

    switch (sub) {
      // ── View / reset ──────────────────────────────────────────────────────
      case 'view': {
        const section = interaction.options.getString('section');
        if (section) {
          return safeReply(interaction, {
            embeds: [embeds.info({
              config,
              title: `${EMOJIS.logs} Configuration · ${section}`,
              description: renderSection(config, section),
              footer: `Change with /config ${section}`,
            })],
          }, { ephemeral: true });
        }

        const availability = businessService.availability(config);
        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.logs} Configuration Overview`,
            description: `Use \`/config view section:<name>\` for the full detail of any section.`,
            fields: [
              {
                name: 'Identity',
                value: keyValueBlock([
                  ['Brand', config.brand?.name ?? '—'],
                  ['Setup', config.setup?.completed ? 'Complete' : 'Not run'],
                  ['Timezone', config.business?.timezone ?? 'UTC'],
                  ['Office', availability.open ? 'Open' : 'Closed'],
                ]),
                inline: true,
              },
              {
                name: 'Systems',
                value: keyValueBlock([
                  ['Tickets', config.tickets?.enabled ? 'On' : 'Off'],
                  ['Reviews', config.reviews?.enabled ? 'On' : 'Off'],
                  ['Portfolio', config.portfolio?.enabled ? 'On' : 'Off'],
                  ['Promotion', config.promotion?.enabled ? 'On' : 'Off'],
                ]),
                inline: true,
              },
              {
                name: 'Protection',
                value: keyValueBlock([
                  ['AutoMod', config.automod?.enabled ? 'On' : 'Off'],
                  ['Links', config.links?.enabled ? 'On' : 'Off'],
                  ['Anti-raid', config.antiRaid?.enabled ? 'On' : 'Off'],
                  ['Anti-nuke', config.antiNuke?.enabled ? 'On' : 'Off'],
                ]),
                inline: true,
              },
              {
                name: 'Operations',
                value: keyValueBlock([
                  ['Logging', config.logging?.enabled ? 'On' : 'Off'],
                  ['Backups', config.backups?.enabled ? `Every ${config.backups.intervalHours}h` : 'Off'],
                  ['Daily report', config.reports?.daily ? 'On' : 'Off'],
                  ['Weekly report', config.reports?.weekly ? 'On' : 'Off'],
                ]),
                inline: true,
              },
              {
                name: 'Sections',
                value: SECTIONS.map((section) => `\`${section}\``).join(' '),
              },
            ],
          })],
        }, { ephemeral: true });
      }

      // ── Bulk apply ────────────────────────────────────────────────────────
      case 'apply': {
        const scheduleOnly = interaction.options.getBoolean('schedule-only') ?? false;
        const preview = interaction.options.getBoolean('preview') ?? false;
        const section = interaction.options.getString('section');

        // Naming one section narrows this to what /config reset used to do.
        // The two were the same operation at different scopes, and /config was
        // already at Discord's 25-subcommand ceiling.
        if (section) {
          if (configService.PRESERVED.includes(section)) {
            throw new errors.ValidationError(
              `\`${section}\` holds the wiring \`/setup\` created — channel and role ids, published panel `
              + 'messages. Resetting it would orphan the server. Re-run `/setup` if you need it rebuilt.',
            );
          }

          const updated = await configService.update(guild, (cfg) => {
            if (!cfg.resetSection(section)) throw new errors.ValidationError(`\`${section}\` is not a resettable section.`);
            // The verification gate's role id lives in the preserved wiring, so
            // put it back rather than leave the gate unable to grant anything.
            if (section === 'verify' && cfg.roles?.verified) cfg.setPath('verify.roleId', cfg.roles.verified);
          });

          return safeReply(interaction, {
            embeds: [embeds.success({
              config: updated,
              title: 'Section Reset',
              description: `\`${section}\` has been restored to its shipped defaults.`,
            })],
          }, { ephemeral: true });
        }

        // Validate every input before touching the document, so a typo cannot
        // leave it half-applied.
        const timezone = validators.timezone(interaction.options.getString('timezone') ?? DEFAULT_CONFIG.business.timezone);
        const open = validators.timeOfDay(interaction.options.getString('open') ?? '12:00');
        const close = validators.timeOfDay(interaction.options.getString('close') ?? '21:00');

        const days = (interaction.options.getString('days') ?? '0,1,2,3,4,5,6')
          .split(',')
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);

        if (!days.length) {
          throw new errors.ValidationError(
            'No valid days given. Use numbers separated by commas, where 0 is Sunday — for example `1,2,3,4,5` for weekdays.',
          );
        }

        const hours = {};
        for (let day = 0; day <= 6; day += 1) hours[day] = days.includes(day) ? { open, close } : null;

        const time = (value) => businessService.formatTime(businessService.toMinutes(value));
        const outOfHoursMessage =
          `We are currently outside office hours (${time(open)} – ${time(close)}, `
          + `${days.length === 7 ? 'daily' : 'on our open days'}). `
          + 'Your ticket is logged and will be answered when we reopen.';

        // A preview must not persist, so it runs against a throwaway copy.
        const stored = await configService.get(guild, { fresh: true });
        // A preview must not persist, so it runs against a detached copy of the
        // document rather than the cached one every other command is holding.
        const target = preview
          ? new Configuration(stored.toObject({ depopulate: true }))
          : stored;

        const { changed } = configService.applyProfile(target, {
          timezone, hours, outOfHoursMessage, scheduleOnly,
        });

        if (!preview && changed.length) {
          await target.save();
          configService.invalidate(guild.id);
        }

        const fresh = preview ? config : await configService.get(guild, { fresh: true });
        const availability = businessService.availability(target);

        return safeReply(interaction, {
          embeds: [embeds[preview ? 'info' : 'success']({
            config: fresh,
            title: preview ? 'Preview — nothing saved' : 'Configuration Applied',
            description: changed.length
              ? `${preview ? 'Would update' : 'Updated'} **${changed.length}** section${changed.length === 1 ? '' : 's'}.`
                + (scheduleOnly ? '' : ' Everything not listed as preserved is now on the shipped studio profile.')
              : 'Everything was already correct — nothing needed changing.',
            fields: [
              {
                name: 'Office hours',
                value:
                  `${time(open)} – ${time(close)} ${days.length === 7 ? 'every day' : `on ${days.map((day) => businessService.DAY_NAMES[day].slice(0, 3)).join(', ')}`}\n`
                  + `Timezone \`${timezone}\`\n`
                  + `Right now: **${availability.open ? 'open' : 'closed'}** · status shows **${businessService.effectiveStatus(target)}**`,
              },
              ...(changed.length
                ? [{ name: 'Sections', value: changed.map((section) => `\`${section}\``).join(' ') }]
                : []),
              {
                name: 'Preserved',
                value:
                  `${configService.PRESERVED.map((section) => `\`${section}\``).join(' ')}\n`
                  + '_Your channels, roles and published panels are never touched by this._',
              },
              ...(preview || !changed.length
                ? []
                : [{ name: 'Next', value: 'Run `/panel republish confirm:True` to repost the panels with the new settings.' }]),
            ],
          })],
        }, { ephemeral: true });
      }

      // ── Brand / theme ─────────────────────────────────────────────────────
      case 'brand':
        return apply(collect({
          name: str('brand.name', (v) => validators.text(v, 'Name', { max: 80, allowNewlines: false })),
          // Discord's own limits: 100 characters for a guild name, 120 for the
          // description. Rejecting here beats a failed API call at /setup time.
          'server-name': str('brand.serverName', (v) => validators.text(v, 'Server name', { max: 100, allowNewlines: false })),
          description: str('brand.description', (v) => validators.text(v, 'Description', { max: 120, allowNewlines: false })),
          tagline: str('brand.tagline', (v) => validators.text(v, 'Tagline', { max: 120, allowNewlines: false })),
          slogan: str('brand.slogan', (v) => validators.text(v, 'Slogan', { max: 80, allowNewlines: false })),
          footer: str('brand.footer', (v) => validators.text(v, 'Footer', { max: 120, allowNewlines: false })),
          logo: str('brand.logoUrl', (v) => validators.url(v, { label: 'Logo' })),
          banner: str('brand.bannerUrl', (v) => validators.url(v, { label: 'Banner' })),
          website: str('brand.websiteUrl', (v) => validators.url(v, { label: 'Website' })),
        }), { refresh: ['welcome', 'ticket', 'reviews', 'statistics'], title: 'Branding Updated' });

      case 'theme':
        return apply(collect({
          primary: str('theme.primary', validators.color),
          accent: str('theme.accent', validators.color),
          success: str('theme.success', validators.color),
          warning: str('theme.warning', validators.color),
          danger: str('theme.danger', validators.color),
        }), { refresh: ['ticket', 'status', 'statistics', 'queue'], title: 'Theme Updated' });

      // ── Business ──────────────────────────────────────────────────────────
      case 'business':
        return apply(collect({
          timezone: str('business.timezone', validators.timezone),
          'response-target': int('business.responseTargetMinutes'),
          'currency-symbol': str('business.currencySymbol', (v) => validators.text(v, 'Currency symbol', { max: 4, allowNewlines: false })),
          'out-of-hours': str('business.outOfHoursMessage', (v) => validators.text(v, 'Message', { max: 500 })),
          'track-spending': bool('business.trackSpending'),
          'vip-orders': int('business.vipThresholdOrders'),
        }), { refresh: ['hours', 'status'], title: 'Business Settings Updated' });

      case 'hours': {
        const day = interaction.options.getInteger('day');
        const open = interaction.options.getString('open');
        const close = interaction.options.getString('close');

        const value = open && close
          ? { open: validators.timeOfDay(open), close: validators.timeOfDay(close) }
          : null;

        await configService.setPaths(guild, { [`business.hours.${day}`]: value });
        const fresh = await configService.get(guild, { fresh: true });
        await panelService.refresh(guild, fresh, 'hours').catch(() => null);
        await panelService.refresh(guild, fresh, 'status').catch(() => null);

        return safeReply(interaction, {
          embeds: [embeds.success({
            config: fresh,
            title: 'Office Hours Updated',
            description: value
              ? `**${businessService.DAY_NAMES[day]}**: ${value.open} – ${value.close} (${fresh.business.timezone})`
              : `**${businessService.DAY_NAMES[day]}** is now marked as closed.`,
          })],
        }, { ephemeral: true });
      }

      // ── Tickets ───────────────────────────────────────────────────────────
      case 'tickets':
        return apply(collect({
          enabled: bool('tickets.enabled'),
          'max-open': int('tickets.maxOpenPerUser'),
          transcripts: bool('tickets.transcripts'),
          'markdown-transcripts': bool('tickets.markdownTranscripts'),
          'request-review': bool('tickets.requestReview'),
          'archive-on-close': bool('tickets.archiveOnClose'),
          'auto-delete-days': int('tickets.autoDeleteArchivedAfterDays'),
          'inactivity-close-hours': int('tickets.inactivityCloseHours'),
          'inactivity-warn-hours': int('tickets.inactivityWarnHours'),
          'default-priority': str('tickets.defaultPriority'),
        }), { refresh: ['ticket'], title: 'Ticket Settings Updated' });

      case 'ticket-types': {
        const type = interaction.options.getString('type');
        const enabled = interaction.options.getBoolean('enabled');
        // An empty list means "everything enabled", so materialise it on first
        // disable rather than storing an ambiguous state.
        const current = config.tickets?.enabledTypes?.length
          ? [...config.tickets.enabledTypes]
          : TICKET_TYPES.map((entry) => entry.key);

        const next = enabled
          ? [...new Set([...current, type])]
          : current.filter((key) => key !== type);

        if (!next.length) throw new errors.ValidationError('At least one ticket category must stay enabled.');

        await configService.setPaths(guild, { 'tickets.enabledTypes': next });
        const fresh = await configService.get(guild, { fresh: true });
        await panelService.refresh(guild, fresh, 'ticket').catch(() => null);

        return safeReply(interaction, {
          embeds: [embeds.success({
            config: fresh,
            title: 'Ticket Category Updated',
            description: `**${TICKET_TYPES.find((entry) => entry.key === type)?.label}** is now **${enabled ? 'accepting' : 'not accepting'}** requests.`,
            fields: [{ name: 'Enabled categories', value: next.map((key) => `\`${key}\``).join(' ') }],
          })],
        }, { ephemeral: true });
      }

      // ── Reviews / queue / promotion ───────────────────────────────────────
      case 'reviews':
        return apply(collect({
          enabled: bool('reviews.enabled'),
          'require-approval': bool('reviews.requireApproval'),
          'auto-publish': bool('reviews.autoPublish'),
          'auto-publish-min-rating': int('reviews.autoPublishMinRating'),
          'feature-threshold': int('reviews.featureThreshold'),
        }), { refresh: ['reviews'], title: 'Review Settings Updated' });

      case 'queue':
        return apply(collect({
          capacity: int('queue.concurrentCapacity'),
          'average-days': int('queue.averageProjectDays'),
          public: bool('queue.publicQueue'),
        }), { refresh: ['queue'], title: 'Queue Settings Updated' });

      case 'promotion':
        return apply(collect({
          enabled: bool('promotion.enabled'),
          'min-players': int('promotion.minPlayerCount'),
          audience: str('promotion.audienceSize', (v) => validators.text(v, 'Audience', { max: 80, allowNewlines: false })),
        }), { title: 'Promotion Settings Updated' });

      // ── Membership ────────────────────────────────────────────────────────
      case 'welcome':
        return apply(collect({
          enabled: bool('welcome.enabled'),
          'channel-message': bool('welcome.channelMessage'),
          'direct-message': bool('welcome.directMessage'),
          'ticket-nudge': bool('welcome.ticketNudge'),
          'nudge-seconds': int('welcome.ticketNudgeSeconds'),
          'delete-after': int('welcome.deleteAfterSeconds'),
        }), { title: 'Welcome Settings Updated' });

      case 'verify': {
        const changes = collect({
          enabled: bool('verify.enabled'),
          'min-account-age': int('verify.minAccountAgeDays'),
        });
        const verifyRole = interaction.options.getRole('role');
        if (verifyRole) {
          if (!verifyRole.editable) {
            throw new errors.ValidationError(
              `I cannot assign **${verifyRole.name}** — it sits at or above my highest role. ` +
              'Move my role higher in Server Settings → Roles.',
            );
          }
          changes['verify.roleId'] = verifyRole.id;
        }
        return apply(changes, { refresh: ['verify'], title: 'Verification Updated' });
      }

      case 'referrals':
        return apply(collect({
          enabled: bool('referrals.enabled'),
          required: int('referrals.requiredForFreeCommission'),
          'min-invitee-age': int('referrals.minInviteeAccountAgeDays'),
          'revoke-hours': int('referrals.revokeIfLeaveWithinHours'),
          announce: bool('referrals.announceUnlock'),
        }), { refresh: ['freeCommission'], title: 'Referral Settings Updated' });

      case 'autorole': {
        const changes = {};
        const onJoin = interaction.options.getRole('on-join');
        const onBotJoin = interaction.options.getRole('on-bot-join');
        const onPurchase = interaction.options.getRole('on-purchase');
        const onVip = interaction.options.getRole('on-vip');

        // Roles must be below the bot or assignment will silently fail later.
        for (const candidate of [onJoin, onBotJoin, onPurchase, onVip]) {
          if (candidate && !candidate.editable) {
            throw new errors.ValidationError(
              `I cannot assign **${candidate.name}** — it sits at or above my highest role. ` +
              'Move my role higher in Server Settings → Roles.',
            );
          }
        }

        if (onJoin) changes['autoRoles.onJoin'] = [onJoin.id];
        if (onBotJoin) changes['autoRoles.onBotJoin'] = [onBotJoin.id];
        if (onPurchase) changes['autoRoles.onFirstPurchase'] = onPurchase.id;
        if (onVip) changes['autoRoles.onVip'] = onVip.id;
        return apply(changes, { title: 'Automatic Roles Updated' });
      }

      // ── Moderation ────────────────────────────────────────────────────────
      case 'moderation': {
        const changes = collect({
          enabled: bool('moderation.enabled'),
          'dm-on-punish': bool('moderation.dmOnPunish'),
          'warning-expiry-days': int('moderation.warningExpiryDays'),
          'exempt-staff': bool('moderation.exemptStaff'),
        });

        const ignoreRole = interaction.options.getRole('ignore-role');
        if (ignoreRole) {
          const current = config.moderation?.ignoredRoles ?? [];
          changes['moderation.ignoredRoles'] = current.includes(ignoreRole.id)
            ? current.filter((id) => id !== ignoreRole.id)
            : [...current, ignoreRole.id];
        }
        const ignoreChannel = interaction.options.getChannel('ignore-channel');
        if (ignoreChannel) {
          const current = config.moderation?.ignoredChannels ?? [];
          changes['moderation.ignoredChannels'] = current.includes(ignoreChannel.id)
            ? current.filter((id) => id !== ignoreChannel.id)
            : [...current, ignoreChannel.id];
        }
        return apply(changes, { title: 'Moderation Settings Updated' });
      }

      case 'automod': {
        const moduleKey = interaction.options.getString('module');
        if (!autoMod.MODULE_LIST.some((module) => module.key === moduleKey)) {
          throw new errors.ValidationError(`\`${moduleKey}\` is not a recognised AutoMod module.`);
        }
        return apply(collect({
          enabled: bool(`automod.modules.${moduleKey}.enabled`),
          action: str(`automod.modules.${moduleKey}.action`),
          threshold: int(`automod.modules.${moduleKey}.threshold`),
          duration: int(`automod.modules.${moduleKey}.duration`),
          'delete-message': bool(`automod.modules.${moduleKey}.deleteMessage`),
        }), { title: `AutoMod · ${moduleKey}` });
      }

      case 'words': {
        const action = interaction.options.getString('action');
        const word = interaction.options.getString('word');

        if (action === 'list') {
          return safeReply(interaction, {
            embeds: [embeds.info({
              config,
              title: 'Word Filter',
              fields: [
                { name: `Blocked (${config.automod?.customWords?.length ?? 0})`, value: truncate((config.automod?.customWords ?? []).map((w) => `\`${w}\``).join(' ') || '_none_', 1024) },
                { name: `Allowed (${config.automod?.allowedWords?.length ?? 0})`, value: truncate((config.automod?.allowedWords ?? []).map((w) => `\`${w}\``).join(' ') || '_none_', 1024) },
                { name: `Patterns (${config.automod?.customPatterns?.length ?? 0})`, value: truncate((config.automod?.customPatterns ?? []).map((w) => `\`${w}\``).join('\n') || '_none_', 1024) },
              ],
            })],
          }, { ephemeral: true });
        }

        if (!word) throw new errors.ValidationError('Provide the word or phrase to add or remove.');
        const clean = validators.text(word, 'Word', { max: 60, allowNewlines: false }).toLowerCase();

        const listPath = ['block', 'unblock'].includes(action) ? 'automod.customWords' : 'automod.allowedWords';
        const current = action.startsWith('un') || action === 'unblock'
          ? (listPath === 'automod.customWords' ? config.automod?.customWords : config.automod?.allowedWords) ?? []
          : (listPath === 'automod.customWords' ? config.automod?.customWords : config.automod?.allowedWords) ?? [];

        const adding = ['block', 'allow'].includes(action);
        const next = adding
          ? [...new Set([...current, clean])]
          : current.filter((entry) => entry !== clean);

        if (next.length > 500) throw new errors.ValidationError('The word list is limited to 500 entries.');

        return apply({ [listPath]: next }, { title: adding ? 'Word Added' : 'Word Removed' });
      }

      case 'links': {
        const changes = collect({
          enabled: bool('links.enabled'),
          'block-shorteners': bool('links.blockShorteners'),
          'allow-staff': bool('links.allowStaff'),
        });

        const listAction = interaction.options.getString('list-action');
        const domainInput = interaction.options.getString('domain');
        if (listAction) {
          if (!domainInput) throw new errors.ValidationError('Provide a domain when modifying a list.');
          const domain = validators.domain(domainInput);
          const target = listAction.includes('white') ? 'links.whitelist' : 'links.blacklist';
          const current = (target === 'links.whitelist' ? config.links?.whitelist : config.links?.blacklist) ?? [];
          changes[target] = listAction.startsWith('un')
            ? current.filter((entry) => entry !== domain)
            : [...new Set([...current, domain])];
        }
        return apply(changes, { title: 'Link Filter Updated' });
      }

      case 'antiraid':
        return apply(collect({
          enabled: bool('antiRaid.enabled'),
          'join-threshold': int('antiRaid.joinThreshold'),
          'join-window': int('antiRaid.joinWindow'),
          'min-account-age': int('antiRaid.minAccountAgeDays'),
          'new-account-action': str('antiRaid.newAccountAction'),
          'auto-lockdown': bool('antiRaid.autoLockdown'),
          slowmode: int('antiRaid.raidSlowmode'),
        }), { title: 'Raid Protection Updated' });

      case 'antinuke': {
        const changes = collect({
          enabled: bool('antiNuke.enabled'),
          punishment: str('antiNuke.punishment'),
          'attempt-restore': bool('antiNuke.attemptRestore'),
        });
        const whitelist = interaction.options.getUser('whitelist');
        const unwhitelist = interaction.options.getUser('unwhitelist');
        const current = config.antiNuke?.whitelist ?? [];
        if (whitelist) changes['antiNuke.whitelist'] = [...new Set([...current, whitelist.id])];
        if (unwhitelist) changes['antiNuke.whitelist'] = (changes['antiNuke.whitelist'] ?? current).filter((id) => id !== unwhitelist.id);
        return apply(changes, { title: 'Anti-Nuke Updated' });
      }

      // ── Logging / backups / reports ───────────────────────────────────────
      case 'logging': {
        const changes = collect({
          enabled: bool('logging.enabled'),
          persist: bool('logging.persist'),
        });
        const event = interaction.options.getString('event');
        const eventEnabled = interaction.options.getBoolean('event-enabled');
        if (event) {
          if (eventEnabled === null) throw new errors.ValidationError('Provide `event-enabled` when toggling an event.');
          if (!(event in (config.logging?.events ?? {}))) throw new errors.ValidationError(`\`${event}\` is not a known logging event.`);
          changes[`logging.events.${event}`] = eventEnabled;
        }
        const ignoreChannel = interaction.options.getChannel('ignore-channel');
        if (ignoreChannel) {
          const current = config.logging?.ignoredChannels ?? [];
          changes['logging.ignoredChannels'] = current.includes(ignoreChannel.id)
            ? current.filter((id) => id !== ignoreChannel.id)
            : [...current, ignoreChannel.id];
        }
        return apply(changes, { title: 'Logging Updated' });
      }

      case 'channel': {
        const logKey = interaction.options.getString('log');
        const destination = interaction.options.getChannel('destination');
        return apply({ [`logChannels.${logKey}`]: destination.id }, { title: 'Log Destination Updated' });
      }

      case 'backups':
        return apply(collect({
          enabled: bool('backups.enabled'),
          'interval-hours': int('backups.intervalHours'),
          retain: int('backups.retain'),
        }), { title: 'Backup Settings Updated' });

      case 'reports':
        return apply(collect({
          daily: bool('reports.daily'),
          weekly: bool('reports.weekly'),
          'hour-utc': int('reports.hourUtc'),
        }), { title: 'Report Settings Updated' });

      default:
        throw new errors.ValidationError('Unknown subcommand.');
    }
  },
};
