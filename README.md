# Silence

A gaming site built from plain HTML, CSS and JavaScript, served by a Cloudflare Worker.

The Worker does two jobs: it serves the static site, and it runs a small API for forms, the AI page, the announcement banner and the global chat. Forms and reports live in Cloudflare KV, the chat (messages, rooms, bans, mutes, mod log and files) lives in Cloudflare D1, and multiplayer games inside chat rooms run in a Durable Object.

---

## Table of contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Run locally](#run-locally)
- [How pages load](#how-pages-load)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [API](#api)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Games**: a searchable library served from a Cloudflare R2 public bucket, with favorites, recent games and a built-in player.
- **Forms**: game requests, bug reports, feedback and applications, stored in KV and managed from the admin page.
- **AI**: a streaming chat page that talks to Gemini through the Worker, so the API key never reaches the browser.
- **Global chat**: usernames, a global room plus user-made rooms (public, private or admin-only), replies, edits with history, file sharing, reports, popups for new messages, and staff moderation (admins and mods).
- **Multiplayer games in chat rooms**: a `GameRoom` Durable Object that rooms connect to over a WebSocket.
- **Announcements**: admins post a site-wide banner from the admin page.
- **Human checks**: Cloudflare Turnstile on forms, admin sign-in, chat sign-in, room creation and the AI page.
- **Privacy tools**: disguise pages that show until the site is unlocked, a panic key, tab title and icon changes, opening in `about:blank` (manually or automatically), lock on tab leave and idle auto-lock.
- **First-run setup**: a short wizard for theme, tab look, panic settings and hiding options. It can be run again from settings.
- **Soundboard**, **settings**, **about** and **admin** pages.

---

## Prerequisites

- Git
- Node.js 18 or newer (used through `npx`, so nothing is installed globally)
- A Cloudflare account (the free plan works for development)

---

## Setup

```bash
git clone https://github.com/jumpingpantsMG/Silence.git
cd Silence
npx wrangler login
```

### 1. Create the KV namespace (forms, reports, announcement)

```bash
npx wrangler kv namespace create FORMS
```

Copy the `id` it prints into `wrangler.toml`.

### 2. Create the D1 database (chat)

```bash
npx wrangler d1 create silence-chat
```

It prints a `database_id`. Add the binding to `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "silence-chat"
database_id = "paste-the-id-here"
```

You do not need to create any tables. The Worker creates them the first time chat is used.

### 3. Add the Durable Object (multiplayer games)

The class lives in `game/room.js` and is exported from `worker.js`. Bind it and add a migration in `wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "GAMES"
class_name = "GameRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["GameRoom"]
```

Use `new_sqlite_classes`: the free plan only supports SQLite-backed Durable Objects. Keep the tag and migration that are already in your `wrangler.toml` if you have deployed before.

### 4. Check `wrangler.toml`

`worker.js` expects these bindings:

| Binding  | Type           | Purpose                                         |
| -------- | -------------- | ----------------------------------------------- |
| `ASSETS` | static assets  | the site itself                                 |
| `FORMS`  | KV namespace   | form submissions, chat reports, the announcement |
| `DB`     | D1 database    | chat messages, rooms, bans, mutes, mod log, files |
| `GAMES`  | Durable Object | multiplayer games in chat rooms                 |

### 5. Add secrets

```bash
npx wrangler secret put ADMIN_TOKEN        # admin page login, also signs chat sessions
npx wrangler secret put GEMINI_API_KEY     # the AI page
npx wrangler secret put TURNSTILE_SECRET   # human checks, see below
npx wrangler secret put CHAT_ADMINS        # optional: extra chat admins, see below
npx wrangler secret put CHAT_MODS          # optional: chat moderators, see below
npx wrangler secret put CHAT_SECRET        # optional: separate key for chat sessions
```

Secrets cannot be viewed again after you set them. If one leaks, set a new value.

For local development, put the same values in a `.dev.vars` file in the repo root. Keep it out of git.

```ini
ADMIN_TOKEN=pick-something-long
GEMINI_API_KEY=your-key
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
CHAT_ADMINS=alice:a-long-password
CHAT_MODS=bob:another-password
```

`1x0000000000000000000000000000000AA` is Cloudflare's test secret. It always passes, so it is safe for local work.

### 6. Set up Turnstile (human checks)

1. In the Cloudflare dashboard, go to **Turnstile → Add widget**. Add your site's hostname (and `localhost` for local work). Use the **Managed** mode.
2. Copy the **site key** into the `SITEKEY` constant in `Pages/forms.html`, `Pages/admin.html`, `Pages/chat.html` and `Pages/ai.html`. The site key is public.
3. Save the **secret key** with `npx wrangler secret put TURNSTILE_SECRET`.

For testing, Cloudflare's dummy site key `1x00000000000000000000AA` always passes, and `2x00000000000000000000AB` always fails.

If `TURNSTILE_SECRET` is not set, the Worker skips the checks so nothing breaks while you set up. Set it before you go live.

---

## Run locally

Use Wrangler, not a plain file server. A plain server (`python3 -m http.server`, `live-server`) only serves the static files, so forms, the AI page and the chat will not work.

```bash
npx wrangler dev
```

Then open the address it prints (usually `http://localhost:8787`). Local KV, D1 and Durable Objects are simulated on your machine and start empty.

On `localhost`, or with `?local` in the URL, the shell loads pages from your local files first instead of GitHub (see below).

---

## How pages load

`index.html` is a small shell. It does not contain the pages; it fetches each file in `Pages/` and shows it in its own iframe, keeping every page alive so switching is instant.

- Pages come from **jsDelivr**, which mirrors this GitHub repo: `https://cdn.jsdelivr.net/gh/<repo>@<ref>/Pages/<page>.html`.
- With **Always fresh** on (the default, in settings), the shell asks GitHub for the newest commit on `main` and loads from that exact commit, so jsDelivr never serves a stale copy.
- If jsDelivr or GitHub can't be reached, the shell falls back to the site's own copy of the file.
- Anything in a page that points to `../something.ext` (stylesheets, images, scripts) is rewritten to load from the same place as the page.

Because of this, **page changes go live when you push to `main`**, while **Worker changes need `npx wrangler deploy`**. The repo has a GitHub Action that purges jsDelivr's cache after every push.

---

## Configuration

### Chat staff

The chat sign-in asks staff usernames for a password. Everyone else just picks a username.

- `ADMIN_TOKEN` is always an admin account with the username `admin`, using the token as its password.
- `CHAT_ADMINS` adds more admins. The format is `name:password`, separated by commas.
- `CHAT_MODS` adds moderators, in the same format.

  ```text
  alice:first-password,bob:second-password
  ```

  Passwords can contain spaces but not commas, and they are matched exactly (case-sensitive). If a name is in both lists, the admin account wins.

| Can do                                              | Admin | Mod |
| --------------------------------------------------- | :---: | :-: |
| Delete messages from regular users                  |  yes  | yes |
| Mute and unmute users (mods: up to 24 hours)        |  yes  | yes |
| See mutes, reports and the mod log                  |  yes  | yes |
| Ban users (username, IP or device)                  |  yes  |  no |
| Delete a mod's messages                             |  yes  |  no |
| Wipe or delete rooms, create admin-only rooms       |  yes  |  no |
| See and join every room                             |  yes  |  no |

Admins can't be banned or muted and skip the word and link filters. Mods are held to the same filters as everyone else. Messages from staff carry a flag the chat page uses for the `admin` or `mod` badge. Every staff action is written to the mod log, which is kept for 30 days.

### Chat limits

| Setting                 | Value                                        |
| ----------------------- | -------------------------------------------- |
| Messages kept           | newest 100 per room                          |
| Message length          | 300 characters                               |
| File size               | 2 MB                                         |
| Files kept              | newest 25 across the whole site              |
| Rooms                   | up to 50                                     |
| Session length          | 24 hours (chat pauses after 10 idle minutes) |
| Message and file expiry | 7 days                                       |
| Room expiry             | 28 days without activity                     |
| Mod log                 | 30 days                                      |

The word filter is the `BLOCKED_WORDS` list near the top of the chat section in `worker.js`. Add your own words there. Links are blocked for everyone except admins. Blocked messages are never posted; they are sent to the admin page as reports.

### Human checks (Turnstile)

| Where                         | What is checked                                                        |
| ----------------------------- | ---------------------------------------------------------------------- |
| Forms page                    | every submission                                                       |
| Admin sign-in                 | only a wrong or missing token has to bring a solved check (`x-turnstile` header), so guesses can't be scripted. The right token needs no check |
| Chat sign-in                  | everyone, staff included                                               |
| Chat room creation            | everyone except staff                                                  |
| AI page                       | one check unlocks it for 30 minutes (`POST /api/chat/verify` returns a signed pass, sent as `x-ai-pass`) |

Tokens are single use, so each page resets its widget after every attempt.

### Announcements

Admins set a banner from the admin page. It is stored in KV under `announce:current`, shown on every page by `js/Announce.js`, and can be dismissed by visitors. It can have an expiry (up to 30 days) or stay until removed.

### Disguise pages, panic and settings

While the site is locked, every route shows a decoy page instead of the real site. There are two: a typing test (`Pages/disguise.html`) and a flashcard site (`Pages/disguise2.html`). Which one shows is decided at the top of `index.html` (the `disguiseName` constant): by the hostnames and URL parameters listed there. Typing the site name on either page unlocks the real site.

Everything else is on the settings page and is stored in the visitor's browser only:

- **Appearance**: accent color, card size, theme, page background, reduced motion.
- **Browser tab**: tab title and icon, including a custom image.
- **Panic**: the key, where it sends the tab, and an optional on-screen button.
- **Privacy**: lock now (`Alt + Shift + L`), lock when the tab is hidden, idle auto-lock, open in `about:blank`, and open in `about:blank` automatically on the first click or key press (takes effect the next time the site opens).
- **Updates**: Always fresh, reload from source, restore defaults.

First-time visitors get the setup wizard (`js/Setup.js`), which covers the main ones. It can be run again from settings.

### Adding a game

Games are listed in `Pages/index.html`, in the `<script type="text/plain" id="data">` block, one per line:

```text
Name|folder|cover|f
```

`folder` is the game's folder in the R2 bucket, `cover` is an image file inside it, and a trailing `f` marks a Flash game. Lines after `#non-semag` come from the other bucket folder. Each game is served from `{R2 base}/{bucket}/{folder}/index.html`.

### Free-plan limits

The free plan is plenty for a small chat.

| Service         | Free per day | What uses it                                            |
| --------------- | ------------ | ------------------------------------------------------- |
| D1 rows written | 100,000      | a message is about 3 rows, a 2 MB file about 7          |
| D1 rows read    | 5,000,000    | chat polls and loading messages                         |
| D1 storage      | 5 GB         | messages and the newest 25 files                        |
| KV writes       | 1,000        | forms, chat reports, announcements, form rate limits    |
| KV lists        | 1,000        | the admin submissions list, mod reports               |
| Worker requests | 100,000      | every API call, including each chat poll                |

Chat polling is cheap on purpose: the Worker remembers each room's recent messages for a few seconds and only asks D1 when something changed. The number to watch is Worker requests, because every open chat tab makes one request every few seconds. Check usage in the Cloudflare dashboard under Workers & Pages. Durable Object usage has its own limits; see Cloudflare's current pricing page.

---

## Project structure

```text
Silence/
├── index.html        the shell: loads pages, settings, lock, panic, disguise picker
├── Pages/            one HTML file per page: index (games), forms, soundboard, settings,
│                     admin, ai, chat, about, disguise, disguise2
├── js/               shared scripts: Navbar.js, Setup.js, Announce.js
├── game/room.js      the GameRoom Durable Object (multiplayer games in chat)
├── style.css         shared styles used by every page
├── worker.js         the Cloudflare Worker (static site + API + chat storage)
├── wrangler.toml     Cloudflare configuration
├── robots.txt, sitemap.xml
├── LICENSE, NOTICE
└── README.md
```

The folder is `Pages/` with a capital P. jsDelivr paths are case-sensitive. Pages share `style.css` and the navbar instead of repeating CSS. If a file here does not match your checkout, trust the checkout and update this list.

---

## API

All routes are served by `worker.js`. Anything that is not under `/api/` falls through to the static site.

| Route                                  | What it does                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `POST /api/forms`                      | submit a request, bug report, feedback or application (1 per minute per IP, needs a human check) |
| `/api/admin/submissions[/:id]`         | list, read, mark done and delete submissions. Needs `Authorization: Bearer <ADMIN_TOKEN>` |
| `GET /api/announcement`                | the current banner (public, cached for 30 seconds)                           |
| `/api/admin/announcement`              | read, set (`PUT`) and remove (`DELETE`) the banner. Admin token              |
| `POST /api/chat`                       | AI proxy. Streams the Gemini reply back as server-sent events. Needs an `x-ai-pass` header |
| `POST /api/chat/verify`                | trades a solved human check for a 30-minute AI pass                          |
| `/api/global/...`                      | global chat: gate, login, rooms, messages, files, reports                    |
| `GET /api/global/rooms/:id/game`       | WebSocket to that room's `GameRoom`                                          |
| `/api/global/mod/...`                  | moderation for signed-in staff (mods get a smaller set than admins)         |
| `/api/admin/global/...`                | the same moderation with the admin token, handy for `curl`                   |

---

## Deployment

```bash
npx wrangler deploy
```

This publishes the Worker and the static assets together. The secrets and the KV, D1 and Durable Object bindings must already exist on the account (see [Setup](#setup)). Then push to `main` so the shell can load your page changes from GitHub.

A Worker can only be attached to a hostname once. To serve it on a custom domain, add the apex domain as a **Custom Domain**, and add subdomains as a **Route** such as `*.example.com/*` (Custom Domains don't allow wildcards, or hostnames that already have a DNS record).

After deploying, check these things:

1. The site loads and the pages navigate.
2. Submitting a form shows up on the admin page.
3. The AI page streams an answer and the chat lets you sign in.
4. The human check appears on forms, admin sign-in, chat sign-in and the AI page, and a submission with a solved check goes through.
5. A multiplayer game starts in a chat room.

---

## Troubleshooting

### `POST /api/chat` returns 404

The request is not reaching the Worker. Run `npx wrangler dev` or open the deployed Worker URL. A plain static server cannot serve the API.

### The AI page says "not configured" or "temporarily unavailable"

`GEMINI_API_KEY` is missing. Set it with `npx wrangler secret put GEMINI_API_KEY`, or add it to `.dev.vars` locally. Short outages on Google's side are retried automatically a few times before the page shows an error.

### The AI page keeps asking for a human check

The 30-minute pass expired or the Worker's signing secret changed. Solve the check again. If it loops, check that `TURNSTILE_SECRET` belongs to the same Turnstile widget as the site key in `Pages/ai.html`.

### The admin page says "unauthorized" or "complete the human check"

The token must match `ADMIN_TOKEN` exactly, and the human check must be solved for each sign-in attempt. After 10 wrong tries from one IP, sign-in is blocked for 5 minutes.

### Turnstile says "siteverify isn't being called"

The Worker is skipping the check. Make sure `TURNSTILE_SECRET` is set (`npx wrangler secret list`), that it is the secret from the same widget as your site key, and that you have redeployed. The warning clears after a real submission has been verified.

### "Please complete the human check"

The widget has not finished, or its token was already used. Wait for it to finish; each page resets its widget after every attempt. If it keeps failing, confirm your hostname is listed on the Turnstile widget.

### Chat says "chat is not configured"

Set `ADMIN_TOKEN` or `CHAT_SECRET`. Chat sessions are signed with one of them.

### Staff sign-in says "incorrect password"

Passwords in `CHAT_ADMINS` and `CHAT_MODS` are matched exactly, including capital letters and apostrophes. Check for a stray space or comma in the secret.

### Chat says "chat storage is not set up"

The D1 binding is missing. Create the database and add the `[[d1_databases]]` block to `wrangler.toml` (see [Setup](#2-create-the-d1-database-chat)), then redeploy or restart `wrangler dev`.

### Games in chat say "games are not set up"

The `GAMES` Durable Object binding is missing. Add the binding and migration to `wrangler.toml` (see [Setup](#3-add-the-durable-object-multiplayer-games)), make sure `worker.js` exports `GameRoom`, then redeploy.

### Chat or forms stop saving

You have probably reached a free-plan limit (see [Configuration](#free-plan-limits)). They reset daily at 00:00 UTC.

### Page changes do not show up

Pages load from GitHub through jsDelivr, so push to `main` first. Then use **Reload from source** in settings or hard-refresh. If **Always fresh** is off, jsDelivr may serve an older copy for a while. Worker changes need `npx wrangler deploy`.

### "Failed to add domain"

Another Worker already owns that hostname. Remove it there first. Wildcard subdomains also can't be Custom Domains: use a Route instead.