'use strict';

/**
 * Local brand artwork.
 *
 * Discord will not fetch a file path, and it will not render an SVG, so the
 * panel headers are shipped as PNGs in `brand/panels/` and uploaded as message
 * attachments. Referencing an attachment from an embed uses the
 * `attachment://<filename>` scheme, which resolves against the files uploaded
 * with that same message.
 *
 * Uploading rather than hot-linking is deliberate. Discord's CDN links for
 * attachments now carry an expiry signature, so a URL captured once and stored
 * in the database would quietly 404 weeks later; re-uploading on each publish
 * costs a couple of hundred kilobytes and never rots.
 */

const fs = require('node:fs');
const path = require('node:path');

const { AttachmentBuilder, PermissionFlagsBits } = require('discord.js');

const { logger } = require('./logger');

const log = logger.child('assets');

const PANEL_DIR = path.join(__dirname, '..', '..', 'brand', 'panels');

/**
 * Panel keys that have artwork on disk, resolved once at startup.
 *
 * A missing file is not an error: the bot has to keep working for anyone who
 * cloned without the artwork, or who deleted it to save space. Panels simply
 * fall back to the text-only embed.
 */
const available = new Set();

try {
  for (const file of fs.readdirSync(PANEL_DIR)) {
    if (file.endsWith('.png')) available.add(path.basename(file, '.png'));
  }
  log.debug('Panel artwork loaded', { count: available.size });
} catch (err) {
  if (err.code !== 'ENOENT') log.warn('Could not read panel artwork', { message: err.message });
}

/** Does artwork exist for this panel key? */
const hasPanelArt = (key) => available.has(key);

/**
 * Build a fresh attachment for a panel header.
 *
 * A new `AttachmentBuilder` per call is intentional — discord.js consumes the
 * stream when the attachment is uploaded, so a cached instance would upload
 * correctly once and then send a zero-byte file on every subsequent publish.
 *
 * @param {string} key panel key, e.g. `pricing`
 * @returns {{ attachment: import('discord.js').AttachmentBuilder, url: string }|null}
 */
function panelArt(key) {
  if (!available.has(key)) return null;

  const name = `${key}.png`;
  const attachment = new AttachmentBuilder(path.join(PANEL_DIR, name), {
    name,
    description: `${key} panel header`,
  });

  return { attachment, url: `attachment://${name}` };
}

/**
 * Decorate a built panel payload with its header artwork, in place.
 *
 * Applied centrally rather than inside each of the fifteen panel builders so
 * that every panel gains, loses or restyles its art in one edit.
 *
 * @param {{ embeds: Array<import('discord.js').EmbedBuilder>, files?: Array<unknown> }} payload
 * @param {string} key panel key
 * @param {object} config guild configuration
 * @param {import('discord.js').GuildTextBasedChannel} [channel] destination, for a
 *   permission check — without **Attach Files** the send would fail outright and
 *   the panel would not appear at all, so the art is dropped and the text kept.
 * @returns the same payload
 */
function attachPanelArt(payload, key, config, channel = null) {
  if (config?.theme?.panelImages === false) return payload;

  if (channel?.guild?.members?.me) {
    const permissions = channel.permissionsFor(channel.guild.members.me);
    if (!permissions?.has(PermissionFlagsBits.AttachFiles)) {
      log.debug('Skipping panel art: no Attach Files permission', { channelId: channel.id, key });
      return payload;
    }
  }

  const art = panelArt(key);
  if (!art) return payload;

  const embed = payload.embeds?.[0];
  // `setImage` exists on EmbedBuilder; a plain APIEmbed object needs the raw key.
  if (typeof embed?.setImage === 'function') embed.setImage(art.url);
  else if (embed) embed.image = { url: art.url };
  else return payload;

  payload.files = [...(payload.files ?? []), art.attachment];
  return payload;
}

module.exports = { PANEL_DIR, hasPanelArt, panelArt, attachPanelArt };
