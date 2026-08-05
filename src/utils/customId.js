'use strict';

/**
 * Custom ID protocol for buttons, select menus and modals.
 *
 * Format:  `pa:<namespace>:<action>[:arg]…`
 *
 * Discord caps custom IDs at 100 characters, so the encoder validates length up
 * front rather than letting the API reject the component at render time.
 * Arguments are URL-encoded, which keeps `:` usable as an unambiguous separator.
 */

const PREFIX = 'pa';
const SEPARATOR = ':';
const MAX_LENGTH = 100;

/**
 * Build a custom ID.
 * @param {string} namespace handler namespace, e.g. `ticket`
 * @param {string} action action within the namespace, e.g. `close`
 * @param {...(string|number)} args
 * @returns {string}
 */
function build(namespace, action, ...args) {
  const parts = [PREFIX, namespace, action, ...args.map((arg) => encodeURIComponent(String(arg ?? '')))];
  const id = parts.join(SEPARATOR);
  if (id.length > MAX_LENGTH) {
    throw new RangeError(`Custom ID exceeds ${MAX_LENGTH} characters: ${namespace}:${action}`);
  }
  return id;
}

/**
 * Parse a custom ID produced by {@link build}.
 * @param {string} customId
 * @returns {{ namespace: string, action: string, args: string[] }|null}
 */
function parse(customId) {
  if (typeof customId !== 'string' || !customId.startsWith(`${PREFIX}${SEPARATOR}`)) return null;
  const [, namespace, action, ...rest] = customId.split(SEPARATOR);
  if (!namespace || !action) return null;
  return { namespace, action, args: rest.map((arg) => decodeURIComponent(arg)) };
}

/** Whether a custom ID belongs to this application's protocol. */
const isOwned = (customId) => typeof customId === 'string' && customId.startsWith(`${PREFIX}${SEPARATOR}`);

module.exports = { build, parse, isOwned, PREFIX, SEPARATOR, MAX_LENGTH };
