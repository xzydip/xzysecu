const {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags, InteractionContextType,
} = require('discord.js');
const { db } = require('../db');
const { enforce, log } = require('./moderation');
const { setRaid, raidState } = require('./modules');

const guildOnly = (b) => b.setContexts(InteractionContextType.Guild);

const definitions = [
  guildOnly(
    new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Warn a member and record an infraction')
      .addUserOption((o) => o.setName('user').setDescription('Member to warn').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Why they are being warned').setRequired(true).setMaxLength(300))
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  ),
  guildOnly(
    new SlashCommandBuilder()
      .setName('infractions')
      .setDescription('Show a member\'s recent infractions')
      .addUserOption((o) => o.setName('user').setDescription('Member to look up').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  ),
  guildOnly(
    new SlashCommandBuilder()
      .setName('raidmode')
      .setDescription('Turn raid mode on or off')
      .addStringOption((o) =>
        o.setName('state').setDescription('On or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })
      )
      .addIntegerOption((o) => o.setName('minutes').setDescription('How long raid mode lasts (default 30)').setMinValue(1).setMaxValue(240))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  ),
  guildOnly(
    new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Delete recent messages in this channel')
      .addIntegerOption((o) => o.setName('count').setDescription('How many (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  ),
].map((c) => c.toJSON());

const say = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

async function handle(i) {
  if (!i.isChatInputCommand() || !i.guild) return;

  switch (i.commandName) {
    case 'warn': {
      const member = i.options.getMember('user');
      const reason = i.options.getString('reason', true);
      if (!member) return say(i, 'That person is not in this server.');
      if (member.user.bot) return say(i, 'You can\'t warn a bot.');
      if (member.id === i.user.id) return say(i, 'You can\'t warn yourself.');
      const isOwner = i.guild.ownerId === i.user.id;
      if (!isOwner && member.roles.highest.position >= i.member.roles.highest.position) {
        return say(i, 'You can only warn members whose highest role is below yours.');
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const summary = await enforce(i.guild, member, { type: 'warn', reason }, { action: 'delete' }, i.user.id);
      return i.editReply({ content: `Warned ${member.user.tag}. Result: ${summary}.`, allowedMentions: { parse: [] } });
    }

    case 'infractions': {
      const user = i.options.getUser('user', true);
      const rows = db
        .prepare('SELECT id, type, reason, created_at FROM infractions WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 10')
        .all(i.guild.id, user.id);
      if (!rows.length) return say(i, `${user.tag} has no infractions.`);
      const embed = new EmbedBuilder()
        .setTitle(`Infractions for ${user.tag}`)
        .setColor(0xffb020)
        .setDescription(rows.map((r) => `#${r.id} <t:${Math.floor(r.created_at / 1000)}:R> **${r.type}**: ${r.reason || 'No reason'}`).join('\n').slice(0, 4000));
      return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    case 'raidmode': {
      const on = i.options.getString('state', true) === 'on';
      const minutes = i.options.getInteger('minutes') ?? 30;
      setRaid(i.guild, on ? minutes : 0, `/raidmode by ${i.user.tag}`);
      return say(i, on ? `Raid mode is on for ${minutes} minute(s).` : 'Raid mode is off.');
    }

    case 'purge': {
      const count = i.options.getInteger('count', true);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const deleted = await i.channel.bulkDelete(count, true);
        log(i.guild, 'Purge', `${i.user.tag} deleted ${deleted.size} message(s) in <#${i.channel.id}>.`);
        return i.editReply(`Deleted ${deleted.size} message(s). Messages older than 14 days can't be bulk deleted.`);
      } catch {
        return i.editReply('I couldn\'t delete messages here. Check that I have Manage Messages in this channel.');
      }
    }
  }
}

module.exports = { definitions, handle, raidState };
