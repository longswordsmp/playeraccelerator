'use strict';

/**
 * Component factory.
 *
 * All buttons, select menus and modals are constructed here so that every
 * surface uses the same glyphs, the same button ordering and the same custom-ID
 * protocol. Discord's five-per-row / five-row limits are enforced centrally.
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const customId = require('./customId');
const { EMOJIS } = require('../config/branding');
const { truncate } = require('./formatters');

const STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
  link: ButtonStyle.Link,
};

/**
 * Build a button.
 * @param {object} options
 * @param {string} [options.id] custom id (already encoded)
 * @param {string} [options.url] makes it a link button
 * @param {string} options.label
 * @param {string} [options.emoji]
 * @param {keyof STYLES} [options.style]
 * @param {boolean} [options.disabled]
 */
function button({ id, url, label, emoji, style = 'secondary', disabled = false }) {
  const builder = new ButtonBuilder().setLabel(truncate(label, 80)).setDisabled(Boolean(disabled));
  if (url) builder.setStyle(ButtonStyle.Link).setURL(url);
  else builder.setStyle(STYLES[style] ?? ButtonStyle.Secondary).setCustomId(id);
  if (emoji) builder.setEmoji(emoji);
  return builder;
}

/**
 * Wrap components into action rows, five per row, max five rows.
 * @param {Array<import('discord.js').ButtonBuilder>} buttons
 * @returns {ActionRowBuilder[]}
 */
function rows(buttons) {
  const out = [];
  const usable = buttons.filter(Boolean).slice(0, 25);
  for (let index = 0; index < usable.length; index += 5) {
    out.push(new ActionRowBuilder().addComponents(usable.slice(index, index + 5)));
  }
  return out;
}

/** A single action row wrapping one non-button component. */
const row = (component) => new ActionRowBuilder().addComponents(component);

/**
 * Build a string select menu.
 * @param {object} options
 * @param {string} options.id
 * @param {string} options.placeholder
 * @param {Array<{label: string, value: string, description?: string, emoji?: string, default?: boolean}>} options.options
 * @param {number} [options.min]
 * @param {number} [options.max]
 * @param {boolean} [options.disabled]
 */
function select({ id, placeholder, options, min = 1, max = 1, disabled = false }) {
  const items = options.slice(0, 25).map((option) => {
    const builder = new StringSelectMenuOptionBuilder()
      .setLabel(truncate(option.label, 100))
      .setValue(truncate(String(option.value), 100));
    if (option.description) builder.setDescription(truncate(option.description, 100));
    if (option.emoji) builder.setEmoji(option.emoji);
    if (option.default) builder.setDefault(true);
    return builder;
  });

  return new StringSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder(truncate(placeholder, 150))
    .setMinValues(Math.max(0, Math.min(min, items.length)))
    .setMaxValues(Math.max(1, Math.min(max, items.length)))
    .setDisabled(Boolean(disabled))
    .addOptions(items);
}

/** User picker select menu. */
const userSelect = ({ id, placeholder, min = 1, max = 1 }) =>
  new UserSelectMenuBuilder().setCustomId(id).setPlaceholder(truncate(placeholder, 150)).setMinValues(min).setMaxValues(max);

/** Role picker select menu. */
const roleSelect = ({ id, placeholder, min = 1, max = 1 }) =>
  new RoleSelectMenuBuilder().setCustomId(id).setPlaceholder(truncate(placeholder, 150)).setMinValues(min).setMaxValues(max);

/** Channel picker select menu. */
const channelSelect = ({ id, placeholder, types, min = 1, max = 1 }) => {
  const builder = new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder(truncate(placeholder, 150)).setMinValues(min).setMaxValues(max);
  if (types?.length) builder.setChannelTypes(types);
  return builder;
};

/**
 * Build a modal from a compact field description.
 * @param {object} options
 * @param {string} options.id
 * @param {string} options.title
 * @param {Array<{id: string, label: string, style?: 'short'|'paragraph', placeholder?: string, value?: string, required?: boolean, min?: number, max?: number}>} options.fields
 */
function modal({ id, title, fields }) {
  const builder = new ModalBuilder().setCustomId(id).setTitle(truncate(title, 45));
  // Discord allows a maximum of five inputs per modal.
  const inputs = fields.slice(0, 5).map((field) => {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(truncate(field.label, 45))
      .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required !== false);
    if (field.placeholder) input.setPlaceholder(truncate(field.placeholder, 100));
    if (field.value) input.setValue(truncate(field.value, 4000));
    if (field.min) input.setMinLength(field.min);
    input.setMaxLength(field.max ?? (field.style === 'paragraph' ? 1500 : 200));
    return new ActionRowBuilder().addComponents(input);
  });
  builder.addComponents(inputs);
  return builder;
}

// ── Shared component presets ────────────────────────────────────────────────

