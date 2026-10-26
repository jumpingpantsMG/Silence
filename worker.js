// silence · Cloudflare Worker
// Serves the static site (ASSETS binding) and handles, under /api:
//   POST   /api/forms                    public form submissions  -> KV
//   *      /api/admin/submissions[/:id]  token-protected admin    -> KV
//   POST   /api/chat                     gemini proxy (streaming)
//   *      /api/global/...               global chat (rooms, messages, files, reports)
//   *      /api/admin/global/...         chat moderation, ADMIN_TOKEN only
//   *      /api/global/mod/...           same moderation, for signed-in chat staff
//
// Bindings (see wrangler.toml):  ASSETS, FORMS (KV)
// Secrets:                       ADMIN_TOKEN, GEMINI_API_KEY
// Optional secrets:              CHAT_ADMINS = "alice:password1,bob:password2"  (extra chat staff)
//                                CHAT_SECRET  signs chat sessions (defaults to ADMIN_TOKEN)
// Durable Object:                GAMES (class GameRoom in game/room.js): multiplayer games inside chat rooms
//   GET    /api/global/rooms/:id/game   websocket, forwarded to that room's GameRoom

export { GameRoom } from "./game/room.js";   // the Durable Object class must be exported from the main module
import { handleAds, adminAds } from "./ads.js";
const adsDeps = () => ({ json, clean, clientIp, isSameOrigin, isAdmin, blockedWord, hasLink, sha256 });

const TYPES = new Set(["request", "bug", "feedback", "application"]);
const STATUSES = new Set(["new", "done"]);
const GEMINI_URL =
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MODEL = "gemini-3.5-flash-lite";
const SYSTEM = "You are a helpful, friendly assistant. Keep answers clear and concise.";

const json = (data, status = 200, headers = {}) =>
    new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            ...headers,
        },
    });

// strip control characters, trim, cap length
const clean = (v, max) =>
    typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max) : "";

const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

async function isAdmin(request, env) {
    const h = request.headers.get("authorization") || "";
    const given = h.startsWith("Bearer ") ? h.slice(7) : "";
    const [a, b] = await Promise.all([sha256(given), sha256(env.ADMIN_TOKEN)]);
    return crypto.subtle.timingSafeEqual(a, b);
}

const clientIp = (request) => request.headers.get("cf-connecting-ip") || "unknown";

// browsers always send Origin on POST; block other sites from using our endpoints
function isSameOrigin(request) {
    const origin = request.headers.get("origin");
    const mine = new URL(request.url).origin;
    if (origin) return origin === mine;
    return request.headers.get("sec-fetch-site") === "same-origin";
}

/* ───────── public: submit a form ───────── */
async function submitForm(request, env) {
    if (Number(request.headers.get("content-length") || 0) > 8192) return json({ error: "too large" }, 413);

    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
    if (!body || typeof body !== "object") return json({ error: "invalid json" }, 400);

    // honeypot: bots fill the hidden field. pretend it worked.
    if (clean(body.website, 200)) return json({ ok: true });

    const type = clean(body.type, 20);
    const message = clean(body.message, 1500);
    const subject = clean(body.subject, 100);
    const name = clean(body.name, 60);
    const contact = clean(body.contact, 120);

    if (!TYPES.has(type)) return json({ error: "bad type" }, 400);
    if (message.length < 5) return json({ error: "message too short" }, 400);
    if (type !== "feedback" && !subject) return json({ error: "subject required" }, 400);

    // 1 submission / minute / IP
    const rl = "rl:" + clientIp(request);
    if (await env.FORMS.get(rl)) return json({ error: "slow down" }, 429);
    await env.FORMS.put(rl, "1", { expirationTtl: 60 });

    // inverted timestamp so KV's ascending key order lists newest first
    const ts = Date.now();
    const id = `sub:${String(9999999999999 - ts).padStart(13, "0")}:${crypto.randomUUID().slice(0, 8)}`;
    const record = { type, name, contact, subject, message, ts, status: "new" };
    // metadata (<1KB) powers the admin list without reading every value
    const metadata = { t: type, n: name.slice(0, 30), s: subject.slice(0, 50), p: message.slice(0, 80), ts, st: "new" };

    await env.FORMS.put(id, JSON.stringify(record), { metadata });
    return json({ ok: true });
}

/* ───────── admin ───────── */
async function admin(request, env, url) {
    if (!env.ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN is not set" }, 503);

    // throttle bad guesses: 10 failures / 5 min / IP
    const failKey = "fail:" + clientIp(request);
    const fails = Number((await env.FORMS.get(failKey)) || 0);
    if (fails >= 10) return json({ error: "too many attempts, try later" }, 429);

    if (!(await isAdmin(request, env))) {
        await env.FORMS.put(failKey, String(fails + 1), { expirationTtl: 300 });
        return json({ error: "unauthorized" }, 401);
    }

    const parts = url.pathname.split("/").filter(Boolean); // ["api","admin","submissions",":id"]
    if (parts[2] === "global") return adminGlobal(request, env, parts);
    if (parts[2] === "ads") return adminAds(request, env, url, parts, adsDeps());
    if (parts[2] === "announcement") return adminAnnouncement(request, env);
    if (parts[2] !== "submissions") return json({ error: "not found" }, 404);
    const id = parts[3] ? decodeURIComponent(parts[3]) : null;
    if (id && !id.startsWith("sub:")) return json({ error: "bad id" }, 400);

    // list
    if (!id && request.method === "GET") {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 100));
        const cursor = url.searchParams.get("cursor") || undefined;
        const res = await env.FORMS.list({ prefix: "sub:", limit, cursor });
        return json({
            items: res.keys.map((k) => ({ id: k.name, ...k.metadata })),
            cursor: res.list_complete ? null : res.cursor,
        });
    }

    if (!id) return json({ error: "method not allowed" }, 405);

    // read one
    if (request.method === "GET") {
        const v = await env.FORMS.get(id, "json");
        return v ? json({ id, ...v }) : json({ error: "not found" }, 404);
    }

    // update status
    if (request.method === "PATCH") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
        if (!STATUSES.has(body.status)) return json({ error: "bad status" }, 400);
        const { value, metadata } = await env.FORMS.getWithMetadata(id, "json");
        if (!value) return json({ error: "not found" }, 404);
        value.status = body.status;
        await env.FORMS.put(id, JSON.stringify(value), { metadata: { ...metadata, st: body.status } });
        return json({ ok: true });
    }

    // delete
    if (request.method === "DELETE") {
        await env.FORMS.delete(id);
        return json({ ok: true });
    }

    return json({ error: "method not allowed" }, 405);
}

/* ───────── ai ───────── */
async function ai(request, env) {
    if (!env.GEMINI_API_KEY) return json({ error: "not configured" }, 503);

    let body;
    try {
        body = await request.json();
    } catch {
        return json({ error: "bad json" }, 400);
    }

    const messages = (Array.isArray(body.messages) ? body.messages : [])
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-20)
        .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!messages.length) return json({ error: "no messages" }, 400);

    let res;

    for (let attempt = 0; attempt < 4; attempt++) {
        res = await fetch(GEMINI_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                Authorization: `Bearer ${env.GEMINI_API_KEY}`,
            },
            body: JSON.stringify({
                model: MODEL,
                stream: true,
                messages: [
                    { role: "system", content: SYSTEM },
                    ...messages,
                ],
            }),
        });

        // Success: continue streaming the response.
        if (res.ok && res.body) break;

        // Retry only temporary server/capacity errors.
        if (![408, 429, 500, 502, 503, 504].includes(res.status)
            || attempt === 3) {
            const details = await res.text();
            console.error("Gemini API error:", res.status, details);

            return json({
                error: "Gemini is temporarily unavailable. Please try again.",
            }, 502);
        }

        // Discard the failed response before retrying.
        await res.body?.cancel();

        const delay = 1000 * (2 ** attempt)
            + Math.random() * 500;

        await new Promise(resolve => setTimeout(resolve, delay));
    }

    if (!res?.ok || !res.body) {
        return json({ error: "Gemini is temporarily unavailable." }, 502);
    }

    return new Response(res.body, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
        },
    });
}

