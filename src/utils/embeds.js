'use strict';

/**
 * Embed factory — the visual language of the product.
 *
 * Every embed in the codebase is produced here, which guarantees a single
 * palette, a single footer style and a consistent layout everywhere. Helpers
 * accept an optional guild `config` so per-guild theming and branding apply
 * automatically.
 */

const { EmbedBuilder } = require('discord.js');
const { COLORS, EMOJIS, BRAND } = require('../config/branding');
const { truncate, safeField } = require('./formatters');

/** Discord's hard limits — enforced defensively so an embed never 400s. */
const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, fields: 25 };

/**
 * Resolve branding + palette from an optional guild configuration document.
 * @param {object} [config]
 */
function resolveBrand(config) {
  const brand = config?.brand ?? {};
  const theme = config?.theme ?? {};
  return {
    name: brand.name || BRAND.name,
    tagline: brand.tagline || BRAND.tagline,
    footer: brand.footer || BRAND.footer,
    logoUrl: brand.logoUrl || BRAND.logoUrl,
    bannerUrl: brand.bannerUrl || BRAND.bannerUrl,
    websiteUrl: brand.websiteUrl || BRAND.websiteUrl,
    colors: {
      primary: theme.primary ?? COLORS.primary,
      accent: theme.accent ?? COLORS.accent,
      success: theme.success ?? COLORS.success,
      warning: theme.warning ?? COLORS.warning,
      danger: theme.danger ?? COLORS.danger,
      info: theme.info ?? COLORS.info,
    },
  };
}

/**
 * Core builder. Everything else is a thin preset on top of this.
 *
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.description]
 * @param {number|string} [options.color]
 * @param {Array<{name: string, value: string, inline?: boolean}>} [options.fields]
 * @param {string} [options.footer] appended after the brand footer
 * @param {string} [options.thumbnail]
 * @param {string} [options.image]
 * @param {{ name: string, iconURL?: string, url?: string }} [options.author]
 * @param {string} [options.url]
 * @param {boolean} [options.timestamp] defaults to true
 * @param {object} [options.config] guild configuration for theming
 * @returns {EmbedBuilder}
 */
function base({
  title,
  description,
  color,
  fields = [],
  footer,
  thumbnail,
  image,
  author,
  url,
  timestamp = true,
  config,
} = {}) {
  const brand = resolveBrand(config);
  const embed = new EmbedBuilder().setColor(color ?? brand.colors.primary);

  if (title) embed.setTitle(truncate(title, LIMITS.title));
  if (description) embed.setDescription(truncate(description, LIMITS.description));
  if (url) embed.setURL(url);
  if (thumbnail) embed.setThumbnail(thumbnail);
  else if (brand.logoUrl && !thumbnail && thumbnail !== null) embed.setThumbnail(brand.logoUrl);
  if (image) embed.setImage(image);
  if (author) embed.setAuthor({ name: truncate(author.name, LIMITS.author), iconURL: author.iconURL || undefined, url: author.url || undefined });

  const clean = fields
    .filter((field) => field && field.name && field.value !== undefined && field.value !== null && field.value !== '')
    .slice(0, LIMITS.fields)
    .map((field) => ({
      name: truncate(String(field.name), LIMITS.fieldName),
      value: truncate(String(field.value), LIMITS.fieldValue),
      inline: Boolean(field.inline),
    }));
  if (clean.length) embed.addFields(clean);

  const footerText = footer ? `${brand.footer} ${EMOJIS.dot} ${footer}` : brand.footer;
  embed.setFooter({ text: truncate(footerText, LIMITS.footer), iconURL: brand.logoUrl || undefined });
  if (timestamp) embed.setTimestamp();

  return embed;
}

/** Neutral / informational. */
const info = (options) => base({ ...options, color: options?.color ?? resolveBrand(options?.config).colors.primary });

/** Positive outcome. */
const success = (options) =>
  base({
    ...options,
    color: options?.color ?? resolveBrand(options?.config).colors.success,
    title: options?.title ? `${EMOJIS.success} ${options.title}` : undefined,
  });

/** Non-fatal caution. */
const warning = (options) =>
  base({
    ...options,
    color: options?.color ?? resolveBrand(options?.config).colors.warning,
    title: options?.title ? `${EMOJIS.warning} ${options.title}` : undefined,
  });

/** Failure — never leaks internals, always actionable. */
const error = (options) =>
  base({
    ...options,
    color: options?.color ?? resolveBrand(options?.config).colors.danger,
    title: options?.title ? `${EMOJIS.error} ${options.title}` : `${EMOJIS.error} Something went wrong`,
  });

/** Large branded surface used for public panels (rules, ToS, pricing …). */
const panel = (options) =>
  base({
    ...options,
    color: options?.color ?? resolveBrand(options?.config).colors.accent,
    image: options?.image ?? resolveBrand(options?.config).bannerUrl ?? undefined,
  });

/**
 * Render a document from `config/content.js` into a branded panel embed.
 * @param {{title: string, intro?: string, sections?: Array<{name: string, value: string}>, footer?: string}} document
 * @param {object} [options]
 */
function fromDocument(document, options = {}) {
  return panel({
    title: document.title,
    description: document.intro,
    fields: (document.sections ?? []).map((section) => ({ name: section.name, value: section.value })),
    footer: document.footer,
    ...options,
  });
}

/**
 * Compact one-line acknowledgement (used for ephemeral confirmations).
 * @param {string} message
 * @param {'success'|'error'|'warning'|'info'} [tone]
 * @param {object} [config]
 */
function notice(message, tone = 'info', config) {
  const brand = resolveBrand(config);
  const glyph = { success: EMOJIS.success, error: EMOJIS.error, warning: EMOJIS.warning, info: EMOJIS.info }[tone];
  const color = { success: brand.colors.success, error: brand.colors.danger, warning: brand.colors.warning, info: brand.colors.primary }[tone];
  return new EmbedBuilder().setColor(color).setDescription(`${glyph} ${truncate(message, LIMITS.description - 4)}`);
}

/**
 * Build a two-column "detail" field set from an object, skipping empty values.
 * @param {Record<string, string|number|null|undefined>} data
 * @param {boolean} [inline]
 */
function detailFields(data, inline = true) {
  return Object.entries(data)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([name, value]) => ({ name, value: safeField(value), inline }));
}

/** Section heading rendered inside a description for long documents. */
function heading(text) {
  return `**${text}**\n${BRAND.thinDivider}`;
}

module.exports = {
  base,
  info,
  success,
  warning,
  error,
  panel,
  notice,
  fromDocument,
  detailFields,
  heading,
  resolveBrand,
  LIMITS,
};
