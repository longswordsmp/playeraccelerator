# SamotWorks

A Discord platform for running a software development studio: customer tickets,
order pipeline, verified reviews, portfolio, promotion partnerships, business
analytics, moderation and security — in one bot, backed by MongoDB.

Built with Node.js 20+, discord.js v14 and Mongoose 8. Every command listed below
is implemented and wired to the database.

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Installation](#installation)
- [Discord setup](#discord-setup)
- [Environment variables](#environment-variables)
- [Database setup](#database-setup)
- [Running the server setup](#running-the-server-setup)
- [Command reference](#command-reference)
- [Configuration](#configuration)
- [Branding and artwork](#branding-and-artwork)
- [Office hours and status](#office-hours-and-status)
- [Launch promotion](#launch-promotion)
- [Architecture](#architecture)
- [Deployment](#deployment)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [Discord API limitations](#discord-api-limitations)

---

## What it does

**Customer support**
A ticket platform with ten service categories, private channels, per-ticket SLA
tracking, claim/transfer/priority workflows, internal staff notes, self-contained
HTML transcripts, and automatic archiving.

**Order pipeline**
Project briefs become orders. Orders move through quote → accepted → queued →
in progress → review → delivered → completed, with a public queue, delivery
estimates derived from real capacity, and automatic customer promotion on the
first completed order.

**Reviews**
Reviews can only be left against a completed engagement, so every one is
verified. Star rating plus a written form, credited to the staff member who
handled the work, published automatically, featurable and pinnable. Never edited.

**Portfolio & promotion partnerships**
Case studies with media, technologies and links, published with explicit customer
consent. A separate application flow for Minecraft servers seeking a stream
feature, with individual review, internal notes, and a decision the applicant
always receives.

**Business analytics**
Daily metrics rolled up into an overview dashboard, a staff leaderboard, customer
profiles, an automated daily summary and a weekly report with chart-ready series.

**Moderation & security**
30 independently configurable AutoMod modules, a link/attachment filter with
scam and malware heuristics, raid detection with automatic response, anti-nuke
with audit-log attribution and structure restoration, a full warning-escalation
ladder, lockdown, and twenty-plus logged event streams.

**Automation**
`/setup` builds the entire server. Panels refresh themselves. Tickets archive
themselves. Backups run on a schedule. Reports post themselves. Roles are granted
automatically on join and on first purchase.

---

## Requirements

| | |
|---|---|
| Node.js | 20 LTS or newer |
| MongoDB | 6.0 or newer (local, Atlas, or the bundled Docker service) |
| Discord | An application with a bot user |
| Disk | ~200 MB, plus transcript and backup storage |
| Memory | ~150–300 MB in normal operation |

---

## Installation

```bash
git clone <your-fork-url> samotworks
cd samotworks
npm install

cp .env.example .env
$EDITOR .env            # fill in BOT_TOKEN, CLIENT_ID, OWNER_ID, DATABASE_URL

npm run doctor          # verifies everything before you start
npm start
```

`npm run doctor` checks the environment, the database connection, the token, the
privileged intents and the registered command set, then prints an invite URL with
exactly the permissions this project needs. Run it first — it turns most setup
problems into a one-line explanation.

---

## Discord setup

### 1. Create the application

1. Open <https://discord.com/developers/applications> and create an application.
2. **Bot → Reset Token** → copy it into `BOT_TOKEN`.
3. **General Information → Application ID** → copy it into `CLIENT_ID`.

### 2. Enable the privileged intents

Under **Bot → Privileged Gateway Intents**, enable both:

- **Server Members Intent** — required for join automation, raid detection,
  permission checks and member logging.
- **Message Content Intent** — required for every AutoMod content filter and for
  ticket transcripts.

Without these the bot fails to log in with a `disallowed intents` error, and the
startup output says so explicitly.

### 3. Invite the bot

Use the URL printed by `npm run doctor`, or build it manually with these
permissions:

| Permission | Why it is needed |
|---|---|
| `Manage Channels` | `/setup`, ticket channels, lockdown, slowmode |
| `Manage Roles` | Role hierarchy, ticket permissions, auto-roles, anti-nuke |
| `Manage Guild` | Reading invites, guild configuration |
| `Manage Messages` | AutoMod deletions, `/purge`, pinning panels |
| `Manage Nicknames` | `/nickname` |
| `Manage Webhooks` | Webhook monitoring for anti-nuke |
| `View Audit Log` | **Anti-nuke attribution.** Without it, destructive actions cannot be traced to a user |
| `Kick Members` / `Ban Members` | Moderation and raid response |
| `Moderate Members` | Timeouts |
| `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History` | Everything the bot says, and every transcript it builds |
| `Mention Everyone` | Announcements, raid alerts |
| `Add Reactions`, `Use External Emojis` | Panel polish |
| `Connect`, `Move Members` | Voice channel management |

**Position the bot's role near the top of Server Settings → Roles.** Discord never
lets a bot act on a role at or above its own, so a low role position silently
disables role deletion during `/setup`, anti-nuke enforcement against admins, and
moderation of senior staff. `/security permissions` audits this and reports
exactly what is blocked.

---

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `BOT_TOKEN` | yes | — | Bot token |
| `CLIENT_ID` | yes | — | Application ID |
| `OWNER_ID` | yes | — | Comma-separated owner user IDs, granted full access |
| `GUILD_ID` | no | — | Register commands to one guild (instant). Empty registers globally (up to 1 hour) |
| `DATABASE_URL` | yes | `mongodb://127.0.0.1:27017/samotworks` | MongoDB connection string |
| `DATABASE_NAME` | no | from URI | Override the database name |
| `NODE_ENV` | no | `production` | `production` skips autoIndex and builds indexes once at boot |
| `LOG_LEVEL` | no | `info` | `error` \| `warn` \| `info` \| `debug` \| `trace` |
| `LOG_TO_FILE` | no | `true` | Write newline-delimited JSON logs to `logs/` |
| `AUTO_DEPLOY_COMMANDS` | no | `true` | Register slash commands on startup |
| `TRANSCRIPT_DIR` | no | `transcripts` | Where HTML transcripts are stored |
| `BACKUP_DIR` | no | `backups` | Where structure snapshots are stored |
| `LOG_DIR` | no | `logs` | Where log files are written |
| `TRANSCRIPT_BASE_URL` | no | — | If you serve `transcripts/` over HTTP, transcripts get a clickable link |
| `IMAGE_MODERATION_API_URL` | no | — | Optional NSFW classifier. POSTs `{url}`, expects `{nsfw, score}` |
| `URL_REPUTATION_API_URL` | no | — | Optional URL reputation service. POSTs `{url}`, expects `{malicious, category}` |

Secrets never reach a log sink: the logger redacts the token, the database URL and
any key whose name looks like a credential, in every destination.

---

## Database setup

Nothing to create by hand. Collections and indexes are built on first connect
(and verified explicitly at boot in production).

**Local MongoDB**

```bash
docker run -d --name mongo -p 27017:27017 -v mongo-data:/data/db mongo:7
# DATABASE_URL=mongodb://127.0.0.1:27017/samotworks
```

**MongoDB Atlas**

1. Create a free M0 cluster.
2. Add a database user and allow your server's IP.
3. Copy the connection string into `DATABASE_URL`, appending the database name:
   `mongodb+srv://user:pass@cluster.mongodb.net/samotworks`

**Collections**

`configurations`, `users`, `tickets`, `orders`, `reviews`, `moderations`, `logs`,
`portfolios`, `promotions`, `staffstats`, `guildstats`, `backups`, `counters`.

Logs carry a TTL index — routine entries expire after 90 days, errors after a
year — so the collection never grows without bound.

---

## Running the server setup

> **`/setup` deletes channels and roles.** Run it on a fresh server, or take a
> backup first. It automatically snapshots the structure before touching
> anything, but a snapshot cannot restore messages.

```
/setup                                  full rebuild, with a backup first
/setup wipe:false                       add the blueprint alongside what exists
/setup delete-roles:false               keep existing roles
```

Only the **server owner** can run it. You get a confirmation screen listing
exactly what will be deleted and created, live progress while it runs, and a
final report that names every Discord limitation encountered.

It creates:

- 7 categories, 30 channels, 3 voice channels
- 10 roles with a complete permission hierarchy
- 13 public panels (rules, FAQ, pricing, portfolio, reviews, ToS, ticket
  launcher, live status, office hours, statistics, queue, staff performance)
- 7 logging destinations, wired automatically

Afterwards:

```
/config business timezone:Europe/Amsterdam response-target:240
/config brand name:"Your Studio" logo:https://…
/config hours day:1 open:10:00 close:20:00
/status set:online
```

Then assign your team the staff roles that were created.

---

## Command reference

### Administration

| Command | Access | Purpose |
|---|---|---|
| `/setup` | Server owner | Build the entire server from the blueprint |
| `/config` | Admin | 25 subcommands covering every runtime setting; `/config apply` does the lot in one |
| `/panel` | Admin | Publish, refresh, relocate or republish any public panel |
| `/members` | Admin | Bulk-grant or bulk-remove a role across everyone already in the server |
| `/backup` | Admin | Create, list, restore and delete structure snapshots |

### Tickets

| Command | Access | Purpose |
|---|---|---|
| `/ticket` | Everyone | Open, close, claim, transfer, rename, note, list, inspect |
| `/claim`, `/unclaim` | Support | Take or release the ticket in this channel |
| `/close`, `/reopen` | Customer / Support | Close or reopen |
| `/priority` | Support | Low, normal, high, urgent |
| `/add`, `/remove` | Support | Manage ticket access |
| `/rename` | Support | Rename the channel |
| `/transcript` | Customer / Support | Generate or fetch the HTML transcript |
| `/delete` | Manager | Delete the channel; the record survives |

### Business

| Command | Access | Purpose |
|---|---|---|
| `/order` | Support | View, list, quote, assign, progress, complete, cancel, reorder |
| `/queue` | Everyone | The public pipeline and your own position |
| `/customer` | Own profile / Support | Orders, tickets, reviews, spend, standing |
| `/statistics` | Everyone (staff sections gated) | Overview, tickets, reviews, daily, weekly, system |
| `/leaderboard` | Support | Team rankings across six metrics |
| `/status`, `/hours` | Everyone (staff can set) | Live availability and office hours |
| `/review` | Support | Approve, reject, feature, hide, delete, list outstanding |
| `/reviews`, `/reviewstats`, `/featuredreview` | Everyone | Read verified reviews |
| `/portfolio` | Everyone (manage: staff) | Browse, add, edit, feature, remove case studies |
| `/promotion` | Support | Review partnership applications |
| `/announcement` | Manager | Seven branded announcement types |
| `/launch` | Admin | Run the opening promotion: free commissions for a fixed window |
| `/invites` | Everyone | Referral progress, personal invite link, leaderboard |

### Moderation

`/warn` · `/unwarn` · `/warnings` · `/timeout` · `/untimeout` · `/mute` ·
`/unmute` · `/kick` · `/ban` · `/unban` · `/softban` · `/history` · `/purge` ·
`/slowmode` · `/lock` · `/unlock` · `/nickname` · `/role` · `/note` · `/report`

Every action is recorded as a numbered case, notifies the target by DM when
possible, logs to the moderation channel, updates statistics, and feeds the
escalation ladder.

### Security

| Command | Access | Purpose |
|---|---|---|
| `/security status` | Manager | Live state of every protection system |
| `/security modules` | Manager | All AutoMod modules and their configuration |
| `/security toggle` | Manager | Turn a system on or off |
| `/security raid` | Manager | Manually engage or lift raid mode |
| `/security permissions` | Manager | Audit what Discord is preventing |
| `/security incidents` | Manager | Recent security events |
| `/lockdown` | Admin | Lock, unlock, or emergency mode |

### Utility

`/help` · `/ping` · `/userinfo` · `/serverinfo`

---

## Configuration

Everything is editable at runtime; you should never need to modify source to
change behaviour.

```
/config view                              overview
/config view section:automod              one section in full
/config tickets max-open:5 transcripts:true
/config automod module:spam action:timeout threshold:6 duration:15
/config words action:block word:example
/config links list-action:blacklist domain:bad.example
/config antiraid join-threshold:10 join-window:15 auto-lockdown:true
/config antinuke punishment:strip attempt-restore:true
/config channel log:security destination:#security-logs
/config apply section:automod            back to shipped defaults
/config apply                            every section to shipped defaults, wiring preserved
```

Files under `src/config/` hold the shipped defaults and are the right place for
studio-wide changes you want in version control:

| File | Contents |
|---|---|
| `branding.js` | Colours, glyphs, brand identity |
| `server.js` | The `/setup` blueprint: roles, categories, channels, ticket types, priorities, statuses |
| `content.js` | Rules, FAQ, ToS, pricing, portfolio, welcome, programme copy |
| `defaults.js` | Every default guild setting |
| `permissions.js` | Access levels and required bot permissions |

Adding a new option to `defaults.js` rolls it out to existing guilds
automatically — configuration documents are deep-merged over the defaults on
every read, so there is no migration to write.

---

## Branding and artwork

The visual identity lives in `brand/` and is generated, not hand-drawn in an
editor, so it can be regenerated at any size and kept consistent:

| File | What it is |
| --- | --- |
| `brand/logo.svg` / `.png` | The `< / >` mark, 512² |
| `brand/bot-avatar.png` | The same mark at 1024², for the application avatar |
| `brand/banner.svg` / `.png` | Wordmark banner, 1200×400 |
| `brand/panels/*.png` | One 1200×300 header per public panel |

Regenerate after changing wording, colours or glyphs:

```bash
npm install --no-save playwright-core
node scripts/build-panel-art.js     # writes brand/panels/*.svg from the template
node scripts/render-brand.js        # rasterises every SVG to PNG
```

Panel headers are uploaded as message attachments rather than hot-linked.
Discord's CDN links for attachments now carry an expiry signature, so a URL
captured once and stored in the database would quietly break later. Turn the
artwork off with `/config theme` if you would rather keep panels text-only.

The studio name, server name, tagline, slogan and description are all set in
`src/config/branding.js` and overridable per guild with `/config brand`. `/setup`
applies the server name to the guild itself, and the description too when the
guild is Community-enabled.

---

## Office hours and status

Hours are configured per weekday in the studio's own timezone, given as an IANA
name so daylight saving is handled without a date library. The shipped default
is 12 PM – 9 PM Eastern, seven days a week.

The developer status has three modes:

| Mode | Behaviour |
| --- | --- |
| Automatic (default) | The hours *are* the status: open shows online, closed shows away |
| Pinned | `/status set:Busy` and friends hold until changed, but never advertise "online" out of hours |
| Manual | `status.autoFromHours: false` — the stored value is used verbatim |

`/status set:Auto` hands a pinned status back to the schedule. The panel footer
always says which mode is in force, because a pinned status nobody remembers
pinning is the usual reason a status board goes stale.

### Configuring everything at once

Rather than working through two dozen `/config` subcommands by hand, one command
applies the whole studio profile:

```
/config apply
/config apply timezone:Europe/London open:10:00 close:18:00
/config apply days:1,2,3,4,5 preview:True     show the plan, save nothing
/config apply schedule-only:True              hours and status mode only
/config apply section:automod                 reset one section
```

The same thing from the terminal, for a server the bot is not currently running
in:

```bash
npm run configure
npm run configure -- --dry-run
npm run configure -- --timezone=Europe/London --open=10:00 --close=18:00
npm run configure -- --days=1,2,3,4,5 --schedule-only
```

Both share one implementation (`configService.applyProfile`) so they cannot
drift apart.

This exists because editing `defaults.js` is not enough on its own: configuration
documents are deep-merged with the *stored* values winning, so anything a guild
has already written — a timezone saved as `UTC` by the first `/setup`, a brand
name from before a rename — keeps winning forever. Defaults fix new installs;
this fixes existing ones. It is idempotent and reports every section it changed.

**What it never touches:** `roles`, `channels`, `categories`, `logChannels`,
`panels` and `setup` are the wiring `/setup` produced — resetting them would
orphan the server, because the bot would no longer know which channel is which.
A running `launch` promotion is preserved for the same reason: closing a publicly
announced offer as a side effect of a config tidy-up would be worse than leaving
it slightly stale. A regression test pins this.

Individual settings are still available one at a time — `/config hours
day:Monday open:12:00 close:21:00`, `/config business
timezone:America/New_York`, and so on.

---

## Launch promotion

`/launch start` opens a time-boxed window in which the referral requirement on
free portfolio commissions is waived, and publishes the announcement in one
action. This is deliberate: an announcement that says "just open a ticket" while
the gate still demands three referrals turns the first applicant away in public.

```
/launch start days:7 service:"Minecraft Plugin" slots:0 everyone:True
/launch status          # time and slots remaining
/launch end             # close early and rewrite the announcement
```

The window closes itself when it expires — the scheduler edits the original
announcement to say the offer has ended, and the free-service panel reverts to
the referral instructions on its next refresh.

---

## Architecture

```
src/
├── index.js                 boot sequence + graceful shutdown
├── core/Client.js           extended client, caches, metrics, timers
├── config/                  environment, branding, blueprint, copy, defaults
├── database/
│   ├── connection.js        connect with backoff, reconnect, index sync
│   └── models/              13 Mongoose schemas
├── handlers/                command, event and component loading + routing
├── commands/                admin · tickets · business · moderation · security · utility
├── events/                  client · guild · member · message · voice · interaction
├── components/              buttons · selectMenus · modals · forms
├── services/                the business logic
├── security/                filters · autoMod · linkProtection · antiRaid · antiNuke
└── utils/                   embeds · components · assets · formatters · validators ·
                             permissions · logger · errors · rateLimiter · discord

brand/                       logo, banner and per-panel header artwork
scripts/                     deploy · doctor · configure · build-panel-art · render-brand
```

Principles the codebase actually follows:

- **Services own workflows.** Commands and buttons parse input and render output;
  the service does the work. `/close` and the Close button run the same code
  path, so they cannot drift.
- **Authorise every interaction.** A custom ID is client-side data. Every button
  press re-checks permission from scratch, exactly as strictly as a slash
  command.
- **Database first, Discord second.** A ticket is persisted before its channel is
  created, and rolled back if creation fails. A record with no channel is
  recoverable; a channel with no record is not.
- **Fail visibly, never fatally.** Every handler is wrapped. Users see a safe
  message plus a correlation id; the stack goes to the logs and the bot-log
  channel only.
- **Bounded memory.** Every counter, cooldown and cache is swept on a shared
  timer. Caches are size-capped. Log queues have a hard ceiling.

---

## Deployment

### Docker (recommended)

```bash
cp .env.example .env    # BOT_TOKEN, CLIENT_ID, OWNER_ID
docker compose up -d
docker compose logs -f bot
```

Brings up MongoDB and the bot on a private network, with named volumes for
transcripts, backups, logs and database data. `DATABASE_URL` is overridden to
point at the compose service.

### VPS with PM2

```bash
npm install -g pm2
npm install --omit=dev
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

Run **one instance**. A Discord bot is a stateful gateway client; two processes
on the same token double-handle every event.

### systemd

```ini
[Unit]
Description=SamotWorks
After=network-online.target mongod.service

[Service]
Type=simple
User=studio
WorkingDirectory=/opt/samotworks
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
KillSignal=SIGTERM
TimeoutStopSec=25

[Install]
WantedBy=multi-user.target
```

`TimeoutStopSec` must exceed the bot's 15-second shutdown drain, or in-flight
writes are cut off.

### Scaling

One process comfortably serves a single busy studio server. Discord requires
sharding past 2,500 guilds; at that point run `ShardingManager` in front of
`src/index.js`. Nothing in the codebase assumes a single shard — all durable
state lives in MongoDB, and the per-process caches are safe to duplicate.

---

## Testing

```bash
npm test      # 38 unit tests over the pure logic layers
npm run lint  # correctness-focused ESLint
npm run doctor
```

The automated suite covers formatters, validators (including the ReDoS guard and
NoSQL-injection defences), the custom-ID protocol, every content filter, the rate
limiters, office-hours maths across DST and invalid timezones, transcript HTML
escaping, configuration deep-merge, and Discord's component and embed limits.

Anything that needs a live gateway is verified by hand. The checklist:

**Setup** — `/setup` on a throwaway server; confirm categories, channels, roles,
permissions and all 13 panels; confirm the warning list names anything Discord
refused.

**Tickets** — open one of each type; submit the form; confirm the order appears;
claim, transfer, set priority, add and remove a member, add a note; close it;
confirm the transcript attaches, the archive move happens, and the review request
arrives in both the channel and a DM.

**Orders** — send a quote; accept it as the customer; confirm the queue position
and estimates; complete it; confirm the customer role is granted, the
completed-orders post appears, and statistics move.

**Reviews** — submit a review; confirm it publishes; feature it; confirm it pins;
hide it; confirm it disappears.

**Moderation** — warn a test account to the escalation threshold and confirm the
automatic timeout; ban and unban; purge with filters; lock and unlock.

**Security** — post a blocked link and confirm deletion plus a security log entry;
trip a spam threshold; run `/security permissions` and confirm it reports
role-position problems accurately.

**Persistence** — restart the process, then confirm tickets, orders, reviews,
warnings, statistics and configuration are all intact.

---

## Troubleshooting

**`Used disallowed intents`**
Message Content and Server Members are not enabled in the Developer Portal. See
[Discord setup](#discord-setup).

**Commands do not appear**
`GUILD_ID` unset means global registration, which takes up to an hour. Set it for
instant registration, then `npm run deploy`. If they still do not appear, the bot
was invited without the `applications.commands` scope — re-invite it.

**`Missing Permissions` (50013)**
Run `/security permissions`. It names the missing permissions and reports how many
roles sit above the bot's own, which is the usual cause.

**`/setup` skipped roles**
Expected. Discord does not allow a bot to delete `@everyone`, managed integration
roles, or anything at or above its own position. The setup report lists each one.
The engine also deliberately preserves any role that grants Administrator to real
members, so a rebuild cannot lock your team out.

**Panels are not refreshing**
Panels only refresh once published. Run `/panel list` to see which are live and
`/panel publish` for any that are missing.

**Transcripts are empty**
Message Content intent is off, or the bot lacks Read Message History in the ticket
category.

**Database connection failures**
The bot retries five times with exponential backoff and explains each failure. For
Atlas, the usual cause is an IP allow-list entry that does not include the server.

**High memory**
Normal is 150–300 MB. Sustained growth beyond that is worth investigating; every
cache in the codebase is size-capped and swept. `/statistics system` shows live
heap usage, cache sizes and error counts.

---

## Security notes

- **Secrets never reach a log sink.** The token, the database URL and any
  credential-shaped key are redacted at the logger, in every destination.
- **Every input is validated and sanitised.** Control characters, zero-width
  joiners and bidirectional overrides are stripped; lengths are capped; and
  `$`-prefixed keys and dotted paths are removed before anything is persisted.
- **Operator injection is prevented at the boundary, not globally.** Discord
  coerces slash-command options to primitives and the custom-ID protocol decodes
  to strings, so a query value is never an object. Mongoose's global
  `sanitizeFilter` is deliberately **off**: it rewrites every `$in`, `$gte` and
  `$ne` this codebase writes into `{ $eq: <object> }` and throws on `$expr`,
  which would silently turn working queries into empty results. The reasoning is
  documented in `src/database/connection.js` and pinned by a regression test that
  demonstrates exactly what the flag would break.
- **User-supplied regular expressions are screened for catastrophic backtracking**
  before compiling, and rejected if they match a known exponential shape.
- **Transcripts escape everything.** A transcript contains whatever a customer
  typed; HTML escaping happens before markdown rendering, so no input can become
  live markup. Transcript reads are path-checked against the transcript directory.
- **Buttons are authorised, not trusted.** Every component interaction re-resolves
  the actor's permissions server-side.
- **Hierarchy is checked before acting**, so the bot never attempts an action
  Discord will reject — and explains why instead.
- **Errors never leak internals.** Users get a safe message and a correlation id;
  the stack goes to the logs.
- **Destructive commands confirm first**, and `/setup` and `/backup restore`
  snapshot before they touch anything.
- **The interaction throttle** is a token bucket in front of every handler, so one
  abusive client cannot exhaust the bot's rate-limit budget.

Reporting a vulnerability: open a private ticket with the studio rather than a
public issue.

---

## Discord API limitations

These are platform constraints, not gaps in the implementation. The bot detects
each one and says so plainly rather than failing silently.

| Limitation | Effect | How this project handles it |
|---|---|---|
| Roles at or above the bot cannot be edited, deleted or reordered | `/setup` cannot remove them; moderation cannot touch their members | Detected, skipped, and reported by name in the setup summary and `/security permissions` |
| Managed roles (bots, integrations, boosters) can never be deleted | They survive a rebuild | Skipped silently — this is correct behaviour |
| The guild owner cannot be moderated by anyone | No timeout, kick or ban | Blocked before the API call, with a clear message |
| Message history cannot be written | A restored or recreated channel is empty | Stated in every restore confirmation, and posted into recreated channels |
| Role membership is not in the audit log | A restored role has no members | Reported explicitly when anti-nuke recreates a role |
| Audit logs are eventually consistent | Attribution can lag a second or two | Lookups retry briefly before giving up |
| Audit logs require View Audit Log | Without it, destructive actions cannot be attributed | Anti-nuke logs a warning explaining that it is operating blind |
| Timeouts are capped at 28 days | Longer punishments need a ban | `/timeout` rejects longer durations and points at `/ban` |
| Bulk delete only works on messages under 14 days old | `/purge` cannot clear older messages | Filtered out, and the skipped count is reported |
| A category holds at most 50 channels | Ticket creation would fail | Checked before creating; the archive auto-purges its oldest ticket |
| A guild holds at most 500 channels and 250 roles | `/setup` could fail midway | Checked in pre-flight, before anything is deleted |
| Slowmode is capped at 6 hours | — | Validated with an explicit message |
| Bots cannot read DMs between users | True mass-DM detection is impossible | The detectable public shape — the same message across many channels — is what the module actually looks for, and it says so |
| Community system channels cannot be deleted | `/setup` cannot remove them | Detected and reported |
| Ephemeral replies cannot change ephemerality after deferring | — | The reply helper handles all four interaction states correctly |
| Custom IDs are capped at 100 characters | Long payloads would fail at render time | The encoder validates length up front |

---

## Licence

MIT.