/* ═════════════ global chat (modelled on nova hub's chat) ═════════════
   Flow: username gate (staff names ask for their password) -> signed 24h session token
         -> lobby (global chat + rooms) -> chat.  Sessions are stateless (HMAC-signed), so
         login / renew / leave cost zero KV writes.

   Secrets:  ADMIN_TOKEN               signs sessions; also staff "admin" + this password
             CHAT_ADMINS (optional)    "alice:password1,bob:password2"  extra staff accounts
             CHAT_SECRET (optional)    signs sessions instead of ADMIN_TOKEN

   D1 (binding DB): one small table, "kv", used like a key/value store, plus "chunks" for file bytes.
     room:<id>                 room record; metadata = {name,d,ao,pw,by,ts,la}
     msg:<room>:<inv>:<rand>   message; metadata = what the page needs, value = full record
     head:<room>               changes on every send / edit / delete (polls read only this)
     file:<inv>-<rand>         file info; the bytes are in "chunks"; only the newest FILE_KEEP are kept
     mute:d:<device>           admin mute (expires after its length)
     ban:u|i|d:<value>         ban by username / ip / device (expires after its length)
   Reports are written as normal "sub:" records (type "report") in the KV namespace with the forms.
   The tables are created automatically the first time chat is used. */

const CHAT_KEEP = 100;                 // messages kept per room
const CHAT_MAX_ROOMS = 50;
const CHAT_TTL = 7 * 24 * 3600;        // messages / files expire after 7 days untouched
const ROOM_TTL = 28 * 24 * 3600;       // rooms expire after 28 days without activity
const TEXT_MAX = 300;
const SESSION_MS = 24 * 3600 * 1000;
const FILE_MAX = 2 * 1024 * 1024;      // 2 MB
const FILE_KEEP = 25;                  // newest N files kept site-wide, older ones are deleted
const FILE_TYPES = new Set([
    "image/png", "image/jpeg", "image/gif", "image/webp",
    "application/pdf", "text/plain", "application/zip",
    "audio/mpeg", "video/mp4", "video/webm",
]);
/* ---------- storage (Cloudflare D1) ---------- */
let schemaP = null;
const schemaOf = (env) => {
    if (!env.DB) throw new Error("NO_D1");
    return (schemaP ||= env.DB.batch([
        env.DB.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, m TEXT, x INTEGER)"),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS kv_x ON kv (x) WHERE x IS NOT NULL"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS chunks (fid TEXT NOT NULL, n INTEGER NOT NULL, d TEXT NOT NULL, PRIMARY KEY (fid, n))"),
    ]).catch((e) => { schemaP = null; throw e; }));
};
const KEY_END = "\uffff";
const parseJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
// same calls as a KV namespace (get / getWithMetadata / put / delete / list), so the chat code reads the same
function db(env) {
    const run = async (sql, ...args) => { await schemaOf(env); return env.DB.prepare(sql).bind(...args); };
    const row = async (k) => {
        const r = await (await run("SELECT v, m, x FROM kv WHERE k = ?", k)).first();
        return !r || (r.x && r.x < Date.now()) ? null : r;
    };
    return {
        async get(k, type) { const r = await row(k); return !r ? null : type === "json" ? parseJson(r.v) : r.v; },
        async getWithMetadata(k, type) {
            const r = await row(k);
            return { value: !r ? null : type === "json" ? parseJson(r.v) : r.v, metadata: r?.m ? parseJson(r.m) : null };
        },
        async put(k, v, o = {}) {
            await (await run(
                "INSERT INTO kv (k, v, m, x) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, m = excluded.m, x = excluded.x",
                k, String(v), o.metadata ? JSON.stringify(o.metadata) : null, o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : null,
            )).run();
        },
        async delete(k) { await (await run("DELETE FROM kv WHERE k = ?", k)).run(); },
        async list({ prefix = "", limit = 1000, cursor } = {}) {
            const q = await run(
                `SELECT k, m FROM kv WHERE k ${cursor ? ">" : ">="} ? AND k < ? AND (x IS NULL OR x > ?) ORDER BY k LIMIT ?`,
                cursor || prefix, prefix + KEY_END, Date.now(), limit,
            );
            const { results } = await q.all();
            return {
                keys: results.map((r) => ({ name: r.k, metadata: r.m ? parseJson(r.m) : undefined })),
                list_complete: results.length < limit,
                cursor: results.length ? results[results.length - 1].k : undefined,
            };
        },
    };
}

// files: bytes are stored as base64 text in chunks (one D1 row can't hold more than ~2 MB)
const CHUNK = 384 * 1024;
function toB64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return btoa(s);
}
function fromB64(t) {
    const b = atob(t), u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
}
async function putFile(env, fid, meta, buf) {
    await schemaOf(env);
    const u8 = new Uint8Array(buf), st = [];
    st.push(env.DB.prepare("INSERT INTO kv (k, v, m, x) VALUES (?, '', ?, ?)").bind("file:" + fid, JSON.stringify(meta), Date.now() + CHAT_TTL * 1000));
    for (let i = 0, n = 0; i < u8.length; i += CHUNK, n++) {
        st.push(env.DB.prepare("INSERT INTO chunks (fid, n, d) VALUES (?, ?, ?)").bind(fid, n, toB64(u8.subarray(i, i + CHUNK))));
    }
    await env.DB.batch(st);
    // keep only the newest FILE_KEEP files, site-wide
    await env.DB.batch([
        env.DB.prepare("DELETE FROM kv WHERE k >= 'file:' AND k < 'file;' AND k NOT IN (SELECT k FROM kv WHERE k >= 'file:' AND k < 'file;' ORDER BY k LIMIT ?)").bind(FILE_KEEP),
        env.DB.prepare("DELETE FROM chunks WHERE 'file:' || fid NOT IN (SELECT k FROM kv WHERE k >= 'file:' AND k < 'file;')"),
    ]);
}
async function getFileBytes(env, fid) {
    await schemaOf(env);
    const { results } = await env.DB.prepare("SELECT d FROM chunks WHERE fid = ? ORDER BY n").bind(fid).all();
    if (!results.length) return null;
    const parts = results.map((r) => fromB64(r.d));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}
async function delFile(env, fid) {
    await schemaOf(env);
    await env.DB.batch([
        env.DB.prepare("DELETE FROM kv WHERE k = ?").bind("file:" + fid),
        env.DB.prepare("DELETE FROM chunks WHERE fid = ?").bind(fid),
    ]);
}

// expired rows (messages, bans, files...) are cleared now and then, at most every 30 min per isolate
let lastClean = 0;
async function cleanup(env) {
    const now = Date.now();
    if (now - lastClean < 1800000) return;
    lastClean = now;
    await schemaOf(env);
    await env.DB.batch([
        env.DB.prepare("DELETE FROM kv WHERE x IS NOT NULL AND x < ?").bind(now),
        env.DB.prepare("DELETE FROM chunks WHERE 'file:' || fid NOT IN (SELECT k FROM kv WHERE k >= 'file:' AND k < 'file;')"),
    ]);
}

