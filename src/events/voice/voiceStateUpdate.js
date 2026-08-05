'use strict';

/**
 * Voice activity logging: joins, leaves, moves, mutes and deafens.
 */

const { Events } = require('discord.js');

const configService = require('../../services/configService');
const logService = require('../../services/logService');
const { EMOJIS } = require('../../config/branding');

module.exports = {
  name: Events.VoiceStateUpdate,

  /**
   * @param {import('../../core/Client').StudioClient} client
   * @param {import('discord.js').VoiceState} oldState
   * @param {import('discord.js').VoiceState} newState
   */
  async execute(client, oldState, newState) {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;

    const config = await configService.get(guild);
    const events = config.logging?.events ?? {};
    const member = newState.member ?? oldState.member;
    if (!member) return;

    const base = {
      category: 'voice',
      actorId: member.id,
      actorName: member.user?.tag ?? '',
      severity: 'debug',
    };

    // ── Join ────────────────────────────────────────────────────────────────
    if (!oldState.channelId && newState.channelId) {
      if (!events.voiceJoin) return;
      return logService.record(guild, {
        ...base,
        event: 'voiceJoin',
        title: '🔊 Voice Joined',
        summary: `${member.user?.tag} joined <#${newState.channelId}>`,
        channelId: newState.channelId,
      }, config);
    }

    // ── Leave ───────────────────────────────────────────────────────────────
    if (oldState.channelId && !newState.channelId) {
      if (!events.voiceLeave) return;
      return logService.record(guild, {
        ...base,
        event: 'voiceLeave',
        title: '🔈 Voice Left',
        summary: `${member.user?.tag} left <#${oldState.channelId}>`,
        channelId: oldState.channelId,
      }, config);
    }

    // ── Move ────────────────────────────────────────────────────────────────
    if (oldState.channelId !== newState.channelId) {
      if (!events.voiceMove) return;
      return logService.record(guild, {
        ...base,
        event: 'voiceMove',
        title: '🔀 Voice Moved',
        summary: `${member.user?.tag} moved channels`,
        channelId: newState.channelId,
        fields: { From: `<#${oldState.channelId}>`, To: `<#${newState.channelId}>` },
      }, config);
    }

    // ── Mute / deafen ───────────────────────────────────────────────────────
    if (!events.voiceStateUpdate) return;

    const changes = {};
    if (oldState.serverMute !== newState.serverMute) changes['Server mute'] = newState.serverMute ? 'Enabled' : 'Disabled';
    if (oldState.serverDeaf !== newState.serverDeaf) changes['Server deafen'] = newState.serverDeaf ? 'Enabled' : 'Disabled';
    if (oldState.selfMute !== newState.selfMute) changes['Self mute'] = newState.selfMute ? 'Muted' : 'Unmuted';
    if (oldState.selfDeaf !== newState.selfDeaf) changes['Self deafen'] = newState.selfDeaf ? 'Deafened' : 'Undeafened';
    if (oldState.streaming !== newState.streaming) changes.Streaming = newState.streaming ? 'Started' : 'Stopped';

    if (!Object.keys(changes).length) return null;

    // Self-mute noise is not worth a log line; server-side actions are.
    const isModerationAction = 'Server mute' in changes || 'Server deafen' in changes;
    if (!isModerationAction) return null;

    return logService.record(guild, {
      ...base,
      event: 'voiceStateUpdate',
      title: `${EMOJIS.moderation} Voice State Changed`,
      summary: `${member.user?.tag} was server-muted or deafened`,
      channelId: newState.channelId ?? oldState.channelId,
      severity: 'info',
      fields: changes,
    }, config);
  },
};
