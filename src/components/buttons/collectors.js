'use strict';

/**
 * No-op handlers for namespaces that are consumed by an in-command collector
 * (`awaitMessageComponent`) rather than by the global router.
 *
 * Without these, the router would see an unregistered namespace and reply
 * "this control is no longer available" on top of the collector's own response,
 * producing a confusing double answer.
 */

/** A handler that acknowledges nothing — the collector already responded. */
const passthrough = { run: async () => null };

module.exports = [
  {
    namespace: 'setup',
    access: 'everyone',
    actions: { confirm: passthrough },
  },
  {
    namespace: 'backup',
    access: 'everyone',
    actions: { restore: passthrough },
  },
  {
    namespace: 'confirm',
    access: 'everyone',
    actions: {
      purge: passthrough,
      ban: passthrough,
      kick: passthrough,
      lockdown: passthrough,
      unlock: passthrough,
    },
  },
];
