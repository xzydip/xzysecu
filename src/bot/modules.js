const { AuditLogEvent, EmbedBuilder, UserFlags } = require('discord.js');
const { db } = require('../db');
const { getSettings } = require('../settings');
const { log, record, applyAction } = require('./moderation');

/* ---------------- Message checks: each returns a violation or null ---------------- */

const spamBuckets = new Map();
setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [k, arr] of spamBuckets) if (!arr.length || arr[arr.length - 1].ts < cutoff) spamBuckets.delete(k);
}, 60000).unref();

const countEmojis = (t) => (t.match(/\p{Extended_Pictographic}|<a?:\w+:\d+>/gu) || []).length;

function checkSpam(msg, cfg) {
  const key = `${msg.guild.id}:${msg.author.id}`;
  const now = Date.now();
  const keep = Math.max(cfg.perSeconds * 1000, 30000);
  const arr = (spamBuckets.get(key) || []).filter((e) => now - e.ts < keep);
  const text = msg.content.trim().toLowerCase().replace(/\s+/g, ' ');
  arr.push({ id: msg.id, channelId: msg.channel.id, ts: now, text });
  spamBuckets.set(key, arr);

  // 1. Too many messages too fast
  const recent = arr.filter((e) => now - e.ts < cfg.perSeconds * 1000);
  if (recent.length > cfg.maxMessages) {
    spamBuckets.delete(key);
    return { type: 'spam', reason: `Sent ${recent.length} messages in ${cfg.perSeconds}s`, purge: recent };
  }
  // 2. Same message repeated
  if (cfg.duplicateCount > 0 && text.length >= 3) {
    const same = arr.filter((e) => e.text === text);
    if (same.length >= cfg.duplicateCount) {
      spamBuckets.delete(key);
      return { type: 'spam', reason: `Repeated the same message ${same.length} times`, purge: same };
    }
  }
  // 3. Emoji spam
  if (cfg.maxEmojis > 0) {
    const n = countEmojis(msg.content);
    if (n > cfg.maxEmojis) return { type: 'spam', reason: `Used ${n} emojis in one message` };
  }
  // 4. Shouting (needs at least 12 letters so short messages like "OK" never trigger)
  if (cfg.capsPercent > 0) {
    const letters = msg.content.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 12) {
      const pct = (letters.replace(/[^\p{Lu}]/gu, '').length / letters.length) * 100;
      if (pct >= cfg.capsPercent) return { type: 'spam', reason: `Message is ${Math.round(pct)}% capital letters` };
    }
  }
  return null;
}

function checkMentions(msg, cfg) {
  const n = msg.mentions.users.size + msg.mentions.roles.size;
  return n > cfg.max ? { type: 'mention', reason: `Mentioned ${n} users/roles in one message` } : null;
}

const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg|invite\.gg)\/[a-z0-9-]+/i;
const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>()]+/gi;

