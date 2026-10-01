const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { db } = require('../db');
const { getSettings } = require('../settings');

/** Writes to the dashboard activity log and, if configured, the Discord log channel. */
function log(guild, kind, message, color = 0x5b8def) {
  const now = Date.now();
  db.prepare('INSERT INTO logs(guild_id, kind, message, created_at) VALUES(?, ?, ?, ?)').run(guild.id, kind, message, now);

  const channelId = getSettings(guild.id).logChannelId;
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased()) return;
  channel
    .send({
      embeds: [new EmbedBuilder().setColor(color).setTitle(kind).setDescription(message.slice(0, 4000)).setTimestamp(now)],
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

function record(guildId, userId, moderatorId, type, reason) {
  return db
    .prepare('INSERT INTO infractions(guild_id, user_id, moderator_id, type, reason, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(guildId, userId, moderatorId, type, String(reason || '').slice(0, 500), Date.now()).lastInsertRowid;
}

/** Applies a punishment. Returns true if it worked, false if Discord refused (hierarchy/permissions). */
async function applyAction(member, action, reason, minutes = 10) {
  try {
    switch (action) {
      case 'timeout':
        if (!member.moderatable) return false;
        await member.timeout(minutes * 60000, reason);
        return true;
      case 'kick':
        if (!member.kickable) return false;
        await member.kick(reason);
        return true;
      case 'ban':
        if (!member.bannable) return false;
        await member.ban({ reason, deleteMessageSeconds: 3600 });
        return true;
      case 'strip': {
        const roles = member.roles.cache.filter((r) => r.id !== member.guild.id && r.editable);
        if (!roles.size) return false;
        await member.roles.remove(roles, reason);
        return true;
      }
      default:
        return false; // 'delete' needs no member action
    }
  } catch (err) {
    console.error(`[moderation] ${action} failed:`, err.message);
    return false;
  }
}

/**
 * Records an infraction, applies the module's action, then checks escalation thresholds.
 * Returns a short human-readable summary of what was done.
 */
async function enforce(guild, member, violation, cfg, moderatorId = guild.client.user.id) {
  const s = getSettings(guild.id);
  record(guild.id, member.id, moderatorId, violation.type, violation.reason);

  const taken = [];
  const reason = `[Bastion] ${violation.reason}`;

  if (cfg.action && cfg.action !== 'delete') {
    if (await applyAction(member, cfg.action, reason, cfg.timeoutMinutes)) taken.push(cfg.action);
  }

  const gone = taken.includes('kick') || taken.includes('ban');
  if (!gone) {
    const since = Date.now() - s.escalation.windowDays * 864e5;
    const { c } = db
      .prepare('SELECT COUNT(*) AS c FROM infractions WHERE guild_id = ? AND user_id = ? AND created_at > ?')
      .get(guild.id, member.id, since);

    if (c >= s.escalation.banAt) {
      if (await applyAction(member, 'ban', `${reason} (${c} infractions)`)) taken.push('ban (escalation)');
    } else if (c >= s.escalation.timeoutAt && !taken.includes('timeout')) {
      if (await applyAction(member, 'timeout', `${reason} (${c} infractions)`, s.escalation.timeoutMinutes)) {
        taken.push('timeout (escalation)');
      }
    }
  }

  const summary = taken.length ? taken.join(', ') : 'message removed';
  log(guild, 'Auto-moderation', `${member.user.tag} (${member.id}): ${violation.reason}. Action: ${summary}.`, 0xffb020);
  return summary;
}

function isExempt(member, settings) {
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (settings.exemptUserIds.includes(member.id)) return true;
  return member.roles.cache.some((r) => settings.exemptRoleIds.includes(r.id));
}

module.exports = { log, record, applyAction, enforce, isExempt };