const RULES_MSG = "that message breaks the chat rules. it was sent to moderators for review. repeated violations can get you banned.";

// ---- word filter + link blocking (add your own words) ----
const BLOCKED_WORDS = ["fuck", "shit", "bitch", "cunt", "asshole"];
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s" };
const squash = (s) => s.replace(/(.)\1+/g, "$1"); // fuuuck -> fuck
const BLOCK_RE = new RegExp(`\\b(${BLOCKED_WORDS.map(squash).join("|")})\\b`);
const blockedWord = (s) =>
    BLOCK_RE.test(squash(s.toLowerCase().replace(/[013457@$]/g, (c) => LEET[c]).replace(/[^a-z]+/g, " ")));
const LINK_RE =
    /(https?:\/\/|www\.|discord\.gg|\b[a-z0-9-]+\.(com|net|org|io|gg|xyz|ru|co|me|tv|ly|app|dev|link|club|info|shop|site|online|cc|to)\b)/i;
const hasLink = (s) => LINK_RE.test(s);

// ---- soft per-IP limiter (memory only: no KV writes, resets when the isolate recycles) ----
const hits = new Map();
function limited(key, gapMs, perMin) {
    const now = Date.now();
    const h = (hits.get(key) || []).filter((t) => now - t < 60000);
    if ((h.length && now - h[h.length - 1] < gapMs) || h.length >= perMin) return true;
    h.push(now);
    hits.set(key, h);
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > 300000) hits.delete(k);
    return false;
}
// counts failures only; true when the key already has `max` failures in the last `windowMs`
const failsOf = (key, windowMs) => (hits.get(key) || []).filter((t) => Date.now() - t < windowMs);
const addFail = (key, windowMs) => { const f = failsOf(key, windowMs); f.push(Date.now()); hits.set(key, f); };

