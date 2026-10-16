// silence · Cloudflare Worker
// Serves the static site (ASSETS binding) and handles two things under /api:
//   POST   /api/forms                    public form submissions  -> KV
//   *      /api/admin/submissions[/:id]  token-protected admin    -> KV
//
// Bindings (see wrangler.toml):  ASSETS, FORMS (KV)
// Secret:                        ADMIN_TOKEN   (wrangler secret put ADMIN_TOKEN)

const TYPES = new Set(["request", "bug", "feedback"]);
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

async function ai(request, env) {
    if (!env.GEMINI_API_KEY) return json({ error: "not configured" }, 503);

    let body;
    console.log(request, request.body, request.json());
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }

    const messages = (Array.isArray(body.messages) ? body.messages : [])
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-20)
        .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!messages.length) return json({ error: "no messages" }, 400);

    const res = await fetch(GEMINI_URL, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${env.GEMINI_API_KEY}`,
        },
        body: JSON.stringify({
            model: MODEL,
            stream: true,
            messages: [{ role: "system", content: SYSTEM }, ...messages],
        }),
    });

    if (!res.ok || !res.body) return json({ error: "upstream error" }, res.status || 502);

    return new Response(res.body, {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
    });
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
                if (url.pathname.startsWith("/api/admin/")) return await admin(request, env, url);
                if (url.pathname === "/api/chat") return await ai(request, env);
                return json({ error: "not found" }, 404);
            } catch (e) {
                console.error(e);
                return json({ error: "server error" }, 500);
            }
        }

        return env.ASSETS.fetch(request);
    },
};