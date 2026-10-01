const { ActivityType } = require('discord.js');
const { getKv, setKv } = require('../db');

const TYPES = {
  Playing: ActivityType.Playing,
  Watching: ActivityType.Watching,
  Listening: ActivityType.Listening,
  Competing: ActivityType.Competing,
};
const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
const DEFAULT = { status: 'online', type: 'Watching', text: 'over your server' };

function load() {
  try { return { ...DEFAULT, ...JSON.parse(getKv('presence') || '{}') }; } catch { return { ...DEFAULT }; }
}

function apply(client, p = load()) {
  client.user.setPresence({
    status: p.status,
    activities: p.text ? [{ name: p.text, type: TYPES[p.type] }] : [],
  });
}

function save(client, input) {
  const p = {
    status: STATUSES.includes(input?.status) ? input.status : DEFAULT.status,
    type: TYPES[input?.type] !== undefined ? input.type : DEFAULT.type,
    text: String(input?.text ?? '').slice(0, 100),
  };
  setKv('presence', JSON.stringify(p));
  apply(client, p);
  return p;
}

module.exports = { load, apply, save, TYPES, STATUSES };
