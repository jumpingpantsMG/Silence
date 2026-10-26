// silence · paid ads (Stripe Checkout). Imported by worker.js, no other setup.
//
// Flow:  advertiser submits  ->  you approve in admin (price is set then)  ->  advertiser pays via
//        Stripe Checkout  ->  webhook marks it live for 48h  ->  pages show it (js ads snippet).
//
// KV (the FORMS namespace):
//   ad:req:<id>   the request {status: pending|approved|rejected|paid}, 30 day expiry
//   ad:live:<id>  a paid ad, expires on its own after 48h. metadata = {t,x,u}
//
// Secrets:  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// Webhook:  https://<your-domain>/api/ads/webhook   event: checkout.session.completed

const AD_TTL = 48 * 3600;      // seconds an ad stays live after payment
const MAX_LIVE = 6;            // ad slots
const BASE_CENTS = 500;        // price when nothing is live
const STEP_CENTS = 250;        // + this much per ad already live (demand pricing)
const MAX_CENTS = 3000;
const REQ_TTL = 30 * 24 * 3600;
const ADS_OPEN = false;   // flip to true to reopen

const enc = (s) => new TextEncoder().encode(s);
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc(s)));
const safeEq = (a, b) => a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
const priceFor = (n) => Math.min(MAX_CENTS, BASE_CENTS + STEP_CENTS * n);
const validId = (s) => /^[0-9a-f]{8}$/.test(String(s || ""));
const metaOf = (r) => ({ t: r.title.slice(0, 40), c: r.contact.slice(0, 40), ts: r.ts, st: r.status, p: r.cents || 0 });
const saveReq = (env, r) => env.FORMS.put("ad:req:" + r.id, JSON.stringify(r), { metadata: metaOf(r), expirationTtl: REQ_TTL });

// the live list is read from memory for 2 min so page loads don't burn KV list() calls (free plan: 1,000/day)
let liveMem = null;
async function liveAds(env, fresh) {
    if (!fresh && liveMem && Date.now() < liveMem.exp) return liveMem.ads;
    const l = await env.FORMS.list({ prefix: "ad:live:", limit: 50 });
    const ads = l.keys.map((k) => ({ id: k.name.slice(8), ...k.metadata }));
    liveMem = { ads, exp: Date.now() + 120000 };
    return ads;
}

async function ownRequest(env, id, key) {
    if (!validId(id) || !key) return null;
    const rec = await env.FORMS.get("ad:req:" + id, "json");
    if (!rec) return null;
    return hex(await sha(String(key))) === rec.kh ? rec : null;
}

/* ───────── public ───────── */
async function submit(request, env, d) {
    if (!ADS_OPEN) return d.json({ error: "advertising is closed for now" }, 503);
    if (!d.isSameOrigin(request)) return d.json({ error: "forbidden" }, 403);
    if (Number(request.headers.get("content-length") || 0) > 4096) return d.json({ error: "too large" }, 413);
    let body;
    try { body = await request.json(); } catch { return d.json({ error: "invalid json" }, 400); }
    if (d.clean(body?.website, 200)) return d.json({ ok: true, id: "00000000", key: "x" }); // honeypot

    const title = d.clean(body?.title, 40).replace(/\s+/g, " ");
    const text = d.clean(body?.text, 100).replace(/\s+/g, " ");
    const contact = d.clean(body?.contact, 120);
    let u;
    try { u = new URL(d.clean(body?.url, 200)); } catch { }
    if (title.length < 3) return d.json({ error: "title is too short" }, 400);
    if (text.length < 10) return d.json({ error: "describe your ad in a few more words" }, 400);
    if (!u || u.protocol !== "https:" || !u.hostname.includes(".")) return d.json({ error: "url must be a full https:// address" }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return d.json({ error: "enter a valid email (used for the Stripe receipt)" }, 400);
    if (d.blockedWord(title + " " + text) || d.hasLink(title + " " + text)) return d.json({ error: "no links or bad words in the title or text. put your link in the url box" }, 400);
    if (enc(JSON.stringify({ t: title, x: text, u: u.href })).length > 900) return d.json({ error: "ad is too long (non-english letters count extra)" }, 400);

    const rl = "rl:ad:" + d.clientIp(request);
    if (await env.FORMS.get(rl)) return d.json({ error: "one request per 10 minutes, try again later" }, 429);
    await env.FORMS.put(rl, "1", { expirationTtl: 600 });

    const id = crypto.randomUUID().slice(0, 8), key = crypto.randomUUID();
    await saveReq(env, { id, kh: hex(await sha(key)), title, text, url: u.href, contact, status: "pending", cents: 0, ts: Date.now() });
    return d.json({ ok: true, id, key });
}

async function status(env, url, d) {
    const rec = await ownRequest(env, url.searchParams.get("id"), url.searchParams.get("key"));
    if (!rec) return d.json({ error: "not found" }, 404);
    let st = rec.status;
    if (st === "paid" && rec.until < Date.now()) st = "expired";
    return d.json({ status: st, cents: rec.cents, title: rec.title, until: rec.until || 0 });
}

async function checkout(request, env, d) {
    if (!ADS_OPEN) return d.json({ error: "advertising is closed for now" }, 503);
    if (!d.isSameOrigin(request)) return d.json({ error: "forbidden" }, 403);
    if (!env.STRIPE_SECRET_KEY) return d.json({ error: "payments are not set up yet" }, 503);
    let body;
    try { body = await request.json(); } catch { return d.json({ error: "invalid json" }, 400); }
    const rec = await ownRequest(env, body?.id, body?.key);
    if (!rec) return d.json({ error: "not found" }, 404);
    if (rec.status !== "approved") return d.json({ error: "this ad isn't approved yet" }, 400);
    if ((await liveAds(env, true)).length >= MAX_LIVE) return d.json({ error: "all ad slots are taken right now, try again later" }, 409);

    const origin = new URL(request.url).origin;
    const form = new URLSearchParams({
        mode: "payment",
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(rec.cents),
        "line_items[0][price_data][product_data][name]": "silence ad · 48 hours",
        client_reference_id: rec.id,
        "metadata[adId]": rec.id,
        customer_email: rec.contact,
        success_url: origin + "/",
        cancel_url: origin + "/",
    });
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" },
        body: form,
    });
    const s = await r.json().catch(() => ({}));
    if (!r.ok || !s.url) { console.error("stripe", r.status, JSON.stringify(s.error || s)); return d.json({ error: "couldn't start checkout, try again" }, 502); }
    return d.json({ url: s.url });
}

