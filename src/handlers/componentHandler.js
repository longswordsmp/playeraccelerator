'use strict';

/**
 * Button, select menu and modal routing.
 *
 * Handlers are keyed by the namespace in the custom ID (`pa:<namespace>:…`).
 * A module exports:
 *
 *   {
 *     namespace: 'ticket',
 *     access: 'everyone',                 // baseline access level
 *     actions: {
 *       close:  { access: 'support', run: async (interaction, context) => {} },
 *       open:   { run: async (interaction, context) => {} },
 *     },
 *   }
 *
 * Per-action access levels are mandatory reading: a custom ID is client-side
 * data and can be replayed by anyone, so authorisation happens here on every
 * single press, not once when the component was rendered.
 */

const fs = require('node:fs');
const path = require('node:path');

const customId = require('../utils/customId');
const configService = require('../services/configService');
const logService = require('../services/logService');
const embeds = require('../utils/embeds');
const errors = require('../utils/errors');
const permissions = require('../utils/permissions');
const { safeReply } = require('../utils/discord');
const { logger } = require('../utils/logger');

const log = logger.child('components');

/** Registry key for each interaction family. */
const REGISTRIES = { buttons: 'buttons', selectMenus: 'selectMenus', modals: 'modals' };

/**
 * Load handler modules from `components/<family>`.
 * @param {import('../core/Client').StudioClient} client
 */
function load(client) {
  const root = path.join(__dirname, '..', 'components');
  let loaded = 0;

  for (const family of Object.keys(REGISTRIES)) {
    const dir = path.join(root, family);
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js') && !name.startsWith('_'))) {
      const full = path.join(dir, file);
      try {
        delete require.cache[require.resolve(full)];
        const handler = require(full);
        if (!handler?.namespace || typeof handler.actions !== 'object') {
          log.error(`Component ${family}/${file} is missing \`namespace\` or \`actions\``);
          continue;
        }
        client[family].set(handler.namespace, handler);
        loaded += 1;
      } catch (err) {
        log.error(`Failed to load component ${family}/${file}`, { message: err.message });
      }
    }
  }

  log.success(`Loaded ${loaded} component handlers`);
  return loaded;
}

/**
 * Route an interaction to its handler.
 *
 * @param {import('discord.js').MessageComponentInteraction|import('discord.js').ModalSubmitInteraction} interaction
 * @param {'buttons'|'selectMenus'|'modals'} family
 */
async function execute(interaction, family) {
  const parsed = customId.parse(interaction.customId);

  // Not ours — silently ignore so other bots' components are never touched.
  if (!parsed) return;

  // `core` handles the shared no-op / cancel affordances.
  if (parsed.namespace === 'core') return handleCore(interaction, parsed);

  const handler = interaction.client[family].get(parsed.namespace);
  if (!handler) {
    return safeReply(interaction, {
      embeds: [embeds.notice('This control is no longer available. Please refresh the panel.', 'warning')],
    }, { ephemeral: true });
  }

  const action = handler.actions[parsed.action];
  if (!action || typeof action.run !== 'function') {
    return safeReply(interaction, {
      embeds: [embeds.notice('That action is not recognised. The panel may be from an older version.', 'warning')],
    }, { ephemeral: true });
  }

  let context;
  try {
    const config = interaction.guild ? await configService.get(interaction.guild) : null;
    context = {
      client: interaction.client,
      guild: interaction.guild,
      member: interaction.member,
      user: interaction.user,
      config,
      args: parsed.args,
      embed: (options) => embeds.base({ ...options, config }),
    };

    if (handler.guildOnly !== false && !interaction.guild) {
      throw new errors.AppError('This control only works inside a server.');
    }

    // Authorise on every press — never trust the rendered component.
    const level = action.access ?? handler.access ?? 'everyone';
    if (level !== 'everyone') {
      permissions.assertLevel(context.member, level, config, 'use this control');
    }

    // Optional per-action guard for ownership checks (e.g. "your own ticket").
    if (typeof action.guard === 'function') {
      await action.guard(interaction, context);
    }

    await action.run(interaction, context);
    interaction.client.metrics.componentsHandled += 1;
  } catch (err) {
    const described = errors.describe(err);
    if (described.internal) {
      interaction.client.metrics.errors += 1;
      await logService.error(interaction.guild, err, {
        context: `${family}:${parsed.namespace}:${parsed.action}`,
        reference: described.reference,
        userId: interaction.user.id,
      });
    } else {
      log.debug(`${parsed.namespace}:${parsed.action} rejected: ${described.message}`);
    }

    const embed = described.internal
      ? embeds.error({
        config: context?.config,
        title: 'Something went wrong',
        description: `${described.message}\n\nReference: \`${described.reference}\``,
      })
      : embeds.notice(described.message, 'warning', context?.config);

    await safeReply(interaction, { embeds: [embed] }, { ephemeral: true, followUp: interaction.replied || interaction.deferred });
  }
}

/**
 * Shared `core` namespace: disabled placeholders and cancel buttons.
 * @param {import('discord.js').MessageComponentInteraction} interaction
 * @param {{ action: string }} parsed
 */
async function handleCore(interaction, parsed) {
  if (parsed.action === 'noop') {
    return interaction.deferUpdate().catch(() => null);
  }
  if (parsed.action === 'cancel') {
    return interaction.update({
      embeds: [embeds.notice('Cancelled. Nothing was changed.', 'info')],
      components: [],
    }).catch(() => null);
  }
  return interaction.deferUpdate().catch(() => null);
}

module.exports = { load, execute };