function hostOf(raw) {
  try {
    const u = new URL(/^https?:/i.test(raw) ? raw : `http://${raw}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}
const SHORTENERS = [
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rb.gy', 'shorturl.at',
  'ow.ly', 'buff.ly', 'tiny.cc', 'rebrand.ly', 'bit.do', 'lnkd.in',
];
const domainMatch = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));

function checkLinks(msg, cfg) {
  const text = msg.content;
  if (!text) return null;

  const inviteAllowed = cfg.allowedDomains.some((d) => d === 'discord.gg' || d === 'discord.com');
  if (cfg.blockInvites && !inviteAllowed && INVITE_RE.test(text)) {
    return { type: 'link', reason: 'Posted a Discord invite' };
  }
  for (const raw of text.match(LINK_RE) || []) {
    const host = hostOf(raw);
    if (!host) continue;
    if (domainMatch(host, cfg.blockedDomains)) return { type: 'link', reason: `Blocked domain: ${host}` };
    if (cfg.blockShorteners && domainMatch(host, SHORTENERS) && !domainMatch(host, cfg.allowedDomains)) {
      return { type: 'link', reason: `Link shortener: ${host}` };
    }
    if (cfg.blockAllLinks && !domainMatch(host, cfg.allowedDomains)) {
      return { type: 'link', reason: `Link not on the allowed list: ${host}` };
    }
  }
  return null;
}

const wordCache = new Map();
const LEET = { '@': 'a', '0': 'o', '1': 'i', '3': 'e', '$': 's', '5': 's', '7': 't' };
const unleet = (t) => t.toLowerCase().replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '').replace(/[@013$57]/g, (c) => LEET[c]);

function checkWords(msg, cfg) {
  if (!cfg.words.length || !msg.content) return null;
  const key = `${cfg.matchInside}|${cfg.words.join('\n')}`;
  let re = wordCache.get(key);
  if (!re) {
    const alt = cfg.words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    re = new RegExp(cfg.matchInside ? `(?:${alt})` : `(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, 'iu');
    if (wordCache.size > 200) wordCache.clear();
    wordCache.set(key, re);
  }
  if (re.test(msg.content) || (cfg.catchTricks && re.test(unleet(msg.content)))) {
    return { type: 'badword', reason: 'Used a blocked word' };
  }
  return null;
}

const MESSAGE_CHECKS = [
  ['antiSpam', checkSpam],
  ['mentionSpam', checkMentions],
  ['linkFilter', checkLinks],
  ['badWords', checkWords],
];

/* ---------------- Unverified commands ---------------- */

function parsePrefixCommand(text, cfg, restricted) {
  const t = String(text || '').trim().toLowerCase();
  const prefix = [...cfg.prefixes].sort((x, y) => y.length - x.length).find((p) => p && t.startsWith(p.toLowerCase()));
  if (!prefix) return null;
  const name = t.slice(prefix.length).trim().split(/\s+/)[0];
  return name && restricted.has(name) ? { name, label: `${prefix}${name}` } : null;
}

/**
 * Looks at a message for an unverified command, either typed with a prefix (!ban) or a slash
 * command answered by another bot. Returns what to do, or null:
 * { member, cfg, label, hit, punishInvoker, botAuthor }
 *  - punishInvoker: the person who used the command should be punished
 *  - botAuthor: the bot that answered the command (it has that command) should be kicked
 */
async function checkRestricted(msg, s) {
  const cfg = s.modules.restrictedCommands;
  const audit = s.modules.botAudit;
  if (!cfg.commands.length || msg.author.id === msg.client.user.id) return null;

  const restricted = new Set(cfg.commands.map((c) => c.replace(/^[^\p{L}\p{N}]+/u, '')));
  let userId;
  let label;
  let member = null;
  let botAuthor = null;
  let alreadyPunished = false;

  if (msg.author.bot) {
    botAuthor = msg.author;
    const full = msg.interaction?.commandName?.toLowerCase();
    const user = msg.interactionMetadata?.user || msg.interaction?.user;
    if (full && user) {
      const name = restricted.has(full) ? full : full.split(' ')[0];
      if (!restricted.has(name)) return null;
      userId = user.id;
      label = `/${full}`;
    } else if (msg.reference?.messageId) {
      // Prefix command: the other bot replied to a message containing the command (cache only, no API calls).
      const ref = msg.channel.messages.cache.get(msg.reference.messageId);
      if (!ref || ref.author.bot) return null;
      const hit = parsePrefixCommand(ref.content, cfg, restricted);
      if (!hit) return null;
      userId = ref.author.id;
      label = hit.label;
      alreadyPunished = true; // the person's own message was already handled
    } else {
      return null;
    }
  } else {
    const hit = parsePrefixCommand(msg.content, cfg, restricted);
    if (!hit) return null;
    userId = msg.author.id;
    label = hit.label;
    member = msg.member;
  }

  const wantBot = !!botAuthor && audit.enabled && audit.kickBotsWithCommands && !audit.allowedBotIds.includes(botAuthor.id);
  const wantUser = cfg.enabled && !alreadyPunished && (!botAuthor || cfg.detectSlash);
  if (!wantBot && !wantUser) return null;

  if (!member) member = await msg.guild.members.fetch(userId).catch(() => null);
  const verified =
    !member ||
    member.user.bot ||
    member.id === msg.guild.ownerId ||
    s.exemptUserIds.includes(member.id) ||
    cfg.allowedUserIds.includes(member.id) ||
    member.roles.cache.some((r) => cfg.allowedRoleIds.includes(r.id)) ||
    (cfg.allowAdmins && member.permissions.has('Administrator'));

  const punishInvoker = wantUser && !verified;
  if (!punishInvoker && !wantBot) return null;

  return {
    member, cfg, label, punishInvoker,
    botAuthor: wantBot ? botAuthor : null,
    hit: { type: 'command', reason: `Used unverified command ${label}` },
  };
}

/* ---------------- Raid defence ---------------- */

const joins = new Map();
const raidUntil = new Map();

function raidState(guildId) {
  const until = raidUntil.get(guildId) || 0;
  return until > Date.now() ? { active: true, until } : { active: false, until: null };
}

function setRaid(guild, minutes, by = 'automatic trigger') {
  if (minutes > 0) {
    raidUntil.set(guild.id, Date.now() + minutes * 60000);
    log(guild, 'Raid mode on', `Raid mode enabled for ${minutes} minute(s) (${by}). New joins are being handled.`, 0xff6b6b);
  } else {
    raidUntil.delete(guild.id);
    log(guild, 'Raid mode off', `Raid mode ended (${by}).`, 0x5fd3b4);
  }
}

async function onJoin(member) {
  const cfg = getSettings(member.guild.id).modules.antiRaid;
  if (!cfg.enabled || member.user.bot) return;

  const gid = member.guild.id;
  const now = Date.now();
  const arr = (joins.get(gid) || []).filter((t) => now - t < cfg.perSeconds * 1000);
  arr.push(now);
  joins.set(gid, arr);

  if (arr.length >= cfg.joinThreshold && !raidState(gid).active) {
    setRaid(member.guild, cfg.raidMinutes, `${arr.length} joins in ${cfg.perSeconds}s`);
  }

  const young = cfg.minAccountAgeDays > 0 && now - member.user.createdTimestamp < cfg.minAccountAgeDays * 864e5;
  let reason = null;
  if (raidState(gid).active) reason = 'Joined during raid mode';
  else if (young) reason = `Account is younger than ${cfg.minAccountAgeDays} day(s)`;
  if (!reason) return;

  const ok = await applyAction(member, cfg.action, `[Bastion] ${reason}`, cfg.timeoutMinutes);
  record(gid, member.id, member.client.user.id, 'raid', reason);
  log(
    member.guild,
    'Raid defence',
    `${member.user.tag} (${member.id}): ${reason}. ` +
      (ok ? `Action: ${cfg.action}.` : 'Could not apply the action. Check Bastion\'s role position and permissions.'),
    0xff6b6b
  );
}

/* ---------------- Anti-nuke ---------------- */

const nukeBuckets = new Map();
const VERBS = { kick: 'kicked', ban: 'banned', strip: 'stripped of all roles' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Audit log entries can lag behind the event, so try twice.
async function findExecutor(guild, auditType, targetId, needsNameChange) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 6 }).catch(() => null);
    const entry = logs?.entries.find(
      (e) =>
        (!targetId || e.targetId === targetId) &&
        Date.now() - e.createdTimestamp < 15000 &&
        (!needsNameChange || e.changes?.some((c) => c.key === 'name'))
    );
    if (entry?.executor) return entry.executor;
    await sleep(1200);
  }
  return null;
}

