# Bastion: Discord security bot + dashboard

## What it does

**Protection (all configurable per server from the dashboard)**
- Auto-mod page: Spam (floods, repeated messages, emoji spam, caps), Bad links (invites, shorteners, domains) and Bad words (with leetspeak catching), each with its own on/off switch, punishment and ignored channels
- Mention spam limits
- Discord invite and domain blocking (blocklist, or allowlist-only mode)
- Blocked word filter (whole-word, case-insensitive)
- Unverified commands: anyone who uses a command you list gets the punishment you set (owner and exceptions are safe)
- Bot checks: when a bot is added, posts who added it, its permissions, and Verified/Unverified status (optional auto-kick for unverified). A bot that answers an unverified command is kicked and the member who added it is punished
- Raid defence: join-rate detection, automatic raid mode, minimum account age
- Anti-nuke: stops anyone mass-deleting channels/roles or mass-banning (uses the audit log)
- Escalation: repeat offenders are timed out, then banned automatically
- Trusted roles/users that are skipped

**Slash commands:** `/warn`, `/infractions`, `/raidmode`, `/purge`

**Dashboard**
- Sign in with Discord; you only see servers where you have Manage Server
- Overview with a 7-day chart, raid-mode switch, and missing-permission warnings
- Protection, settings, infractions (search/remove) and activity log
- Bot management (owners only): latency, uptime, set bot status, list/leave servers

## Setup

1. Create an application at https://discord.com/developers/applications
2. **Bot** tab: reset and copy the token. Enable **Server Members Intent** and **Message Content Intent**.
3. **OAuth2** tab: copy the Client ID and Client Secret. Under Redirects add `http://localhost:3000/auth/callback` (use your real URL in production).
4. Copy `.env.example` to `.env` and fill it in. Put your own Discord user ID in `OWNER_IDS` to unlock Bot management.
5. Install and run (Node 18.17 or newer):
   ```
   npm install
   npm start
   ```
6. Open http://localhost:3000, sign in, and click **Add Bastion** next to your server.
7. **Important:** in Server Settings > Roles, drag the **Bastion** role *above* the roles it should be able to moderate. Discord blocks kicks/timeouts/bans on anyone ranked above the bot.

## Production notes
- Serve the dashboard behind HTTPS (set `BASE_URL` to the https URL; secure cookies turn on automatically).
- Sessions use the in-memory store, so logins reset on restart. Swap in a persistent store for larger deployments.
- Data lives in `data/bastion.db` (SQLite). Back it up.
- Raid-mode state is held in memory and resets on restart.