const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const invTs = (ts) => String(9999999999999 - ts).padStart(13, "0");
const rand6 = () => crypto.randomUUID().slice(0, 6);
const bytes = (o) => new TextEncoder().encode(JSON.stringify(o)).length;
const validRoom = (r) => /^[a-z0-9-]{2,24}$/.test(r);
const validMsgId = (s) => /^\d{13}:[0-9a-f]{6}$/.test(s);
const cleanUser = (v) => {
    const n = clean(v, 32).replace(/\s+/g, " ");
    return /^[\p{L}\p{N}_.' -]{2,32}$/u.test(n) ? n : "";
};

// ---- staff + sessions ----
function staffList(env) {
    const list = [];
    if (env.ADMIN_TOKEN) list.push(["admin", env.ADMIN_TOKEN]);
    for (const p of (env.CHAT_ADMINS || "").split(",")) {
        const i = p.indexOf(":");
        const name = p.slice(0, i).trim(), pw = p.slice(i + 1).trim();
        if (i > 0 && /^[\p{L}\p{N}_.\-]{2,32}$/u.test(name) && pw) list.push([name, pw]);
    }
    return list;
}
const findStaff = (env, name) => staffList(env).find(([n]) => n.toLowerCase() === name.toLowerCase());
// moderators: CHAT_MODS = "name:password,name2:password2". An admin name always wins over a mod of the same name.
function modList(env) {
    const list = [];
    for (const p of (env.CHAT_MODS || "").split(",")) {
        const i = p.indexOf(":");
        const name = p.slice(0, i).trim(), pw = p.slice(i + 1).trim();
        if (i > 0 && /^[\p{L}\p{N}_.\-]{2,32}$/u.test(name) && pw) list.push([name, pw]);
    }
    return list;
}
const findMod = (env, name) => (findStaff(env, name) ? undefined : modList(env).find(([n]) => n.toLowerCase() === name.toLowerCase()));
const isStaff = (s) => !!(s && (s.a || s.m));        // admin or mod
const secretOf = (env) => env.CHAT_SECRET || env.ADMIN_TOKEN || "";

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hmacKey = (env) =>
    crypto.subtle.importKey("raw", new TextEncoder().encode(secretOf(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
async function makeToken(env, payload) {
    const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(body));
    return body + "." + b64u(sig);
}
async function readToken(env, token) {
    const [body, sig] = String(token).split(".");
    if (!body || !sig || !secretOf(env)) return null;
    try {
        const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), unb64u(sig), new TextEncoder().encode(body));
        if (!ok) return null;
        const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
        return p.exp > Date.now() ? p : null;
    } catch { return null; }
}
// {s: {u,a,d}} signed in · {bad:true} header present but invalid/expired · {} no header
async function sess(request, env) {
    const h = request.headers.get("authorization") || "";
    if (!h.startsWith("Bearer ")) return {};
    const p = await readToken(env, h.slice(7));
    return p ? { s: p } : { bad: true };
}
const needSession = (a) =>
    a.s ? null : json({ error: a.bad ? "session expired, sign in again" : "sign in first", auth: true }, 401);

const ipHash = async (ip, env) => hex((await sha256("i:" + ip + secretOf(env))).slice(0, 8));
const devHash = async (dev, env) => hex((await sha256("d:" + dev + secretOf(env))).slice(0, 8));

// ---- bans / mutes ----
async function banOf(env, user, ih, dh) {
    const [a, b, c] = await Promise.all([
        db(env).get("ban:u:" + user.toLowerCase(), "json"),
        db(env).get("ban:i:" + ih, "json"),
        db(env).get("ban:d:" + dh, "json"),
    ]);
    return a || b || c;
}
const banError = (b) => json({ error: b.reason ? `you are banned: ${b.reason}` : "you are banned", banned: true }, 403);

// ban + mute check before anything is written. staff are never banned or muted.
async function sendGuard(env, s, ip) {
    const ih = await ipHash(ip, env);
    if (s.a) return { ih };
    const [ban, mute] = await Promise.all([banOf(env, s.u, ih, s.d), db(env).get("mute:d:" + s.d, "json")]);
    if (ban) return { res: banError(ban) };
    if (mute) return { res: json({ error: mute.reason || "you were muted by an admin", muted: true }, 403) };
    return { ih };
}

// ---- rooms ----
/* Polling must stay off KV list(): the free plan allows only 1,000 lists per day.
   - getRoom is remembered in memory for 20s
   - each room has a tiny "head:<room>" key that changes on every send / edit / delete
   - a poll reads that one key (a cheap read), and only lists the messages when the head changed
   - answers are also kept in memory for a few seconds, so many tabs share one KV read */
const FEED_TTL = 4000;       // answer polls from memory for 4s
const FEED_MAX = 600000;     // re-list at least every 10 min (messages expire on their own)
const feeds = new Map();     // room -> { head, v, items, exp, at }
const roomMem = new Map();   // room -> { rec, exp }
let roomsMem = null;         // { keys, exp }  (the lobby list)
async function getRoom(env, room) {
    if (room === "general") return { name: "Global Chat" };
    const c = roomMem.get(room);
    if (c && Date.now() < c.exp) return c.rec;
    const r = await db(env).get("room:" + room, "json");
    const rec = r && typeof r === "object" ? r : null;
    if (rec) roomMem.set(room, { rec, exp: Date.now() + 20000 });
    return rec;
}
const newHead = () => Date.now().toString(36) + rand6();
async function bumpFeed(env, room) {                 // call after anything that changes a room's messages
    feeds.delete(room);
    await db(env).put("head:" + room, newHead(), { expirationTtl: CHAT_TTL });
}
async function feedOf(env, room) {
    const now = Date.now();
    let f = feeds.get(room);
    if (f && now < f.exp) return f;
    let head = await db(env).get("head:" + room);
    if (!head) { head = newHead(); await db(env).put("head:" + room, head, { expirationTtl: CHAT_TTL }); }
    if (f && f.head === head && now - f.at < FEED_MAX) { f.exp = now + FEED_TTL; return f; }
    const l = await db(env).list({ prefix: `msg:${room}:`, limit: CHAT_KEEP + 1 });
    if (l.keys.length > CHAT_KEEP) {   // prune the overflow here, in one statement
        await schemaOf(env);
        await env.DB.prepare("DELETE FROM kv WHERE k >= ? AND k < ? AND k NOT IN (SELECT k FROM kv WHERE k >= ? AND k < ? ORDER BY k LIMIT ?)")
            .bind(`msg:${room}:`, `msg:${room}:${KEY_END}`, `msg:${room}:`, `msg:${room}:${KEY_END}`, CHAT_KEEP).run();
    }
    const items = l.keys.slice(0, CHAT_KEEP).map((k) => ({ id: k.name.split(":").slice(2).join(":"), ...k.metadata })).reverse(); // oldest -> newest
    f = { head, v: head, items, exp: now + FEED_TTL, at: now };
    feeds.set(room, f);
    return f;
}
const roomMeta = (r) => ({ name: r.name, d: r.d || "", ao: r.ao ? 1 : 0, pw: r.ph ? 1 : 0, by: r.by, ts: r.ts, la: r.la || r.ts });
const putRoom = (env, id, r) => (roomMem.delete(id), roomsMem = null, db(env).put("room:" + id, JSON.stringify(r), { metadata: roomMeta(r), expirationTtl: ROOM_TTL }));
const touched = new Map();
async function touchRoom(env, id, rec) { // bump "last active" at most every 5 min per room (saves KV writes)
    if (id === "general" || Date.now() - (touched.get(id) || 0) < 300000) return;
    touched.set(id, Date.now());
    await putRoom(env, id, { ...rec, la: Date.now() });
}
async function newPass(pw) {
    const s = crypto.randomUUID().slice(0, 8);
    return { s, ph: hex(await sha256(s + pw)) };
}
async function passOk(env, rec, pw, ip) {
    if (failsOf("pw:" + ip, 60000).length >= 10) return "limited";
    if (pw) {
        const h = hex(await sha256(rec.s + pw));
        const enc = new TextEncoder();
        if (h.length === rec.ph.length && crypto.subtle.timingSafeEqual(enc.encode(h), enc.encode(rec.ph))) return "ok";
        addFail("pw:" + ip, 60000);
    }
    return "bad";
}
// admin-only rooms are staff only (like nova hub); private rooms need the password (sent as x-room-pass)
async function roomGate(request, env, rec, s) {
    if (rec.ao && !s?.a) return json({ error: "this room is for admins only" }, 403);
    if (!rec.ph || s?.a) return null;
    if (!s) return json({ error: "sign in first", auth: true }, 401);
    let pw = "";
    try { pw = decodeURIComponent(request.headers.get("x-room-pass") || ""); } catch { }
    const r = await passOk(env, rec, pw, clientIp(request));
    if (r === "ok") return null;
    if (r === "limited") return json({ error: "too many wrong passwords, wait a minute" }, 429);
    return json({ error: "password required", pw: true }, 401);
}
const isOwner = (rec, s) => rec.by === s.u && rec.bd === s.d;
const sameOrigin = (request) => isSameOrigin(request) || json({ error: "forbidden" }, 403);

async function chatGate(request, env, url) {
    if (!secretOf(env)) return json({ error: "chat is not configured" }, 503);
    const user = cleanUser(url.searchParams.get("username"));
    if (!user) return json({ error: "usernames can use letters, numbers, spaces, _ . - ' and must be 2-32 characters" }, 400);
    const staff = findStaff(env, user), mod = findMod(env, user);
    if (!staff && !mod && (/admin/i.test(user) || blockedWord(user))) return json({ error: "that username breaks the chat rules" }, 400);
    const dev = url.searchParams.get("device") || "";
    if (/^[\w-]{8,64}$/.test(dev) && !staff) {
        const ban = await banOf(env, user, await ipHash(clientIp(request), env), await devHash(dev, env));
        if (ban) return banError(ban);
    }
    return json({ ok: true, needsPassword: !!(staff || mod) });
}

async function chatLogin(request, env) {
    const bad = sameOrigin(request); if (bad !== true) return bad;
    if (!secretOf(env)) return json({ error: "chat is not configured" }, 503);
    const ip = clientIp(request);
    if (limited("lg:" + ip, 500, 20)) return json({ error: "slow down" }, 429);
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
    const user = cleanUser(body?.username);
    const device = String(body?.deviceId || "");
    if (!user || !/^[\w-]{8,64}$/.test(device)) return json({ error: "bad username" }, 400);

    const staff = findStaff(env, user), mod = findMod(env, user), cred = staff || mod;
    if (cred) {
        if (failsOf("sf:" + ip, 300000).length >= 10) return json({ error: "too many attempts, try later" }, 429);
        const given = await sha256(String(body?.password || ""));
        if (!crypto.subtle.timingSafeEqual(given, await sha256(cred[1]))) {
            addFail("sf:" + ip, 300000);
            return json({ error: "incorrect password" }, 401);
        }
    } else {
        if (/admin/i.test(user) || blockedWord(user)) return json({ error: "that username breaks the chat rules" }, 400);
    }
    const dh = await devHash(device, env);
    if (!staff) {
        const ban = await banOf(env, user, await ipHash(ip, env), dh);
        if (ban) return banError(ban);
    }
    const username = cred ? cred[0] : user;
    const token = await makeToken(env, { u: username, a: !!staff, ...(mod ? { m: 1 } : {}), d: dh, exp: Date.now() + SESSION_MS });
    return json({ ok: true, token, username, isAdmin: !!staff, isMod: !!mod });
}

async function chatRenew(request, env) {
    const bad = sameOrigin(request); if (bad !== true) return bad;
    const a = await sess(request, env);
    const no = needSession(a); if (no) return no;
    return json({ ok: true, token: await makeToken(env, { ...a.s, exp: Date.now() + SESSION_MS }) });
}

/* ---------- rooms ---------- */
async function chatRooms(request, env) {
    const a = await sess(request, env);
    const no = needSession(a); if (no) return no;
    if (!roomsMem || Date.now() > roomsMem.exp) {
        const l = await db(env).list({ prefix: "room:", limit: CHAT_MAX_ROOMS });
        roomsMem = { keys: l.keys, exp: Date.now() + 15000 };
    }
    const rooms = roomsMem.keys
        .filter((k) => !k.metadata?.ao || a.s.a) // admin-only rooms are invisible to everyone else
        .map((k) => ({ id: k.name.slice(5), name: k.metadata.name, d: k.metadata.d, pw: !!k.metadata.pw, ao: !!k.metadata.ao, by: k.metadata.by, ts: k.metadata.ts, la: k.metadata.la }));
    return json({ rooms: [{ id: "general", name: "Global Chat", d: "everyone can see and join" }, ...rooms] });
}

async function chatCreateRoom(request, env) {
    const bad = sameOrigin(request); if (bad !== true) return bad;
    const a = await sess(request, env);
    const no = needSession(a); if (no) return no;
    const s = a.s;
    if (!s.a && limited("r:" + clientIp(request), 20000, 3)) return json({ error: "slow down" }, 429);
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
    const name = clean(body?.name, 50).replace(/\s+/g, " ");
    const d = clean(body?.description, 100).replace(/\s+/g, " ");
    if (!name) return json({ error: "room name required (max 50 chars)" }, 400);
    if (!s.a && (blockedWord(name) || blockedWord(d))) return json({ error: "that room name or description breaks the chat rules" }, 400);
    if (body?.adminOnly && !s.a) return json({ error: "only admins can create admin rooms" }, 403);
    const pw = clean(body?.password, 40);
    if (body?.isPrivate && !pw) return json({ error: "password is required for private rooms" }, 400);

    const l = await db(env).list({ prefix: "room:", limit: CHAT_MAX_ROOMS + 1 });
    if (l.keys.length >= CHAT_MAX_ROOMS) return json({ error: "too many rooms, ask an admin to clean up" }, 400);

    const id = crypto.randomUUID().slice(0, 8);
    const now = Date.now();
    const rec = { name, d, ao: !!body?.adminOnly, by: s.u, bd: s.d, ts: now, la: now, ...(body?.isPrivate ? await newPass(pw) : {}) };
    if (bytes(roomMeta(rec)) > 950) return json({ error: "room name/description too long" }, 400);
    await putRoom(env, id, rec);
    return json({ ok: true, room: { id, name, d, pw: !!rec.ph, ao: rec.ao, by: s.u } });
}

async function chatEditRoom(request, env, id) {
    const bad = sameOrigin(request); if (bad !== true) return bad;
    const a = await sess(request, env);
    const no = needSession(a); if (no) return no;
    if (id === "general") return json({ error: "can't edit the global chat" }, 400);
    const rec = await getRoom(env, id);
    if (!rec) return json({ error: "room not found" }, 404);
    if (!a.s.a && !isOwner(rec, a.s)) return json({ error: "not authorized" }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }

    if (typeof body.name === "string") {
        const n = clean(body.name, 50).replace(/\s+/g, " ");
        if (!n) return json({ error: "room name required" }, 400);
        if (!a.s.a && blockedWord(n)) return json({ error: "that room name breaks the chat rules" }, 400);
        rec.name = n;
    }
    if (typeof body.description === "string") {
        const d = clean(body.description, 100).replace(/\s+/g, " ");
        if (!a.s.a && blockedWord(d)) return json({ error: "that description breaks the chat rules" }, 400);
        rec.d = d;
    }
    if (typeof body.isPrivate === "boolean") {
        if (!body.isPrivate) { delete rec.s; delete rec.ph; }
        else {
            const pw = clean(body.password, 40);
            if (pw) Object.assign(rec, await newPass(pw));
            else if (!rec.ph) return json({ error: "password is required for private rooms" }, 400);
        }
    }
    if (typeof body.adminOnly === "boolean" && a.s.a) rec.ao = body.adminOnly;
    if (bytes(roomMeta(rec)) > 950) return json({ error: "room name/description too long" }, 400);
    await putRoom(env, id, rec);
    return json({ ok: true, room: { id, name: rec.name, d: rec.d, pw: !!rec.ph, ao: !!rec.ao } });
}

async function wipeRoomMessages(env, id) {
    await schemaOf(env);
    await env.DB.prepare("DELETE FROM kv WHERE k >= ? AND k < ?").bind(`msg:${id}:`, `msg:${id}:${KEY_END}`).run();
    await bumpFeed(env, id);
}

async function chatDeleteRoom(request, env, id) {
    const bad = sameOrigin(request); if (bad !== true) return bad;
    const a = await sess(request, env);
    const no = needSession(a); if (no) return no;
    if (id === "general") return json({ error: "can't delete the global chat" }, 400);
    const rec = await getRoom(env, id);
    if (!rec) return json({ error: "room not found" }, 404);
    if (!a.s.a && !isOwner(rec, a.s)) return json({ error: "not authorized" }, 403);
    await wipeRoomMessages(env, id);
    await db(env).delete("room:" + id);
    await db(env).delete("head:" + id);
    roomMem.delete(id); roomsMem = null;
    return json({ ok: true });
}

async function chatJoin(request, env, id) {
    const bad = sameOrigin(request); if (bad !== true) return bad;
    const a = await sess(request, env);
    const no = needSession(a); if (no) return no;
    const rec = await getRoom(env, id);
    if (!rec) return json({ error: "room not found" }, 404);
    if (rec.ao && !a.s.a) return json({ error: "this room is for admins only" }, 403);
    if (rec.ph && !a.s.a) {
        let body = {};
        try { body = await request.json(); } catch { }
        const r = await passOk(env, rec, clean(body?.password, 40), clientIp(request));
        if (r === "limited") return json({ error: "too many wrong passwords, wait a minute" }, 429);
        if (r !== "ok") return json({ error: "incorrect password" }, 401);
    }
    return json({ ok: true, room: { id, name: rec.name, d: rec.d || "", by: rec.by || "" } });
}

/* ---------- messages ---------- */
const metaOf = (v) => {
    const m = { n: v.n, t: v.t, ts: v.ts };
    for (const k of ["rp", "f", "a", "mo", "u", "e", "et"]) if (v[k] !== undefined) m[k] = v[k];
    return m;
};

async function storeMessage(env, room, meta, extra) {
    const ts = Date.now();
    const id = `${invTs(ts)}:${rand6()}`;
    const m = { ...meta, ts };
    if (bytes(m) > 980) return json({ error: "message too long (emoji and non-english letters count extra)" }, 400);
    await db(env).put(`msg:${room}:${id}`, JSON.stringify({ ...m, ...extra }), { metadata: m, expirationTtl: CHAT_TTL });
    await bumpFeed(env, room);       // old messages beyond CHAT_KEEP are pruned the next time the room is listed
    return json({ ok: true, id });
}

async function chatMessages(request, env, room, url) {
    const a = await sess(request, env);
    const no = needSession(a); if (no) return no;
    const rec = await getRoom(env, room);
    if (!rec) return json({ error: "no such room" }, 404);
    const denied = await roomGate(request, env, rec, a.s);
    if (denied) return denied;

    const f = await feedOf(env, room);
    if (url.searchParams.get("v") === f.v) return json({ same: true });
    return json({ v: f.v, items: f.items });
}

async function autoReport(env, room, s, text) {
    if (limited("ar:" + s.u, 30000, 2)) return;
    const ts = Date.now();
    const subject = `chat auto-filter · #${room}`;
    const message = `${s.u}: ${text.slice(0, 300)}\nblocked on send (never posted)`;
    await env.FORMS.put(`sub:${invTs(ts)}:${crypto.randomUUID().slice(0, 8)}`,
        JSON.stringify({ type: "report", name: s.u, contact: "", subject, message, ts, status: "new" }),
        { metadata: { t: "report", n: s.u.slice(0, 30), s: subject, p: message.slice(0, 80), ts, st: "new" } });
}

async function chatSend(request, env, room) {
    const bad = sameOrigin(request); if (bad !== true) return bad;
    if (Number(request.headers.get("content-length") || 0) > 4096) return json({ error: "too large" }, 413);
    const a = await sess(request, env);
    const no = needSession(a); if (no) return no;
    const s = a.s;
    const ip = clientIp(request);
    if (!s.a && limited("m:" + ip, 1500, 25)) return json({ error: "slow down" }, 429);

    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
    const rec = await getRoom(env, room);
    if (!rec) return json({ error: "no such room" }, 404);
    const denied = await roomGate(request, env, rec, s);
    if (denied) return denied;

    // "can you unmute me?" — allowed while muted (not while banned), once a minute
    if (body?.unmuteRequest) {
        const ih = await ipHash(ip, env);
        const ban = await banOf(env, s.u, ih, s.d);
        if (ban) return banError(ban);
        if (!(await db(env).get("mute:d:" + s.d, "json"))) return json({ error: "you're not muted" }, 400);
        if (limited("um:" + s.d, 60000, 1)) return json({ error: "wait a minute before asking again" }, 429);
        return storeMessage(env, room, { n: s.u, t: "can you unmute me?", u: 1 }, { ih, dh: s.d });
    }

    const text = clean(body?.text, TEXT_MAX).replace(/\s+/g, " ");
    let f;
    if (body?.attachment?.id) {
        const fid = String(body.attachment.id);
        if (!/^\d{13}-[0-9a-f]{6}$/.test(fid)) return json({ error: "bad attachment" }, 400);
        const l = await db(env).list({ prefix: "file:" + fid, limit: 1 }); // metadata only, doesn't read the bytes
        const fm = l.keys[0]?.metadata;
        if (!fm || fm.dh !== s.d || fm.room !== room) return json({ error: "attachment expired, upload it again" }, 400);
        f = { id: fid, name: fm.name, type: fm.type, size: fm.size };
    }
    if (!text && !f) return json({ error: "invalid message" }, 400);
    if (!s.a && text && (blockedWord(text) || hasLink(text))) {
        await autoReport(env, room, s, text);
        return json({ error: RULES_MSG, filtered: true }, 400);
    }

    const g = await sendGuard(env, s, ip);
    if (g.res) return g.res;

    // reply: take the quoted text from the server copy so it can't be forged
    let rp;
    const rid = String(body?.replyTo?.id || "");
    if (validMsgId(rid)) {
        const q = await db(env).get(`msg:${room}:${rid}`, "json");
        if (q) rp = { i: rid, n: q.n, t: (q.t || (q.f ? "[file] " + q.f.name : "")).slice(0, 40) };
    }
    const res = await storeMessage(env, room, { n: s.u, t: text, ...(f ? { f } : {}), ...(rp ? { rp } : {}), ...(s.a ? { a: 1 } : {}), ...(s.m ? { mo: 1 } : {}) }, { ih: g.ih, dh: s.d });
    if (res.ok) { await touchRoom(env, room, rec); await cleanup(env).catch(() => { }); }
    return res;
}

async function chatOneMessage(request, env, room, id) {
    const a = await sess(request, env);
    const no = needSession(a); if (no) return no;
    const rec = await getRoom(env, room);
    if (!rec) return json({ error: "no such room" }, 404);
    const denied = await roomGate(request, env, rec, a.s);
    if (denied) return denied;
    const v = await db(env).get(`msg:${room}:${id}`, "json");
    if (!v) return json({ error: "message not found" }, 404);
    return json({ text: v.t, history: v.eh || [] }); // [{t, at}] oldest first
}

async function chatEdit(request, env, room, id) {
    const bad = sameOrigin(request); if (bad !== true) return bad;
    const a = await sess(request, env);
    const no = needSession(a); if (no) return no;
    const s = a.s;
    if (limited("e:" + clientIp(request), 1000, 30)) return json({ error: "slow down" }, 429);
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
    const text = clean(body?.text, TEXT_MAX).replace(/\s+/g, " ");
    if (!text) return json({ error: "invalid message" }, 400);

    const rec = await getRoom(env, room);
    if (!rec) return json({ error: "no such room" }, 404);
    const denied = await roomGate(request, env, rec, s);
    if (denied) return denied;
    const key = `msg:${room}:${id}`;
    const v = await db(env).get(key, "json");
    if (!v) return json({ error: "message not found" }, 404);
    if (v.n !== s.u || v.dh !== s.d) return json({ error: "not your message" }, 403);
    if (v.u) return json({ error: "can't edit this" }, 400);
    if (!s.a && (blockedWord(text) || hasLink(text))) {
        await autoReport(env, room, s, text);
        return json({ error: RULES_MSG, filtered: true }, 400);
    }
    const g = await sendGuard(env, s, clientIp(request));
    if (g.res) return g.res;

    v.eh = [...(v.eh || []), { t: v.t, at: Date.now() }].slice(-10);
    v.t = text; v.e = 1; v.et = Date.now();
    const meta = metaOf(v);
    if (bytes(meta) > 980) return json({ error: "message too long (emoji and non-english letters count extra)" }, 400);
    await db(env).put(key, JSON.stringify(v), { metadata: meta, expirationTtl: CHAT_TTL });
    await bumpFeed(env, room);
    return json({ ok: true });
}

async function chatDeleteMessage(request, env, room, id) {
    const bad = sameOrigin(request); if (bad !== true) return bad;
    const a = await sess(request, env);
    const no = needSession(a); if (no) return no;
    const s = a.s;
    const key = `msg:${room}:${id}`;
    const v = await db(env).get(key, "json");
    if (!v) return json({ error: "message not found" }, 404);
    const own = v.n === s.u && v.dh === s.d;
    // admins can delete anyone's message except other admins; mods can't touch admins or other mods
    if (!own && !((s.a && !v.a) || (s.m && !v.a && !v.mo))) return json({ error: "not your message" }, 403);
    if (v.f?.id) await delFile(env, v.f.id);
    await db(env).delete(key);
    if (!own) await modLog(env, s, "delete", { user: v.n, room, text: v.t || (v.f ? "[file] " + (v.f.name || "") : "") });;
    await db(env).delete(key);
    await bumpFeed(env, room);
    return json({ ok: true });
}

/* ---------- files ---------- */
async function chatUpload(request, env, url) {
    const bad = sameOrigin(request); if (bad !== true) return bad;
    const a = await sess(request, env);
    const no = needSession(a); if (no) return no;
    const s = a.s;
    const ip = clientIp(request);
    if (!s.a && limited("u:" + ip, 20000, 3)) return json({ error: "slow down" }, 429);

    const len = Number(request.headers.get("content-length") || 0);
    if (!len) return json({ error: "empty file" }, 411);
    if (len > FILE_MAX) return json({ error: "file too big (2mb max)" }, 413);
    const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!FILE_TYPES.has(type)) return json({ error: "file type not allowed" }, 415);

    const room = url.searchParams.get("room") || "general";
    if (!validRoom(room)) return json({ error: "bad room" }, 400);
    const name = clean(url.searchParams.get("name"), 60).replace(/[\\/"<>:*?|]/g, "_") || "file";
    if (!s.a && blockedWord(name.replace(/[._-]+/g, " "))) return json({ error: "blocked file name" }, 400);

    const rec = await getRoom(env, room);
    if (!rec) return json({ error: "no such room" }, 404);
    const denied = await roomGate(request, env, rec, s);
    if (denied) return denied;
    const g = await sendGuard(env, s, ip);
    if (g.res) return g.res;

    const buf = await request.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > FILE_MAX) return json({ error: "file too big (2mb max)" }, 413);

    const ts = Date.now();
    const fid = `${invTs(ts)}-${rand6()}`;
    await putFile(env, fid, { name, type, size: buf.byteLength, ts, room, dh: s.d }, buf);
    await cleanup(env).catch(() => { });
    return json({ ok: true, id: fid, name, type, size: buf.byteLength });
}

async function chatFile(request, env, fid) {
    if (!/^\d{13}-[0-9a-f]{6}$/.test(fid)) return json({ error: "not found" }, 404);
    const { metadata } = await db(env).getWithMetadata("file:" + fid);
    if (!metadata) return json({ error: "file expired" }, 404);

    // files in private / admin-only rooms need the same access as the room (page fetches them with headers)
    const a = await sess(request, env);
    if (a.bad) return json({ error: "session expired", auth: true }, 401);
    const rec = await getRoom(env, metadata.room || "general");
    if (!rec) return json({ error: "file expired" }, 404);
    if (rec.ph || rec.ao) {
        const denied = await roomGate(request, env, rec, a.s);
        if (denied) return denied;
    }
    const inline = metadata.type.startsWith("image/");
    const value = await getFileBytes(env, fid);
    if (!value) return json({ error: "file expired" }, 404);
    return new Response(value, {
        headers: {
            "content-type": metadata.type,
            // only images render inline; everything else downloads. nosniff + sandbox CSP keep uploads inert.
            "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(metadata.name)}`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            "cache-control": rec.ph || rec.ao ? "no-store" : "private, max-age=300",
        },
    });
}

/* ---------- reports ---------- */
async function chatReport(request, env) {
    const bad = sameOrigin(request); if (bad !== true) return bad;
    const a = await sess(request, env);
    const no = needSession(a); if (no) return no;
    if (limited("rp:" + clientIp(request), 10000, 5)) return json({ error: "slow down" }, 429);
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
    const room = clean(body?.room, 24);
    const id = clean(body?.id, 30);
    if (!validRoom(room) || !validMsgId(id)) return json({ error: "bad message" }, 400);
    const m = await db(env).get(`msg:${room}:${id}`, "json");
    if (!m) return json({ error: "message is gone" }, 404);

    const reason = clean(body?.reason, 80);
    const details = clean(body?.details, 500);
    const ts = Date.now();
    const subject = `chat report · #${room}`;
    const message =
        `${m.n}: ${m.t || "[file] " + (m.f?.name || "")}\nmessage: ${room}/${id}\nreported by: ${a.s.u}\nreason: ${reason || "(none)"}${details ? "\ndetails: " + details : ""}`;
    await env.FORMS.put(`sub:${invTs(ts)}:${crypto.randomUUID().slice(0, 8)}`,
        JSON.stringify({ type: "report", name: m.n, contact: "", subject, message, ts, status: "new" }),
        { metadata: { t: "report", n: m.n.slice(0, 30), s: subject, p: message.slice(0, 80), ts, st: "new" } });
    return json({ ok: true });
}

/* ---------- multiplayer games (websocket -> Durable Object) ---------- */
// A browser can't set headers on a websocket, so the session token (t) and room password (pw)
// travel in the query string. Everything is checked here; the GameRoom trusts the x-sl-* headers.
async function chatGame(request, env, room, url) {
    if (request.headers.get("upgrade") !== "websocket") return json({ error: "expected a websocket" }, 426);
    if (!env.GAMES) return json({ error: "games are not set up (add the GAMES durable object binding)" }, 503);
    if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);
    const s = await readToken(env, url.searchParams.get("t") || "");
    if (!s) return json({ error: "sign in first", auth: true }, 401);
    const rec = await getRoom(env, room);
    if (!rec) return json({ error: "no such room" }, 404);

    const headers = new Headers(request.headers);
    headers.set("x-room-pass", encodeURIComponent(url.searchParams.get("pw") || ""));
    const denied = await roomGate(new Request(request.url, { headers }), env, rec, s);
    if (denied) return denied;
    if (!s.a) {
        const ban = await banOf(env, s.u, await ipHash(clientIp(request), env), s.d);
        if (ban) return banError(ban);
    }

    const fwd = new Request(request);
    fwd.headers.set("x-sl-pid", s.d);
    fwd.headers.set("x-sl-name", s.u);
    fwd.headers.set("x-sl-admin", s.a ? "1" : "0");
    return env.GAMES.get(env.GAMES.idFromName(room)).fetch(fwd);
}

