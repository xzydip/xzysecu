const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');
const { PermissionFlagsBits, PermissionsBitField, ChannelType } = require('discord.js');
const { db } = require('../db');
const { getSettings, saveSettings } = require('../settings');
const { log } = require('../bot/moderation');
const { raidState, setRaid } = require('../bot/modules');
const presence = require('../bot/presence');

module.exports = function startDashboard(client) {
  const {
    PORT = 3000, CLIENT_ID, CLIENT_SECRET, SESSION_SECRET, OWNER_IDS = '',
  } = process.env;
  const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

  for (const [k, v] of Object.entries({ CLIENT_ID, CLIENT_SECRET, SESSION_SECRET })) {
    if (!v) throw new Error(`Missing ${k} in .env (see .env.example)`);
  }
  const owners = new Set(OWNER_IDS.split(',').map((s) => s.trim()).filter(Boolean));
  const REDIRECT_URI = `${BASE_URL}/auth/callback`;
  const secure = BASE_URL.startsWith('https://');

  const BOT_PERMS = [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ViewAuditLog,
  ];
  const inviteUrl = (guildId) =>
    'https://discord.com/oauth2/authorize?' +
    new URLSearchParams({
      client_id: CLIENT_ID,
      scope: 'bot applications.commands',
      permissions: new PermissionsBitField(BOT_PERMS).bitfield.toString(),
      ...(guildId ? { guild_id: guildId, disable_guild_select: 'true' } : {}),
    });

  const app = express();
  if (secure) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", 'https://fonts.googleapis.com'],
          fontSrc: ['https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'https://cdn.discordapp.com', 'data:'],
          connectSrc: ["'self'"],
          upgradeInsecureRequests: null,
        },
      },
    })
  );
  app.use(express.json({ limit: '100kb' }));
  // NOTE: MemoryStore is fine for a single small bot. For production use a persistent store.
  app.use(
    session({
      name: 'bastion.sid',
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure, maxAge: 7 * 864e5 },
    })
  );

  /* ---------- helpers ---------- */
  const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  const requireAuth = (req, res, next) =>
    req.session.user ? next() : res.status(401).json({ error: 'Not signed in' });

  const requireOwner = (req, res, next) =>
    owners.has(req.session.user.id) ? next() : res.status(403).json({ error: 'Only bot owners can do this' });

  // Verified live against the guild so removed permissions take effect immediately.
  const requireGuild = ah(async (req, res, next) => {
    const guild = client.guilds.cache.get(req.params.id);
    if (!guild) return res.status(404).json({ error: 'Bastion is not in that server' });
    const member = await guild.members.fetch(req.session.user.id).catch(() => null);
    if (!member || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return res.status(403).json({ error: 'You need the Manage Server permission in that server' });
    }
    req.guild = guild;
    next();
  });

  app.param('id', (req, res, next, id) =>
    /^\d{5,25}$/.test(id) ? next() : res.status(400).json({ error: 'Invalid server ID' })
  );

  // CSRF defence in depth: state-changing API calls must carry a custom header.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'bastion') {
      return res.status(403).json({ error: 'Missing request header' });
    }
    next();
  });

  /* ---------- auth ---------- */
  app.get('/auth/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    req.session.save(() =>
      res.redirect(
        'https://discord.com/oauth2/authorize?' +
          new URLSearchParams({
            client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI,
            scope: 'identify guilds', state, prompt: 'none',
          })
      )
    );
  });

  app.get('/auth/callback', ah(async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) {
      return res.status(400).send('The sign-in link expired or was invalid. Go back to the dashboard and sign in again.');
    }
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code',
        code: String(code), redirect_uri: REDIRECT_URI,
      }),
    });
    const token = await tokenRes.json();
    if (!token.access_token) {
      return res.status(400).send('Discord rejected the sign-in. Check CLIENT_SECRET and that the redirect URL matches exactly.');
    }
    const headers = { Authorization: `Bearer ${token.access_token}` };
    const [user, guilds] = await Promise.all([
      fetch('https://discord.com/api/users/@me', { headers }).then((r) => r.json()),
      fetch('https://discord.com/api/users/@me/guilds', { headers }).then((r) => r.json()),
    ]);

    const manageable = (Array.isArray(guilds) ? guilds : [])
      .filter((g) => g.owner || (BigInt(g.permissions) & 0x28n) !== 0n) // Administrator or Manage Server
      .map((g) => ({ id: g.id, name: g.name, icon: g.icon }));

    // New session ID on login prevents session fixation. The OAuth token is not kept.
    req.session.regenerate((err) => {
      if (err) return res.status(500).send('Could not start a session.');
      req.session.user = { id: user.id, name: user.global_name || user.username, avatar: user.avatar };
      req.session.guilds = manageable;
      req.session.save(() => res.redirect('/'));
    });
  }));

  app.get('/auth/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

  /* ---------- API: account ---------- */
  app.get('/api/me', requireAuth, (req, res) => {
    const { user, guilds } = req.session;
    res.json({
      user,
      isOwner: owners.has(user.id),
      guilds: guilds.map((g) => ({ ...g, botIn: client.guilds.cache.has(g.id), invite: inviteUrl(g.id) })),
    });
  });

  /* ---------- API: per-server ---------- */
  const g = '/api/guilds/:id';

  app.get(`${g}/meta`, requireAuth, requireGuild, (req, res) => {
    const { guild } = req;
    res.json({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      channels: guild.channels.cache
        .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map((c) => ({ id: c.id, name: c.name })),
      roles: guild.roles.cache
        .filter((r) => r.id !== guild.id && !r.managed)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name })),
    });
  });

  app.get(`${g}/settings`, requireAuth, requireGuild, (req, res) => res.json(getSettings(req.guild.id)));

  app.put(`${g}/settings`, requireAuth, requireGuild, (req, res) => {
    const saved = saveSettings(req.guild.id, req.body);
    log(req.guild, 'Settings changed', `${req.session.user.name} updated protection settings from the dashboard.`);
    res.json(saved);
  });

  app.get(`${g}/overview`, requireAuth, requireGuild, (req, res) => {
    const { guild } = req;
    const now = Date.now();
    const day = 864e5;
    const rows = db
      .prepare('SELECT type, created_at FROM infractions WHERE guild_id = ? AND created_at > ?')
      .all(guild.id, now - 7 * day);

    const days = Array(7).fill(0);
    const byType = {};
    let last24 = 0;
    for (const r of rows) {
      const age = now - r.created_at;
      days[6 - Math.min(6, Math.floor(age / day))]++;
      if (age < day) last24++;
      byType[r.type] = (byType[r.type] || 0) + 1;
    }

    const me = guild.members.me;
    const missing = me ? me.permissions.missing(BOT_PERMS) : [];

    res.json({
      memberCount: guild.memberCount,
      raid: raidState(guild.id),
      last24, week: rows.length, days, byType, missingPerms: missing,
      recent: db
        .prepare('SELECT id, kind, message, created_at FROM logs WHERE guild_id = ? ORDER BY id DESC LIMIT 6')
        .all(guild.id),
    });
  });

  app.post(`${g}/raid`, requireAuth, requireGuild, (req, res) => {
    const minutes = Math.min(240, Math.max(0, parseInt(req.body?.minutes, 10) || 0));
    setRaid(req.guild, minutes, `dashboard, ${req.session.user.name}`);
    res.json(raidState(req.guild.id));
  });

  app.get(`${g}/infractions`, requireAuth, requireGuild, (req, res) => {
    const user = /^\d{5,25}$/.test(String(req.query.user || '')) ? String(req.query.user) : null;
    const rows = db
      .prepare(
        `SELECT id, user_id, moderator_id, type, reason, created_at FROM infractions
         WHERE guild_id = ? AND (? IS NULL OR user_id = ?) ORDER BY id DESC LIMIT 100`
      )
      .all(req.guild.id, user, user);
    const name = (id) => req.guild.members.cache.get(id)?.user.tag || null;
    res.json(rows.map((r) => ({ ...r, user_tag: name(r.user_id), moderator_tag: name(r.moderator_id) })));
  });

  app.delete(`${g}/infractions/:inf`, requireAuth, requireGuild, (req, res) => {
    const info = db
      .prepare('DELETE FROM infractions WHERE id = ? AND guild_id = ?')
      .run(parseInt(req.params.inf, 10) || 0, req.guild.id);
    if (info.changes) log(req.guild, 'Infraction removed', `${req.session.user.name} removed infraction #${req.params.inf}.`);
    res.json({ deleted: info.changes });
  });

  app.get(`${g}/logs`, requireAuth, requireGuild, (req, res) => {
    const before = parseInt(req.query.before, 10) || null;
    res.json(
      db
        .prepare(
          `SELECT id, kind, message, created_at FROM logs
           WHERE guild_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT 50`
        )
        .all(req.guild.id, before, before)
    );
  });

  /* ---------- API: bot management (owners only) ---------- */
  app.get('/api/admin/bot', requireAuth, requireOwner, (req, res) => {
    res.json({
      tag: client.user?.tag,
      ping: client.ws.ping,
      uptime: Math.floor(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      presence: presence.load(),
      types: Object.keys(presence.TYPES),
      statuses: presence.STATUSES,
      invite: inviteUrl(),
      guilds: client.guilds.cache.map((gd) => ({ id: gd.id, name: gd.name, icon: gd.icon, members: gd.memberCount })),
    });
  });

  app.post('/api/admin/presence', requireAuth, requireOwner, (req, res) => res.json(presence.save(client, req.body)));

  app.post('/api/admin/guilds/:id/leave', requireAuth, requireOwner, ah(async (req, res) => {
    const guild = client.guilds.cache.get(req.params.id);
    if (!guild) return res.status(404).json({ error: 'Bastion is not in that server' });
    await guild.leave();
    res.json({ left: true });
  }));

  /* ---------- static + errors ---------- */
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => {
    console.error('[dashboard]', err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });

  app.listen(PORT, () => console.log(`Dashboard running at ${BASE_URL}`));
};