/**
 * Called for channel/role deletes, bans and server renames.
 * opts.serverName: a rename is punished immediately (no counting) and reverted.
 */
async function onDestructive(guild, auditType, targetId, what, opts = {}) {
  const s = getSettings(guild.id);
  const cfg = s.modules.antiNuke;
  if (!cfg.enabled) return;
  if (opts.serverName && !cfg.protectServerName) return;

  const executor = await findExecutor(guild, auditType, targetId, opts.serverName);
  if (!executor) return;
  if (executor.id === guild.ownerId || executor.id === guild.client.user.id) return;
  if (s.exemptUserIds.includes(executor.id)) return;
  if (cfg.botsOnly && !executor.bot) return;

  let reason;
  if (opts.serverName) {
    reason = `changed the server name (${what})`;
  } else {
    const key = `${guild.id}:${executor.id}`;
    const now = Date.now();
    const arr = (nukeBuckets.get(key) || []).filter((t) => now - t < cfg.perSeconds * 1000);
    arr.push(now);
    nukeBuckets.set(key, arr);
    if (arr.length < cfg.maxActions) return;
    nukeBuckets.delete(key);
    reason = `${arr.length} destructive actions in ${cfg.perSeconds}s (latest: ${what})`;
  }

  const member = await guild.members.fetch(executor.id).catch(() => null);
  const ok = member ? await applyAction(member, cfg.action, `[Bastion] Trying to nuke server: ${reason}`) : false;
  record(guild.id, executor.id, guild.client.user.id, 'nuke', reason);

  let restored = '';
  if (opts.serverName && opts.oldName) {
    const done = await guild.setName(opts.oldName, '[Bastion] Reverting unauthorised server rename').then(() => true).catch(() => false);
    restored = done ? `\nServer name restored to **${opts.oldName}**.` : '\nCould not restore the server name.';
  }

  const who = `${executor.bot ? 'Bot' : 'User'} **${executor.tag}** (${executor.id})`;
  const head = ok
    ? `${who} was ${VERBS[cfg.action]}: trying to nuke server.`
    : `${who} is trying to nuke server, but I couldn't ${cfg.action} them. Move Bastion's role above theirs.`;
  log(guild, 'Anti-nuke', `${head}\nReason: ${reason}.${restored}`, 0xff6b6b);
}