/* ---------- router ---------- */
async function globalChat(request, env, url) {
    const p = url.pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent); // after ["api","global"]
    const m = request.method;

    if (p[0] === "gate" && m === "GET") return chatGate(request, env, url);
    if (p[0] === "login" && m === "POST") return chatLogin(request, env);
    if (p[0] === "renew" && m === "POST") return chatRenew(request, env);

    if (p[0] === "rooms") {
        if (!p[1]) {
            if (m === "GET") return chatRooms(request, env);
            if (m === "POST") return chatCreateRoom(request, env);
        } else if (!validRoom(p[1])) {
            return json({ error: "bad room" }, 400);
        } else if (!p[2]) {
            if (m === "PATCH") return chatEditRoom(request, env, p[1]);
            if (m === "DELETE") return chatDeleteRoom(request, env, p[1]);
        } else if (p[2] === "join" && m === "POST") {
            return chatJoin(request, env, p[1]);
        } else if (p[2] === "game" && m === "GET") {
            return chatGame(request, env, p[1], url);
        } else if (p[2] === "messages") {
            if (!p[3]) {
                if (m === "GET") return chatMessages(request, env, p[1], url);
                if (m === "POST") return chatSend(request, env, p[1]);
            } else if (validMsgId(p[3])) {
                if (m === "GET") return chatOneMessage(request, env, p[1], p[3]);
                if (m === "PATCH") return chatEdit(request, env, p[1], p[3]);
                if (m === "DELETE") return chatDeleteMessage(request, env, p[1], p[3]);
            }
        }
    }
    if (p[0] === "upload" && m === "POST") return chatUpload(request, env, url);
    if (p[0] === "file" && p[1] && m === "GET") return chatFile(request, env, p[1]);
    if (p[0] === "report" && m === "POST") return chatReport(request, env);

    if (p[0] === "mod") {
        const a = await sess(request, env);
        const no = needSession(a); if (no) return no;
        if (!a.s.a) return json({ error: "not authorized" }, 403);
        if (m !== "GET") { const bad = sameOrigin(request); if (bad !== true) return bad; }
        return chatMod(request, env, a.s, p.slice(1));
    }
    return json({ error: "not found" }, 404);
}

