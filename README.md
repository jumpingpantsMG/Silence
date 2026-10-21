# Silence

A gaming site built from plain HTML, CSS and JavaScript, served by a Cloudflare Worker.

The Worker does two jobs: it serves the static site, and it runs a small API for forms, the AI page and the global chat. Forms live in Cloudflare KV, and the chat (messages, rooms, bans and files) lives in Cloudflare D1.

---

## Table of contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Run locally](#run-locally)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [API](#api)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Games**: served from a Cloudflare R2 public bucket.
- **Forms**: requests, bug reports and feedback, stored in KV and managed from the admin page.
- **AI**: a streaming chat page that talks to Gemini through the Worker, so the API key never reaches the browser.
- **Global chat**: usernames, a global room plus user-made rooms (public, private or admin-only), replies, edits, file sharing, reports, and staff moderation.
- **Soundboard**, **settings** and an **admin** page.

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

### 1. Create the KV namespace (forms)

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

### 3. Check `wrangler.toml`

`worker.js` expects these bindings:

| Binding  | Type          | Purpose                          |
| -------- | ------------- | -------------------------------- |
| `ASSETS` | static assets | the site itself                  |
| `FORMS`  | KV namespace  | form submissions and chat reports |
| `DB`     | D1 database   | chat messages, rooms, bans, files |

### 4. Add secrets

```bash
npx wrangler secret put ADMIN_TOKEN       # admin page login, also signs chat sessions
npx wrangler secret put GEMINI_API_KEY    # the AI page
npx wrangler secret put CHAT_ADMINS       # optional: extra chat staff, see below
npx wrangler secret put CHAT_SECRET       # optional: separate key for chat sessions
```

Secrets cannot be viewed again after you set them. If one leaks, set a new value.

For local development, put the same values in a `.dev.vars` file in the repo root. Keep it out of git.

```ini
ADMIN_TOKEN=pick-something-long
GEMINI_API_KEY=your-key
CHAT_ADMINS=alice:a-long-password
```

---

## Run locally

Use Wrangler, not a plain file server. A plain server (`python3 -m http.server`, `live-server`) only serves the static files, so forms, the AI page and the chat will not work.

```bash
npx wrangler dev
```

Then open the address it prints (usually `http://localhost:8787`). Local KV and D1 are simulated on your machine and start empty.

---

## Configuration

### Chat staff

The chat sign-in asks staff usernames for a password. Everyone else just picks a username.

- `ADMIN_TOKEN` is always a staff account with the username `admin`, using the token as its password.
- `CHAT_ADMINS` adds more staff. The format is `name:password`, separated by commas.

  ```text
  alice:first-password,bob:second-password
  ```

  Passwords can contain spaces but not commas, and they are matched exactly (case-sensitive).
- Staff can delete other people's messages, mute and ban users, create admin-only rooms, and see every room.

### Chat limits

| Setting               | Value                                   |
| --------------------- | --------------------------------------- |
| Messages kept         | newest 100 per room                     |
| Message length        | 300 characters                          |
| File size             | 2 MB                                    |
| Files kept            | newest 25 across the whole site         |
| Rooms                 | up to 50                                |
| Session length        | 24 hours (chat pauses after 10 idle minutes) |
| Message and file expiry | 7 days                                |

The word filter is the `BLOCKED_WORDS` list near the top of the chat section in `worker.js`. Add your own words there. Links are blocked for everyone except staff.

### Free-plan limits

The free plan is plenty for a small chat.

| Service | Free per day | What uses it |
| ------- | ------------ | ------------ |
| D1 rows written | 100,000 | a message is about 3 rows, a 2 MB file about 7 |
| D1 rows read    | 5,000,000 | chat polls and loading messages |
| D1 storage      | 5 GB | messages and the newest 25 files |
| KV writes       | 1,000 | form submissions and chat reports only |
| Worker requests | 100,000 | every API call, including each chat poll |

Chat polling is cheap on purpose: the Worker remembers each room's recent messages for a few seconds and only asks D1 when something changed. The number to watch is Worker requests, because every open chat tab makes one request every few seconds. Check usage in the Cloudflare dashboard under Workers & Pages.

---

## Project structure

```text
Silence/
├── index.html        shell that loads the pages
├── pages/            one HTML file per page (games, forms, soundboard, settings, admin, ai, chat)
├── js/               shared scripts, for example Navbar.js
├── style.css         shared styles used by every page
├── worker.js         the Cloudflare Worker (static site + API + chat storage)
├── wrangler.toml     Cloudflare configuration
└── README.md
```

Pages share `style.css` and the navbar instead of repeating CSS. If a file here does not match your checkout, trust the checkout and update this list.

---

## API

All routes are served by `worker.js`. Anything that is not under `/api/` falls through to the static site.

| Route                              | What it does                                              |
| ---------------------------------- | --------------------------------------------------------- |
| `POST /api/forms`                  | submit a request, bug report or feedback (1 per minute per IP) |
| `/api/admin/submissions[/:id]`     | list, read, mark done and delete submissions. Needs `Authorization: Bearer <ADMIN_TOKEN>` |
| `POST /api/chat`                   | AI proxy. Streams the Gemini reply back as server-sent events |
| `/api/global/...`                  | global chat: login, rooms, messages, files, reports, moderation |
| `/api/admin/global/...`            | chat moderation with the admin token, handy for `curl`    |

---

## Deployment

```bash
npx wrangler deploy
```

This publishes the Worker and the static assets together. The secrets and the KV and D1 bindings must already exist on the account (see [Setup](#setup)).

After deploying, check these three things:

1. The site loads and the pages navigate.
2. Submitting a form shows up on the admin page.
3. The AI page streams an answer and the chat lets you sign in.

---

## Troubleshooting

### `POST /api/chat` returns 404

The request is not reaching the Worker. Run `npx wrangler dev` or open the deployed Worker URL. A plain static server cannot serve the API.

### The AI page says "not configured" or "temporarily unavailable"

`GEMINI_API_KEY` is missing. Set it with `npx wrangler secret put GEMINI_API_KEY`, or add it to `.dev.vars` locally. Short outages on Google's side are retried automatically a few times before the page shows an error.

### The admin page says "unauthorized"

The token must match `ADMIN_TOKEN` exactly. After 10 wrong tries from one IP, sign-in is blocked for 5 minutes.

### Chat says "chat is not configured"

Set `ADMIN_TOKEN` or `CHAT_SECRET`. Chat sessions are signed with one of them.

### Staff sign-in says "incorrect password"

Passwords in `CHAT_ADMINS` are matched exactly, including capital letters and apostrophes. Check for a stray space or comma in the secret.

### Chat says "chat storage is not set up"

The D1 binding is missing. Create the database and add the `[[d1_databases]]` block to `wrangler.toml` (see [Setup](#2-create-the-d1-database-chat)), then redeploy or restart `wrangler dev`.

### Chat or forms stop saving

You have probably reached a free-plan limit (see [Configuration](#free-plan-limits)). They reset daily at 00:00 UTC.

### Changes do not show up after deploying

Hard-refresh the page. If pages are loaded through a CDN, it may still be serving an older copy for a while.