/* ---------------- Bot checks (who added which bot) ---------------- */

const DANGEROUS = new Set([
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'KickMembers',
  'BanMembers', 'ManageWebhooks', 'MentionEveryone', 'ModerateMembers',
]);
const nice = (p) => p.replace(/([a-z])([A-Z])/g, '$1 $2');

async function onBotAdded(member) {
  const guild = member.guild;
  const cfg = getSettings(guild.id).modules.botAudit;
  if (!cfg.enabled || !member.user.bot || member.id === guild.client.user.id) return;

  await sleep(1000); // let Discord attach the bot's role and write the audit log
  const fresh = await member.fetch().catch(() => member);
  const adder = await findExecutor(guild, AuditLogEvent.BotAdd, member.id);

  const perms = fresh.permissions.toArray();
  const permText = perms.includes('Administrator')
    ? 'Administrator (full access)'
    : perms.length ? perms.map(nice).join(', ') : 'None';
  const risky = perms.filter((p) => DANGEROUS.has(p)).map(nice);

  const build = (status, color) =>
    new EmbedBuilder()
      .setColor(color)
      .setTitle('Bot added')
      .setDescription(`**${adder ? adder.tag : 'Someone'}** added bot **${member.user.tag}**`)
      .addFields(
        { name: 'Added by', value: adder ? `${adder.tag} (${adder.id})` : 'Unknown (Bastion needs View Audit Log)' },
        { name: 'Bot', value: `${member.user.tag} (${member.id})` },
        { name: 'Permissions given', value: permText.slice(0, 1000) },
        ...(risky.length ? [{ name: 'Dangerous permissions', value: risky.join(', ').slice(0, 1000) }] : []),
        { name: 'Status', value: status }
      )
      .setTimestamp();

  const channelId = getSettings(guild.id).logChannelId;
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  const msg = channel?.isTextBased()
    ? await channel.send({ embeds: [build('Checking...', 0x5b8def)], allowedMentions: { parse: [] } }).catch(() => null)
    : null;

  // Discord marks bots it has reviewed with the VerifiedBot flag; it is only returned on a fresh fetch.
  const user = await guild.client.users.fetch(member.id, { force: true }).catch(() => member.user);
  const verified = user.flags?.has(UserFlags.VerifiedBot) ?? false;
  await sleep(1000);

  let status = verified ? '✅ Verified' : '❌ Unverified';
  let color = verified ? 0x5fd3b4 : 0xffb020;
  if (!verified) {
    if (cfg.allowedBotIds.includes(member.id)) {
      status = '❌ Unverified (allowed by you)';
    } else if (cfg.action !== 'none') {
      const ok = await applyAction(fresh, cfg.action, '[Bastion] Unverified bot added');
      status = ok
        ? `❌ Unverified, ${cfg.action === 'kick' ? 'kicked' : 'banned'}`
        : `❌ Unverified (couldn't ${cfg.action} it, move Bastion's role higher)`;
      color = 0xff6b6b;
    }
  }

  if (adder) {
    db.prepare('INSERT OR REPLACE INTO added_bots(guild_id, bot_id, adder_id, created_at) VALUES(?, ?, ?, ?)').run(
      guild.id, member.id, adder.id, Date.now()
    );
  }
  await msg?.edit({ embeds: [build(status, color)] }).catch(() => {});
  db.prepare('INSERT INTO logs(guild_id, kind, message, created_at) VALUES(?, ?, ?, ?)').run(
    guild.id,
    'Bot added',
    `${adder ? adder.tag : 'Unknown'} added bot ${member.user.tag} (${member.id}). Permissions: ${permText}. Status: ${status}`,
    Date.now()
  );
}