/* ---------- moderation (staff only) ----------
   Called from /api/global/mod/... (staff session) and /api/admin/global/... (ADMIN_TOKEN, for curl).
   POST   mute     {room,id,minutes,reason}   mute that message's author's device (minutes 0 = permanent)
   POST   unmute   {room,id}
   POST   ban      {room,id,type:"username"|"ip"|"device",minutes,reason}
   POST   unban    {room,id,type}
   GET    mutes    GET bans
   DELETE rooms/<id>?wipe=1                   empty a room (without ?wipe the room is removed too) */
async function chatMod(request, env, s, p) {
    const what = p[0], m = request.method;
    const MODLOG_TTL = 30 * 86400;      // mod log entries are kept for 30 days
    const MOD_MAX_MUTE = 1440;          // mods can mute for up to 24h (minutes)
    async function modLog(env, s, act, d = {}) {
        try {
            const ts = Date.now();
            const e = { ts, by: s.u, role: s.a ? "admin" : "mod", act };
            for (const k of ["user", "room", "reason", "text", "type"]) if (d[k]) e[k] = String(d[k]).slice(0, k === "text" ? 120 : 80);
            if (d.minutes !== undefined) e.mins = d.minutes;
            await db(env).put(`log:${invTs(ts)}:${rand6()}`, JSON.stringify(e), { metadata: e, expirationTtl: MODLOG_TTL });
        } catch (err) { console.error("modlog", err); }       // never block a moderation action on a logging failure
    }

    const admin = !!s.a;
    // mods get: mutes, reports, log, mute, unmute. everything else is admin only.
    if (!admin && !["mutes", "reports", "log", "mute", "unmute"].includes(what)) return json({ error: "admins only" }, 403);

    if (what === "log" && m === "GET") {
        const l = await db(env).list({ prefix: "log:", limit: 200 });
        return json({ items: l.keys.map((k) => k.metadata).filter(Boolean) });
    }
    if (what === "reports" && m === "GET") {              // newest chat reports and auto-filter hits, for mods to review
        const res = await env.FORMS.list({ prefix: "sub:", limit: 200 });
        const keys = res.keys.filter((k) => k.metadata?.t === "report").slice(0, 30);
        const items = await Promise.all(keys.map(async (k) => {
            const v = await env.FORMS.get(k.name, "json");
            return v ? { id: k.name, subject: v.subject, message: v.message, ts: v.ts, status: v.status } : null;
        }));
        return json({ items: items.filter(Boolean) });
    }

    if (what === "mutes" && m === "GET") {
        const l = await db(env).list({ prefix: "mute:", limit: 200 });
        return json({ items: l.keys.map((k) => ({ key: k.name, ...k.metadata })) });
    }
    if (what === "bans" && m === "GET") {
        const l = await db(env).list({ prefix: "ban:", limit: 200 });
        return json({ items: l.keys.map((k) => ({ key: k.name, ...k.metadata })) });
    }

    if (what === "rooms" && m === "DELETE") {
        const room = p[1];
        if (!validRoom(room || "")) return json({ error: "bad room" }, 400);
        await wipeRoomMessages(env, room);
        await modLog(env, s, new URL(request.url).searchParams.has("wipe") || room === "general" ? "wipe room" : "delete room", { room });
        if (room !== "general" && !new URL(request.url).searchParams.has("wipe")) { await db(env).delete("room:" + room); await db(env).delete("head:" + room); roomMem.delete(room); roomsMem = null; }
        return json({ ok: true });
    }

    if (["mute", "unmute", "ban", "unban"].includes(what) && m === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
        const room = clean(body?.room, 24), id = clean(body?.id, 30);
        if (!validRoom(room) || !validMsgId(id)) return json({ error: "pick a message" }, 400);
        const v = await db(env).get(`msg:${room}:${id}`, "json");
        if (!v) return json({ error: "message not found" }, 404);
        if (v.a) return json({ error: `can't ${what} an admin` }, 400);
        if (v.mo && !admin) return json({ error: `can't ${what} another mod` }, 400);

        let minutes = Math.max(0, Math.floor(Number(body?.minutes) || 0)); // 0 = permanent
        if (!admin && what === "mute") minutes = minutes ? Math.min(minutes, MOD_MAX_MUTE) : MOD_MAX_MUTE; // mods: never permanent
        const reason = clean(body?.reason, 80);
        const until = minutes ? Date.now() + minutes * 60000 : 0;
        const role = admin ? "admin" : "mod";
        const opts = (extra) => ({ metadata: { user: v.n, reason, until, by: s.u, role, ...extra }, ...(minutes ? { expirationTtl: Math.max(60, minutes * 60) } : {}) });
        const rec = JSON.stringify({ reason, until, by: s.u, role, user: v.n });

        if (what === "mute") {
            const cur = await db(env).get("mute:d:" + v.dh, "json");
            if (cur?.role === "admin" && !admin) return json({ error: "an admin already muted them" }, 403);
            await db(env).put("mute:d:" + v.dh, rec, opts());
            await modLog(env, s, "mute", { user: v.n, room, reason, minutes });
            return json({ ok: true });
        }
        if (what === "unmute") {
            const cur = await db(env).get("mute:d:" + v.dh, "json");
            if (cur?.role === "admin" && !admin) return json({ error: "an admin set this mute, ask an admin" }, 403);
            await db(env).delete("mute:d:" + v.dh);
            await modLog(env, s, "unmute", { user: v.n, room });
            return json({ ok: true });
        }

        const type = body?.type;
        const key = type === "ip" ? "ban:i:" + v.ih : type === "device" ? "ban:d:" + v.dh : type === "username" ? "ban:u:" + v.n.toLowerCase() : "";
        if (!key) return json({ error: "bad ban type" }, 400);
        if (what === "ban") await db(env).put(key, rec, opts({ type }));
        else await db(env).delete(key);
        await modLog(env, s, what, { user: v.n, room, reason, minutes, type });
        return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
}
const adminGlobal = (request, env, parts) =>
    chatMod(request, env, { u: "admin", a: true }, parts.slice(3)); // parts = ["api","admin","global",...]

/* ───────── announcement ───────── */
const ANN_KEY = "announce:current";
let annMem = null; // { v, exp }: remembered for 30s so page loads share one KV read
async function readAnnouncement(env) {
    if (annMem && Date.now() < annMem.exp) return annMem.v;
    const v = (await env.FORMS.get(ANN_KEY, "json")) || {};
    annMem = { v, exp: Date.now() + 30000 };
    return v;
}
async function announcement(env) {            // public: only what the banner needs
    const { id, text, level } = await readAnnouncement(env);
    return json(text ? { id, text, level } : {}, 200, { "cache-control": "public, max-age=30" });
}
async function adminAnnouncement(request, env) {
    if (request.method === "GET") return json(await readAnnouncement(env));
    if (request.method === "DELETE") {
        await env.FORMS.delete(ANN_KEY); annMem = null;
        return json({ ok: true });
    }
    if (request.method === "PUT") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
        const text = clean(body?.text, 300).replace(/\s+/g, " ");
        if (!text) return json({ error: "message required" }, 400);
        const level = body?.level === "warn" ? "warn" : "info";
        const hours = Math.min(720, Math.max(0, Math.floor(Number(body?.hours) || 0))); // 0 = never expires
        const now = Date.now();
        const rec = { id: now.toString(36), text, level, ts: now, until: hours ? now + hours * 3600000 : 0 };
        await env.FORMS.put(ANN_KEY, JSON.stringify(rec), hours ? { expirationTtl: hours * 3600 } : undefined);
        annMem = null;
        return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
}

/* ───────── router ───────── */
export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname.startsWith("/api/")) {
            try {
                if (url.pathname === "/api/forms") {
                    return request.method === "POST" ? await submitForm(request, env) : json({ error: "method not allowed" }, 405);
                }
                if (url.pathname === "/api/announcement") return request.method === "GET" ? await announcement(env) : json({ error: "method not allowed" }, 405);
                if (url.pathname.startsWith("/api/admin/")) return await admin(request, env, url);
                if (url.pathname === "/api/chat") return await ai(request, env);
                if (url.pathname.startsWith("/api/ads/")) return await handleAds(request, env, url, adsDeps());
                if (url.pathname.startsWith("/api/global/")) return await globalChat(request, env, url);
                return json({ error: "not found" }, 404);
            } catch (e) {
                if (e?.message === "NO_D1") return json({ error: "chat storage is not set up (add the D1 binding named DB)" }, 503);
                console.error(e);
                return json({ error: "server error" }, 500);
            }
        }

        return env.ASSETS.fetch(request);
    },
};