// Stripe calls this after payment. Verified with the signing secret, so it can't be forged.
async function webhook(request, env, d) {
    if (!env.STRIPE_WEBHOOK_SECRET) return d.json({ error: "not configured" }, 503);
    const payload = await request.text();
    let t = "";
    const v1 = [];
    for (const p of (request.headers.get("stripe-signature") || "").split(",")) {
        const [k, v] = p.split("=");
        if (k === "t") t = v; else if (k === "v1") v1.push(v);
    }
    if (!t || !v1.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return d.json({ error: "bad signature" }, 400);
    const key = await crypto.subtle.importKey("raw", enc(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc(`${t}.${payload}`))));
    if (!v1.some((x) => safeEq(enc(x), enc(mac)))) return d.json({ error: "bad signature" }, 400);

    let ev;
    try { ev = JSON.parse(payload); } catch { return d.json({ error: "bad json" }, 400); }
    const s = ev?.data?.object;
    if (ev?.type === "checkout.session.completed" && s?.payment_status === "paid") {
        const id = s.metadata?.adId;
        const rec = validId(id) ? await env.FORMS.get("ad:req:" + id, "json") : null;
        if (!rec || rec.status === "paid") return d.json({ ok: true });                 // unknown or already handled
        if (rec.status !== "approved" || s.amount_total !== rec.cents) {
            console.error("ad payment needs a manual look", id, rec.status, s.amount_total, rec.cents);
            return d.json({ ok: true });
        }
        const until = Date.now() + AD_TTL * 1000;
        await env.FORMS.put("ad:live:" + id, JSON.stringify({ title: rec.title, text: rec.text, url: rec.url }), {
            metadata: { t: rec.title, x: rec.text, u: rec.url }, expirationTtl: AD_TTL,
        });
        await saveReq(env, { ...rec, status: "paid", until });
        liveMem = null;
    }
    return d.json({ ok: true });
}

export async function handleAds(request, env, url, d) {
    const p = url.pathname, m = request.method;
    if (p === "/api/ads/webhook" && m === "POST") return webhook(request, env, d);
    if (p === "/api/ads/live" && m === "GET") {
        const ads = await liveAds(env);
        return d.json({ ads: ads.map((a) => ({ id: a.id, t: a.t, x: a.x, u: a.u })), price: priceFor(ads.length), open: Math.max(0, MAX_LIVE - ads.length) }, 200, { "cache-control": "public, max-age=120" });
    }
    if (p === "/api/ads/submit" && m === "POST") return submit(request, env, d);
    if (p === "/api/ads/status" && m === "GET") return status(env, url, d);
    if (p === "/api/ads/checkout" && m === "POST") return checkout(request, env, d);
    return d.json({ error: "not found" }, 404);
}

/* ───────── admin (called from admin() in worker.js, token already checked) ─────────
   GET    /api/admin/ads              list requests
   GET    /api/admin/ads/<id>         one request
   POST   /api/admin/ads/<id>/approve {cents?}   sets the price (default: demand pricing)
   POST   /api/admin/ads/<id>/reject
   DELETE /api/admin/ads/<id>         removes it and takes a live ad down */
export async function adminAds(request, env, url, parts, d) {
    const id = parts[3], act = parts[4], m = request.method;
    if (!id) {
        if (m !== "GET") return d.json({ error: "method not allowed" }, 405);
        const l = await env.FORMS.list({ prefix: "ad:req:", limit: 100 });
        return d.json({ items: l.keys.map((k) => ({ id: k.name.slice(7), ...k.metadata })) });
    }
    if (!validId(id)) return d.json({ error: "bad id" }, 400);
    const rec = await env.FORMS.get("ad:req:" + id, "json");

    if (m === "DELETE") {
        await env.FORMS.delete("ad:req:" + id);
        await env.FORMS.delete("ad:live:" + id);
        liveMem = null;
        return d.json({ ok: true });
    }
    if (!rec) return d.json({ error: "not found" }, 404);
    if (m === "GET" && !act) { const { kh, ...pub } = rec; return d.json(pub); }

    if (m === "POST" && (act === "approve" || act === "reject")) {
        if (rec.status === "paid") return d.json({ error: "already paid and live, delete it to take it down" }, 400);
        if (act === "reject") { await saveReq(env, { ...rec, status: "rejected" }); return d.json({ ok: true }); }
        let body = {};
        try { body = await request.json(); } catch { }
        const asked = Math.floor(Number(body?.cents) || 0);
        const cents = asked >= 100 && asked <= 100000 ? asked : priceFor((await liveAds(env, true)).length);
        await saveReq(env, { ...rec, status: "approved", cents });
        return d.json({ ok: true, cents });
    }
    return d.json({ error: "not found" }, 404);
}