const handledBots = new Set();

async function findAdderId(guild, botId) {
  const row = db.prepare('SELECT adder_id FROM added_bots WHERE guild_id = ? AND bot_id = ?').get(guild.id, botId);
  if (row) return row.adder_id;
  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 100 }).catch(() => null);
  return logs?.entries.find((e) => e.targetId === botId)?.executor?.id || null;
}

/** A bot answered an unverified command: kick the bot and punish whoever added it. */
async function punishBotWithCommand(guild, botUser, label) {
  const key = `${guild.id}:${botUser.id}`;
  if (handledBots.has(key)) return;
  handledBots.add(key);
  setTimeout(() => handledBots.delete(key), 60000).unref();

  const s = getSettings(guild.id);
  const audit = s.modules.botAudit;
  const botMember = await guild.members.fetch(botUser.id).catch(() => null);
  const botKicked = botMember
    ? await applyAction(botMember, 'kick', `[Bastion] Bot has unverified command ${label}`)
    : false;

  const adderId = await findAdderId(guild, botUser.id);
  const adderMember = adderId ? await guild.members.fetch(adderId).catch(() => null) : null;
  let adderText;
  if (!adderId) {
    adderText = 'Added by: unknown (no record and no audit log entry).';
  } else if (audit.adderAction === 'none') {
    adderText = `Added by <@${adderId}>. No punishment is set for them.`;
  } else if (!adderMember) {
    adderText = `Added by <@${adderId}>, who is no longer in the server.`;
  } else if (adderId === guild.ownerId || s.exemptUserIds.includes(adderId)) {
    adderText = `Added by <@${adderId}> (owner or trusted, so not punished).`;
  } else {
    const ok = await applyAction(
      adderMember, audit.adderAction,
      `[Bastion] Added bot ${botUser.tag} that has unverified command ${label}`, audit.adderTimeoutMinutes
    );
    record(guild.id, adderId, guild.client.user.id, 'bot', `Added bot ${botUser.tag} that has unverified command ${label}`);
    adderText = ok
      ? `Added by <@${adderId}>, who got: ${audit.adderAction}.`
      : `Added by <@${adderId}>, but I couldn't ${audit.adderAction} them. Move Bastion's role higher.`;
  }

  log(
    guild,
    'Bot with unverified command',
    `Bot **${botUser.tag}** (${botUser.id}) ${botKicked ? 'was kicked' : 'could not be kicked (move Bastion\'s role higher)'}: it answered unverified command **${label}**.\n${adderText}`,
    0xff6b6b
  );
}

module.exports = { MESSAGE_CHECKS, checkRestricted, punishBotWithCommand, onBotAdded, onJoin, onDestructive, raidState, setRaid };
