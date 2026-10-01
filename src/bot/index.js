const { Client, GatewayIntentBits, Events, AuditLogEvent } = require('discord.js');
const { getSettings } = require('../settings');
const { enforce, isExempt } = require('./moderation');
const { MESSAGE_CHECKS, checkRestricted, punishBotWithCommand, onJoin, onBotAdded, onDestructive } = require('./modules');
const commands = require('./commands');
const presence = require('./presence');

async function removeMessages(msg, purge) {
  if (!purge) return msg.delete().catch(() => {});
  const byChannel = new Map();
  for (const e of purge) {
    if (!byChannel.has(e.channelId)) byChannel.set(e.channelId, []);
    byChannel.get(e.channelId).push(e.id);
  }
  await Promise.all(
    [...byChannel].map(([channelId, ids]) => msg.guild.channels.cache.get(channelId)?.bulkDelete(ids, true).catch(() => {}))
  );
}

function notify(msg, user, reason) {
  msg.channel
    .send({ content: `${user}, your message was removed: ${reason}.`, allowedMentions: { users: [user.id] } })
    .then((m) => setTimeout(() => m.delete().catch(() => {}), 8000))
    .catch(() => {});
}

async function onMessage(msg) {
  if (!msg.guild || msg.system) return;
  const s = getSettings(msg.guild.id);

  // Restricted commands also look at other bots' replies to slash commands, so check before the bot filter.
  const restricted = await checkRestricted(msg, s);
  if (restricted) {
    if (restricted.punishInvoker || msg.author.bot) await msg.delete().catch(() => {});
    if (restricted.punishInvoker) {
      await enforce(msg.guild, restricted.member, restricted.hit, restricted.cfg);
      notify(msg, restricted.member.user, restricted.hit.reason);
    }
    if (restricted.botAuthor) await punishBotWithCommand(msg.guild, restricted.botAuthor, restricted.label);
    return;
  }

  if (msg.author.bot || !msg.member) return;
  if (isExempt(msg.member, s)) return;
  if (s.exemptChannelIds.includes(msg.channel.id) || s.exemptChannelIds.includes(msg.channel.parentId)) return;

  for (const [name, check] of MESSAGE_CHECKS) {
    const cfg = s.modules[name];
    if (!cfg.enabled) continue;
    const hit = check(msg, cfg);
    if (!hit) continue;

    await removeMessages(msg, hit.purge);
    await enforce(msg.guild, msg.member, hit, cfg);
    notify(msg, msg.author, hit.reason);
    break;
  }
}

function createBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers, // privileged: enable in the Developer Portal
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // privileged: enable in the Developer Portal
      GatewayIntentBits.GuildModeration,
    ],
  });

  client.once(Events.ClientReady, async (c) => {
    console.log(`Bastion is online as ${c.user.tag} in ${c.guilds.cache.size} server(s).`);
    await c.application.commands.set(commands.definitions).catch((e) => console.error('Command registration failed:', e));
    presence.apply(c);
  });

  client.on(Events.MessageCreate, (m) => onMessage(m).catch((e) => console.error('[message]', e)));
  client.on(Events.GuildMemberAdd, (m) => {
    onJoin(m).catch((e) => console.error('[join]', e));
    onBotAdded(m).catch((e) => console.error('[bot-added]', e));
  });
  client.on(Events.InteractionCreate, (i) => commands.handle(i).catch((e) => console.error('[command]', e)));

  client.on(Events.ChannelDelete, (ch) => {
    if (ch.guild) onDestructive(ch.guild, AuditLogEvent.ChannelDelete, ch.id, `deleted #${ch.name}`).catch(() => {});
  });
  client.on(Events.GuildRoleDelete, (r) => onDestructive(r.guild, AuditLogEvent.RoleDelete, r.id, `deleted role ${r.name}`).catch(() => {}));
  client.on(Events.GuildBanAdd, (b) => onDestructive(b.guild, AuditLogEvent.MemberBanAdd, b.user.id, `banned ${b.user.tag}`).catch(() => {}));

  client.on(Events.GuildUpdate, (oldG, newG) => {
    if (oldG.name !== newG.name) {
      onDestructive(newG, AuditLogEvent.GuildUpdate, newG.id, `${oldG.name} to ${newG.name}`, {
        serverName: true, oldName: oldG.name,
      }).catch(() => {});
    }
  });

  client.on(Events.Error, (e) => console.error('[client]', e));
  return client;
}

module.exports = { createBot };
