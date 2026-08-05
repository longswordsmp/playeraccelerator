'use strict';

/**
 * Keep the invite-use snapshot in step with reality.
 *
 * Attribution works by diffing use counts, so the cache has to be refreshed
 * whenever the set of invites changes — otherwise a brand-new link looks like
 * it "already existed at zero uses" and the first join through it is credited
 * to nobody.
 */

const { Events } = require('discord.js');
const inviteService = require('../../services/inviteService');

module.exports = [
  {
    name: Events.InviteCreate,
    async execute(client, invite) {
      if (!invite.guild) return;
      await inviteService.refresh(invite.guild);
    },
  },
  {
    name: Events.InviteDelete,
    async execute(client, invite) {
      if (!invite.guild) return;
      await inviteService.refresh(invite.guild);
    },
  },
];