/** The public ticket panel button row. */
function ticketPanelButtons() {
  return rows([
    button({ id: customId.build('ticket', 'open'), label: 'Create Ticket', emoji: EMOJIS.ticket, style: 'primary' }),
    button({ id: customId.build('review', 'start'), label: 'Leave a Review', emoji: EMOJIS.star, style: 'secondary' }),
    button({ id: customId.build('portfolio', 'browse'), label: 'View Portfolio', emoji: EMOJIS.portfolio, style: 'secondary' }),
    button({ id: customId.build('promotion', 'start'), label: 'Promotion Request', emoji: EMOJIS.promotion, style: 'secondary' }),
  ]);
}

/**
 * Ticket control panel. Composition changes with ticket state so a closed
 * ticket never offers "close" and an open ticket never offers "reopen".
 * @param {{ status: string, claimed: boolean, ticketId: string }} ticket
 */
function ticketControls({ status, claimed, ticketId }) {
  const id = (action, ...args) => customId.build('ticket', action, ticketId, ...args);

  if (status === 'closed') {
    return rows([
      button({ id: id('reopen'), label: 'Reopen', emoji: EMOJIS.reopen, style: 'success' }),
      button({ id: id('transcript'), label: 'Transcript', emoji: EMOJIS.transcript, style: 'secondary' }),
      button({ id: id('delete'), label: 'Delete', emoji: EMOJIS.trash, style: 'danger' }),
    ]);
  }

  return rows([
    button({
      id: claimed ? id('unclaim') : id('claim'),
      label: claimed ? 'Release' : 'Claim',
      emoji: claimed ? EMOJIS.transfer : EMOJIS.claim,
      style: claimed ? 'secondary' : 'success',
    }),
    button({ id: id('close'), label: 'Close', emoji: EMOJIS.close, style: 'danger' }),
    button({ id: id('priority'), label: 'Priority', emoji: EMOJIS.priority, style: 'secondary' }),
    button({ id: id('members'), label: 'Members', emoji: EMOJIS.users, style: 'secondary' }),
    button({ id: id('manage'), label: 'More', emoji: EMOJIS.pencil, style: 'secondary' }),
  ]);
}

/** Star rating buttons for the review flow. */
function reviewStars(ticketId) {
  return rows(
    [1, 2, 3, 4, 5].map((rating) =>
      button({
        id: customId.build('review', 'rate', ticketId, rating),
        label: `${rating}`,
        emoji: EMOJIS.star,
        style: rating >= 4 ? 'success' : rating === 3 ? 'secondary' : 'danger',
      }),
    ),
  );
}

/** Developer status quick-switch row (staff only). */
function statusButtons() {
  return rows([
    // "Auto" leads: pinning a status is the exception, not the default.
    button({ id: customId.build('status', 'set', 'auto'), label: 'Auto', emoji: '🕒', style: 'success' }),
    button({ id: customId.build('status', 'set', 'coding'), label: 'Coding', emoji: '💻', style: 'primary' }),
    button({ id: customId.build('status', 'set', 'streaming'), label: 'Streaming', emoji: '🎮', style: 'primary' }),
    button({ id: customId.build('status', 'set', 'busy'), label: 'Busy', emoji: '🟡', style: 'secondary' }),
    button({ id: customId.build('status', 'set', 'offline'), label: 'Offline', emoji: '🔴', style: 'danger' }),
  ]);
}

/**
 * A confirm / cancel pair for destructive actions.
 * @param {string} namespace
 * @param {string} action
 * @param {string[]} args
 * @param {{ confirmLabel?: string, danger?: boolean }} [options]
 */
function confirmation(namespace, action, args = [], { confirmLabel = 'Confirm', danger = true } = {}) {
  return rows([
    button({ id: customId.build(namespace, action, ...args), label: confirmLabel, emoji: EMOJIS.success, style: danger ? 'danger' : 'success' }),
    button({ id: customId.build('core', 'cancel'), label: 'Cancel', emoji: EMOJIS.error, style: 'secondary' }),
  ]);
}

/**
 * Pagination controls used by every list surface.
 * @param {string} namespace
 * @param {string} action
 * @param {number} page zero-based
 * @param {number} pages total
 * @param {string[]} [extra] additional args appended to each custom id
 */
function pagination(namespace, action, page, pages, extra = []) {
  const id = (target) => customId.build(namespace, action, target, ...extra);
  return rows([
    button({ id: id(0), label: 'First', emoji: '⏮️', style: 'secondary', disabled: page <= 0 }),
    button({ id: id(Math.max(0, page - 1)), label: 'Back', emoji: EMOJIS.back, style: 'secondary', disabled: page <= 0 }),
    button({ id: customId.build('core', 'noop'), label: `${page + 1} / ${Math.max(1, pages)}`, style: 'primary', disabled: true }),
    button({ id: id(Math.min(pages - 1, page + 1)), label: 'Next', emoji: EMOJIS.forward, style: 'secondary', disabled: page >= pages - 1 }),
    button({ id: id(Math.max(0, pages - 1)), label: 'Last', emoji: '⏭️', style: 'secondary', disabled: page >= pages - 1 }),
  ]);
}

module.exports = {
  button,
  rows,
  row,
  select,
  userSelect,
  roleSelect,
  channelSelect,
  modal,
  ticketPanelButtons,
  ticketControls,
  reviewStars,
  statusButtons,
  confirmation,
  pagination,
  ButtonStyle,
  TextInputStyle,
};
