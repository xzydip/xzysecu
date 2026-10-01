(() => {
  'use strict';

  /* ================= config ================= */
  const ACTION_LABELS = {
    delete: 'Delete the message only',
    timeout: 'Time out the member',
    kick: 'Kick the member',
    ban: 'Ban the member',
    strip: 'Remove all their roles',
    none: 'Do nothing (still reported)',
  };
  const BASIC = ['delete', 'timeout', 'kick', 'ban'];
  const TYPE_LABELS = {
    spam: 'Spam', command: 'Unverified command', bot: 'Added a bad bot', mention: 'Mention spam', link: 'Blocked link', badword: 'Blocked word',
    raid: 'Raid defence', nuke: 'Anti-nuke', warn: 'Warning',
  };

  const MODULES = [
    {
      key: 'antiSpam', group: 'automod', title: 'Spam',
      desc: 'Stops message floods, repeated messages, emoji spam and shouting. Set a number to 0 to turn that check off.',
      fields: [
        { k: 'maxMessages', label: 'More than', type: 'number', min: 2, max: 30, suffix: 'messages' },
        { k: 'perSeconds', label: 'Within', type: 'number', min: 2, max: 120, suffix: 'seconds' },
        { k: 'duplicateCount', label: 'Same message repeated', type: 'number', min: 0, max: 20, suffix: 'times (0 = off)' },
        { k: 'maxEmojis', label: 'More than', type: 'number', min: 0, max: 50, suffix: 'emojis (0 = off)' },
        { k: 'capsPercent', label: 'Capital letters at', type: 'number', min: 0, max: 100, suffix: '% (0 = off)' },
        { k: 'action', label: 'Punishment', type: 'select', options: BASIC },
        { k: 'timeoutMinutes', label: 'Timeout length', type: 'number', min: 1, max: 40320, suffix: 'minutes' },
      ],
    },
    {
      key: 'mentionSpam', group: 'automod', title: 'Mention spam',
      desc: 'Stops messages that ping lots of people or roles at once.',
      fields: [
        { k: 'max', label: 'More than', type: 'number', min: 2, max: 50, suffix: 'mentions' },
        { k: 'action', label: 'Then', type: 'select', options: BASIC },
        { k: 'timeoutMinutes', label: 'Timeout length', type: 'number', min: 1, max: 40320, suffix: 'minutes' },
      ],
    },
    {
      key: 'linkFilter', group: 'automod', title: 'Bad links',
      desc: 'Blocks Discord invites, link shorteners and any domains you list.',
      fields: [
        { k: 'blockInvites', label: 'Block Discord invites', type: 'bool' },
        { k: 'blockShorteners', label: 'Block link shorteners (bit.ly, tinyurl and similar)', type: 'bool' },
        { k: 'blockAllLinks', label: 'Block every link except allowed domains', type: 'bool' },
        { k: 'action', label: 'Then', type: 'select', options: BASIC },
        { k: 'timeoutMinutes', label: 'Timeout length', type: 'number', min: 1, max: 40320, suffix: 'minutes' },
        { k: 'blockedDomains', label: 'Blocked domains (one per line)', type: 'list', wide: true },
        { k: 'allowedDomains', label: 'Allowed domains (one per line)', type: 'list', wide: true },
      ],
    },
    {
      key: 'badWords', group: 'automod', title: 'Bad words',
      desc: 'Removes messages containing words you list, ignoring capital letters.',
      fields: [
        { k: 'action', label: 'Then', type: 'select', options: BASIC },
        { k: 'timeoutMinutes', label: 'Timeout length', type: 'number', min: 1, max: 40320, suffix: 'minutes' },
        { k: 'matchInside', label: 'Also match inside other words', type: 'bool' },
        { k: 'catchTricks', label: 'Catch tricks like b@d w0rd', type: 'bool' },
        { k: 'words', label: 'Bad words (one per line)', type: 'list', wide: true },
      ],
    },
    {
      key: 'restrictedCommands', title: 'Unverified commands',
      desc: 'Add commands here and they become unverified. Anyone who uses one gets the punishment you choose below, admins included. Only the server owner and the exceptions you list are safe.',
      fields: [
        { k: 'commands', label: 'Unverified commands (one per line, without the prefix)', type: 'list', wide: true },
        { k: 'prefixes', label: 'Prefixes to watch (one per line)', type: 'list' },
        { k: 'detectSlash', label: 'Also catch slash commands answered by other bots', type: 'bool' },
        { k: 'allowAdmins', label: 'Let administrators use these commands without punishment', type: 'bool' },
        { k: 'allowedRoleIds', label: 'Exception roles (optional, allowed to use them)', type: 'roles' },
        { k: 'allowedUserIds', label: 'Exception user IDs (optional, one per line)', type: 'list', wide: true },
        { k: 'action', label: 'Punishment', type: 'select', options: BASIC },
        { k: 'timeoutMinutes', label: 'Timeout length', type: 'number', min: 1, max: 40320, suffix: 'minutes' },
      ],
    },
    {
      key: 'botAudit', title: 'Bot checks',
      desc: 'When someone adds a bot, Bastion posts who added it, which permissions it got, and whether Discord has verified it.',
      fields: [
        { k: 'action', label: 'If the bot is unverified', type: 'select', options: ['none', 'kick', 'ban'] },
        { type: 'note', label: 'Discord does not let Bastion read another bot\'s command list. So when anyone uses a command from your Unverified commands list and a bot answers it, Bastion finds that bot.' },
        { k: 'kickBotsWithCommands', label: 'Kick any bot that answers an unverified command', type: 'bool' },
        { k: 'adderAction', label: 'Punish the member who added that bot', type: 'select', options: ['none', 'timeout', 'kick', 'ban'] },
        { k: 'adderTimeoutMinutes', label: 'Timeout length for that member', type: 'number', min: 1, max: 40320, suffix: 'minutes' },
        { k: 'allowedBotIds', label: 'Bots you trust (bot IDs, one per line). They are never kicked.', type: 'list', wide: true },
        { type: 'channel', label: 'Log channel: the report is posted here' },
      ],
    },
    {
      key: 'antiRaid', title: 'Raid defence',
      desc: 'Detects a flood of new members, switches on raid mode, and handles everyone who joins during it.',
      fields: [
        { k: 'joinThreshold', label: 'Raid when', type: 'number', min: 2, max: 100, suffix: 'joins' },
        { k: 'perSeconds', label: 'Within', type: 'number', min: 2, max: 120, suffix: 'seconds' },
        { k: 'raidMinutes', label: 'Raid mode lasts', type: 'number', min: 1, max: 240, suffix: 'minutes' },
        { k: 'minAccountAgeDays', label: 'Reject accounts younger than', type: 'number', min: 0, max: 365, suffix: 'days (0 = off)' },
        { k: 'action', label: 'Handle joiners by', type: 'select', options: ['timeout', 'kick', 'ban'] },
        { k: 'timeoutMinutes', label: 'Timeout length', type: 'number', min: 1, max: 40320, suffix: 'minutes' },
      ],
    },
    {
      key: 'antiNuke', title: 'Anti-nuke',
      desc: 'Kicks bots (or people) who delete channels or roles too fast, mass-ban, or rename the server. The server owner is never touched.',
      fields: [
        { k: 'maxActions', label: 'Trigger at', type: 'number', min: 1, max: 20, suffix: 'deletes or bans' },
        { k: 'perSeconds', label: 'Within', type: 'number', min: 2, max: 120, suffix: 'seconds' },
        { k: 'action', label: 'Then', type: 'select', options: ['kick', 'ban', 'strip'] },
        { k: 'protectServerName', label: 'Act immediately if the server name is changed (and restore the old name)', type: 'bool' },
        { k: 'botsOnly', label: 'Only act on bots (ignore human admins)', type: 'bool' },
        { type: 'channel', label: 'Log channel: Bastion posts what it did here' },
      ],
    },
  ];

  /* ================= helpers ================= */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fmtTime = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtUptime = (s) => `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  const iconUrl = (id, hash) => (hash ? `https://cdn.discordapp.com/icons/${id}/${hash}.png?size=64` : null);
  const iconHtml = (id, hash, name) =>
    iconUrl(id, hash)
      ? `<img class="ico" src="${iconUrl(id, hash)}" alt="" width="32" height="32">`
      : `<span class="ico ph">${esc((name || '?').trim()[0] || '?').toUpperCase()}</span>`;

  function toast(message, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'bastion', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const getPath = (obj, path) => path.split('.').reduce((o, k) => o[k], obj);

  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    keys.reduce((o, k) => o[k], obj)[last] = value;
  }

  /* ================= state ================= */
  const state = {
    me: null, route: { view: 'servers' }, guildId: null, meta: null,
    settings: null, draft: null, dirty: false, logs: [], infUser: '',
  };

  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 'bot') return { view: 'bot' };
    if (parts[0] === 'g' && /^\d+$/.test(parts[1] || '')) return { view: 'guild', id: parts[1], page: parts[2] || 'overview' };
    return { view: 'servers' };
  }
  const guildInfo = () => state.me?.guilds.find((g) => g.id === state.route.id);

  /* ================= shell ================= */
  function renderLogin() {
    $('#app').innerHTML = `
      <div class="landing">
        <h1>Bastion</h1>
        <p>Keep your Discord server safe from spam, raids and rogue admins, and manage it all from one place.</p>
        <a class="btn primary" href="/auth/login">Sign in with Discord</a>
      </div>`;
  }

  function mountShell() {
    const r = state.route;
    const g = guildInfo();
    const pages = [['overview', 'Overview'], ['automod', 'Auto-mod'], ['protection', 'Protection'], ['settings', 'Settings'], ['infractions', 'Infractions'], ['activity', 'Activity']];
    const u = state.me.user;
    const avatar = u.avatar
      ? `<img class="ico" src="https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64" alt="" width="32" height="32">`
      : `<span class="ico ph">${esc(u.name[0] || '?').toUpperCase()}</span>`;

    $('#app').innerHTML = `
      <div class="shell">
        <aside class="rail">
          <a class="brand" href="#/">Bastion</a>
          ${r.view === 'guild' && g ? `<a class="server-chip" href="#/" title="Switch server">${iconHtml(g.id, g.icon, g.name)}<span>${esc(g.name)}</span></a>` : ''}
          <nav class="nav" aria-label="Sections">
            <a href="#/" ${r.view === 'servers' ? 'aria-current="page"' : ''}>Servers</a>
            ${r.view === 'guild' ? `<div class="sep"></div>${pages.map(([k, l]) => `<a href="#/g/${r.id}/${k}" ${r.page === k ? 'aria-current="page"' : ''}>${l}</a>`).join('')}` : ''}
            ${state.me.isOwner ? `<div class="sep"></div><a href="#/bot" ${r.view === 'bot' ? 'aria-current="page"' : ''}>Bot management</a>` : ''}
          </nav>
          <div class="who">${avatar}<span>${esc(u.name)}</span><a href="/auth/logout">Sign out</a></div>
        </aside>
        <main class="main" id="main"><p class="muted">Loading…</p></main>
      </div>
      <div class="savebar" id="savebar" role="region" aria-label="Unsaved changes">
        <span>You have unsaved changes</span>
        <button class="btn" data-action="discard">Discard</button>
        <button class="btn primary" data-action="save">Save changes</button>
      </div>`;
  }

  const main = (html) => {
    $('#main').innerHTML = html;
    document.querySelectorAll('[data-h]').forEach((el) => (el.style.height = `${el.dataset.h}%`));
    document.querySelectorAll('[data-w]').forEach((el) => (el.style.width = `${el.dataset.w}%`));
  };
  const head = (title, sub) => `<div class="page-head"><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>`;

  function setDirty(v) {
    state.dirty = v;
    $('#savebar')?.classList.toggle('show', v);
  }

  /* ================= pages ================= */
  function pageServers() {
    const guilds = state.me.guilds;
    main(`
      ${head('Your servers', 'Servers where you can manage settings. Pick one to open its protection dashboard.')}
      ${guilds.length ? `<ul class="servers">${guilds.map((g) => `
        <li>${iconHtml(g.id, g.icon, g.name)}
          <div class="grow"><strong>${esc(g.name)}</strong><span class="muted">${g.botIn ? 'Bastion is protecting this server' : 'Bastion is not in this server yet'}</span></div>
          ${g.botIn ? `<a class="btn primary" href="#/g/${g.id}/overview">Open dashboard</a>` : `<a class="btn" href="${esc(g.invite)}" target="_blank" rel="noopener">Add Bastion</a>`}
        </li>`).join('')}</ul>`
        : `<div class="empty"><strong>No servers yet</strong>You need the Manage Server permission in a server to see it here.</div>`}`);
  }

  async function pageOverview() {
    const id = state.route.id;
    const o = await api(`/guilds/${id}/overview`);
    const now = Date.now();
    const labels = o.days.map((_, i) => new Date(now - (6 - i) * 864e5).toLocaleDateString([], { weekday: 'short' }));
    const peak = Math.max(1, ...o.days);
    const total = Object.values(o.byType).reduce((a, b) => a + b, 0) || 1;
    const types = Object.entries(o.byType).sort((a, b) => b[1] - a[1]);
    const raid = o.raid.active;

    main(`
      ${o.missingPerms.length ? `<div class="warnbar"><strong>Bastion is missing permissions:</strong> ${esc(o.missingPerms.join(', '))}. Some protections won't work until you grant them.</div>` : ''}
      <section class="status ${raid ? 'raid' : ''}">
        <h1>${raid ? 'Raid mode is on.' : o.last24 ? `${o.last24} handled today.` : 'All quiet.'}</h1>
        <p>${raid
          ? `New members are being handled until ${new Date(o.raid.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
          : o.last24 ? `Bastion has acted on ${o.last24} ${o.last24 === 1 ? 'incident' : 'incidents'} in the last 24 hours.` : 'Nothing needed action in the last 24 hours.'}
          ${o.memberCount.toLocaleString()} members.</p>
        <div class="row">
          ${raid
            ? `<button class="btn primary" data-action="raid" data-minutes="0">End raid mode</button>`
            : `<button class="btn alert" data-action="raid" data-minutes="30">Start raid mode for 30 minutes</button>`}
        </div>
      </section>
      <div class="split">
        <section>
          <h3>Last 7 days</h3>
          <div class="week">${o.days.map((n, i) => `
            <div><b>${n}</b><div class="track"><div class="bar ${n ? '' : 'zero'}" data-h="${Math.round((n / peak) * 100)}"></div></div>${esc(labels[i])}</div>`).join('')}</div>
        </section>
        <section>
          <h3>What was caught</h3>
          ${types.length ? `<ul class="types">${types.map(([t, n]) => `
            <li><div class="head"><span>${esc(TYPE_LABELS[t] || t)}</span><span class="muted">${n}</span></div><div class="meter"><i data-w="${Math.round((n / total) * 100)}"></i></div></li>`).join('')}</ul>`
            : `<div class="empty"><strong>Nothing this week</strong>Incidents will show up here.</div>`}
        </section>
      </div>
      <section class="feed">
        <h3>Latest activity</h3>
        ${o.recent.length ? `<ul>${o.recent.map((l) => `<li><time>${fmtTime(l.created_at)}</time><div><span class="kind">${esc(l.kind)}</span><div class="msg">${esc(l.message)}</div></div></li>`).join('')}</ul>`
          : `<div class="empty"><strong>No activity yet</strong>Actions Bastion takes will be listed here.</div>`}
      </section>`);
  }

  function fieldHtml(modKey, f, val) {
    const path = `modules.${modKey}.${f.k}`;
    if (f.type === 'channel') {
      const cur = state.draft.logChannelId;
      return `<label class="field wide"><span>${esc(f.label)}</span><select data-bind="logChannelId" data-nullable><option value="">No log channel</option>${state.meta.channels.map((c) => `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>#${esc(c.name)}</option>`).join('')}</select></label>`;
    }
    if (f.type === 'note') return `<p class="muted wide">${esc(f.label)}</p>`;
    if (f.type === 'roles') {
      const sel = state.draft.modules[modKey][f.k];
      const chips = state.meta.roles.length
        ? state.meta.roles.map((r) => `<label class="chip"><input type="checkbox" data-array="modules.${modKey}.${f.k}" value="${r.id}" ${sel.includes(r.id) ? 'checked' : ''}>${esc(r.name)}</label>`).join('')
        : '<span class="muted">This server has no roles to choose from.</span>';
      return `<div class="field wide"><span>${esc(f.label)}</span><div class="chips">${chips}</div></div>`;
    }
    if (f.type === 'bool') return `<label class="check wide"><input type="checkbox" data-bind="${path}" ${val ? 'checked' : ''}>${esc(f.label)}</label>`;
    if (f.type === 'number') return `<label class="field"><span>${esc(f.label)}</span><span class="with-suffix"><input type="number" data-bind="${path}" value="${esc(val)}" min="${f.min}" max="${f.max}"><em>${esc(f.suffix)}</em></span></label>`;
    if (f.type === 'select') return `<label class="field"><span>${esc(f.label)}</span><select data-bind="${path}">${f.options.map((o) => `<option value="${o}" ${o === val ? 'selected' : ''}>${esc(ACTION_LABELS[o])}</option>`).join('')}</select></label>`;
    if (f.type === 'list') return `<label class="field wide"><span>${esc(f.label)}</span><textarea data-list="${path}" spellcheck="false">${esc((val || []).join('\n'))}</textarea></label>`;
    return '';
  }

  function pageProtection(group = 'security') {
    const d = state.draft;
    const auto = group === 'automod';
    main(`
      ${auto
        ? head('Auto-mod', 'Spam, bad link and bad word filters. Switch each one on or off and tune how it works. Changes apply when you save.')
        : head('Protection', 'Turn each defence on or off and tune how strict it is. Changes apply when you save.')}
      ${MODULES.filter((m) => (m.group === 'automod') === auto).map((m) => {
        const cfg = d.modules[m.key];
        return `<section class="module ${cfg.enabled ? '' : 'off'}">
          <header>
            <div><h3>${esc(m.title)}</h3><p>${esc(m.desc)}</p></div>
            <input class="switch" type="checkbox" role="switch" aria-label="${esc(m.title)} enabled" data-bind="modules.${m.key}.enabled" ${cfg.enabled ? 'checked' : ''}>
          </header>
          <div class="body">${m.fields.map((f) => fieldHtml(m.key, f, cfg[f.k])).join('')}</div>
        </section>`;
      }).join('')}`);
  }

  function pageSettings() {
    const d = state.draft;
    const { channels, roles } = state.meta;
    main(`
      ${head('Settings', 'Where Bastion reports, who it ignores, and how repeat offenders are handled.')}
      <section class="group">
        <h3>Log channel</h3>
        <label class="field"><span>Bastion posts every action here as well as in the dashboard</span>
          <select data-bind="logChannelId" data-nullable>
            <option value="">No log channel</option>
            ${channels.map((c) => `<option value="${c.id}" ${c.id === d.logChannelId ? 'selected' : ''}>#${esc(c.name)}</option>`).join('')}
          </select>
        </label>
      </section>
      <section class="group">
        <h3>Escalation</h3>
        <p class="muted">Every incident counts as an infraction. Past these totals, Bastion steps up automatically, whatever each defence is set to do.</p>
        <div class="body">
          <label class="field"><span>Time out at</span><span class="with-suffix"><input type="number" data-bind="escalation.timeoutAt" value="${d.escalation.timeoutAt}" min="1" max="50"><em>infractions</em></span></label>
          <label class="field"><span>Ban at</span><span class="with-suffix"><input type="number" data-bind="escalation.banAt" value="${d.escalation.banAt}" min="2" max="100"><em>infractions</em></span></label>
          <label class="field"><span>Counted over</span><span class="with-suffix"><input type="number" data-bind="escalation.windowDays" value="${d.escalation.windowDays}" min="1" max="90"><em>days</em></span></label>
          <label class="field"><span>Escalation timeout</span><span class="with-suffix"><input type="number" data-bind="escalation.timeoutMinutes" value="${d.escalation.timeoutMinutes}" min="1" max="40320"><em>minutes</em></span></label>
        </div>
      </section>
      <section class="group">
        <h3>Ignored channels</h3>
        <p class="muted">Spam, link and word filters do nothing in these channels.</p>
        <div class="chips">${channels.map((c) => `<label class="chip"><input type="checkbox" data-array="exemptChannelIds" value="${c.id}" ${d.exemptChannelIds.includes(c.id) ? 'checked' : ''}>#${esc(c.name)}</label>`).join('')}</div>
      </section>
      <section class="group">
        <h3>Trusted roles</h3>
        <p class="muted">Members with these roles are ignored by message filters. Administrators and the owner are always ignored.</p>
        <div class="chips">${roles.length ? roles.map((r) => `<label class="chip"><input type="checkbox" data-array="exemptRoleIds" value="${r.id}" ${d.exemptRoleIds.includes(r.id) ? 'checked' : ''}>${esc(r.name)}</label>`).join('') : '<span class="muted">This server has no roles to choose from.</span>'}</div>
      </section>
      <section class="group">
        <h3>Trusted people</h3>
        <label class="field"><span>User IDs, one per line. These users are skipped by every defence, including anti-nuke.</span>
          <textarea data-list="exemptUserIds" spellcheck="false">${esc(d.exemptUserIds.join('\n'))}</textarea></label>
      </section>`);
  }

  async function pageInfractions() {
    const id = state.route.id;
    const rows = await api(`/guilds/${id}/infractions${state.infUser ? `?user=${encodeURIComponent(state.infUser)}` : ''}`);
    main(`
      ${head('Infractions', 'Everything Bastion and your moderators have recorded. Remove one to take it off a member\'s count.')}
      <div class="toolbar"><input type="text" id="inf-user" inputmode="numeric" placeholder="Filter by user ID" value="${esc(state.infUser)}" aria-label="Filter by user ID"><button class="btn" data-action="inf-search">Filter</button></div>
      ${rows.length ? `<div class="scroll"><table class="rows"><thead><tr><th>When</th><th>Member</th><th>Type</th><th>Reason</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr>
          <td>${fmtTime(r.created_at)}</td>
          <td>${esc(r.user_tag || 'Unknown member')}<span class="id">${esc(r.user_id)}</span></td>
          <td><span class="tag">${esc(TYPE_LABELS[r.type] || r.type)}</span></td>
          <td>${esc(r.reason || '')}</td>
          <td><button class="btn danger sm" data-action="del-inf" data-id="${r.id}">Remove</button></td></tr>`).join('')}
      </tbody></table></div>`
        : `<div class="empty"><strong>${state.infUser ? 'No infractions for that user' : 'No infractions recorded'}</strong>${state.infUser ? 'Check the user ID and try again.' : 'Incidents Bastion handles will be listed here.'}</div>`}`);
  }

  async function pageActivity(more = false) {
    const id = state.route.id;
    const before = more && state.logs.length ? `?before=${state.logs[state.logs.length - 1].id}` : '';
    const batch = await api(`/guilds/${id}/logs${before}`);
    state.logs = more ? state.logs.concat(batch) : batch;
    main(`
      ${head('Activity', 'A record of what Bastion did and who changed settings. Entries are kept for 30 days.')}
      ${state.logs.length ? `<ul class="list">${state.logs.map((l) => `<li><time>${fmtTime(l.created_at)}</time><div><span class="kind">${esc(l.kind)}</span><div class="msg">${esc(l.message)}</div></div></li>`).join('')}</ul>
        ${batch.length === 50 ? '<p class="more"><button class="btn" data-action="more-logs">Load older entries</button></p>' : ''}`
        : `<div class="empty"><strong>No activity yet</strong>Actions Bastion takes will be listed here.</div>`}`);
  }

  async function pageBot() {
    if (!state.me.isOwner) return main(`<div class="empty"><strong>Owners only</strong>Add your Discord user ID to OWNER_IDS in .env to open this page.</div>`);
    const b = await api('/admin/bot');
    main(`
      ${head('Bot management', `Signed in as ${b.tag || 'the bot'}. Visible only to the owners listed in OWNER_IDS.`)}
      <dl class="facts">
        <div><dt>Latency</dt><dd>${b.ping >= 0 ? `${Math.round(b.ping)} ms` : 'Connecting'}</dd></div>
        <div><dt>Uptime</dt><dd>${fmtUptime(b.uptime)}</dd></div>
        <div><dt>Servers</dt><dd>${b.guilds.length}</dd></div>
        <div><dt>Memory</dt><dd>${b.memoryMb} MB</dd></div>
      </dl>
      <section class="group">
        <h3>Status</h3>
        <div class="inline-form">
          <label class="field"><span>Presence</span><select id="p-status">${b.statuses.map((s) => `<option ${s === b.presence.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <label class="field"><span>Activity</span><select id="p-type">${b.types.map((s) => `<option ${s === b.presence.type ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <label class="field"><span>Text</span><input type="text" id="p-text" maxlength="100" value="${esc(b.presence.text)}"></label>
          <button class="btn primary" data-action="presence">Update status</button>
        </div>
      </section>
      <section class="group">
        <h3>Servers</h3>
        <ul class="servers">${b.guilds.map((g) => `
          <li>${iconHtml(g.id, g.icon, g.name)}<div class="grow"><strong>${esc(g.name)}</strong><span class="muted">${g.members.toLocaleString()} members</span></div>
          <a class="btn sm" href="#/g/${g.id}/overview">Open</a>
          <button class="btn danger sm" data-action="leave" data-id="${g.id}" data-name="${esc(g.name)}">Leave</button></li>`).join('')}</ul>
        <p><a class="btn" href="${esc(b.invite)}" target="_blank" rel="noopener">Get invite link</a></p>
      </section>`);
  }

  /* ================= routing ================= */
  async function go() {
    state.route = parseRoute();
    if (!state.me) {
      try { state.me = await api('/me'); } catch (e) { return renderLogin(); }
    }
    mountShell();
    setDirty(false);
    const r = state.route;
    try {
      if (r.view === 'servers') return pageServers();
      if (r.view === 'bot') return await pageBot();

      if (!guildInfo()?.botIn) {
        return main(`<div class="empty"><strong>Bastion isn't in this server</strong>Add it from the <a href="#/">servers list</a> first.</div>`);
      }
      if (state.guildId !== r.id) {
        const [meta, settings] = await Promise.all([api(`/guilds/${r.id}/meta`), api(`/guilds/${r.id}/settings`)]);
        Object.assign(state, { guildId: r.id, meta, settings, draft: clone(settings) });
      }
      if (r.page === 'overview') await pageOverview();
      else if (r.page === 'automod') pageProtection('automod');
      else if (r.page === 'protection') pageProtection();
      else if (r.page === 'settings') pageSettings();
      else if (r.page === 'infractions') await pageInfractions();
      else if (r.page === 'activity') await pageActivity();
      else location.hash = `#/g/${r.id}/overview`;
    } catch (e) {
      if (e.status === 401) { state.me = null; return renderLogin(); }
      main(`<div class="empty"><strong>Couldn't load this page</strong>${esc(e.message)}</div>`);
    }
  }

  /* ================= events ================= */
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!state.draft) return;
    if (t.matches('[data-bind]')) {
      let v;
      if (t.type === 'checkbox') v = t.checked;
      else if (t.type === 'number') v = Number(t.value);
      else v = t.hasAttribute('data-nullable') && !t.value ? null : t.value;
      setPath(state.draft, t.dataset.bind, v);
      if (t.dataset.bind.endsWith('.enabled')) t.closest('.module')?.classList.toggle('off', !t.checked);
      setDirty(true);
    } else if (t.matches('[data-list]')) {
      setPath(state.draft, t.dataset.list, t.value.split('\n').map((s) => s.trim()).filter(Boolean));
      setDirty(true);
    } else if (t.matches('[data-array]')) {
      const arr = getPath(state.draft, t.dataset.array);
      const i = arr.indexOf(t.value);
      if (t.checked && i < 0) arr.push(t.value);
      if (!t.checked && i >= 0) arr.splice(i, 1);
      setDirty(true);
    }
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = state.route.id;
    btn.disabled = true;
    try {
      switch (btn.dataset.action) {
        case 'save': {
          const saved = await api(`/guilds/${id}/settings`, { method: 'PUT', body: state.draft });
          state.settings = saved;
          state.draft = clone(saved);
          setDirty(false);
          toast('Changes saved');
          return;
        }
        case 'discard':
          state.draft = clone(state.settings);
          setDirty(false);
          if (state.route.page === 'settings') return pageSettings();
          return pageProtection(state.route.page === 'automod' ? 'automod' : 'security');
        case 'raid':
          await api(`/guilds/${id}/raid`, { method: 'POST', body: { minutes: Number(btn.dataset.minutes) } });
          toast(Number(btn.dataset.minutes) ? 'Raid mode started' : 'Raid mode ended');
          return pageOverview();
        case 'inf-search':
          state.infUser = $('#inf-user').value.trim();
          return pageInfractions();
        case 'del-inf':
          await api(`/guilds/${id}/infractions/${btn.dataset.id}`, { method: 'DELETE' });
          toast('Infraction removed');
          return pageInfractions();
        case 'more-logs':
          return pageActivity(true);
        case 'presence':
          await api('/admin/presence', { method: 'POST', body: { status: $('#p-status').value, type: $('#p-type').value, text: $('#p-text').value } });
          toast('Status updated');
          return;
        case 'leave':
          if (!confirm(`Remove Bastion from "${btn.dataset.name}"? You can add it back later.`)) return;
          await api(`/admin/guilds/${btn.dataset.id}/leave`, { method: 'POST' });
          state.me = await api('/me');
          toast('Left the server');
          return pageBot();
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'inf-user') $('[data-action="inf-search"]').click();
  });

  let reverting = false;
  window.addEventListener('hashchange', () => {
    if (reverting) { reverting = false; return; }
    if (state.dirty && !confirm('You have unsaved changes. Leave without saving?')) {
      reverting = true;
      history.back();
      return;
    }
    if (state.dirty) state.draft = clone(state.settings);
    go();
  });

  go();
})();
