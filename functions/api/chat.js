const GEMINI_URL =
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MODEL = "gemini-3.5-flash-lite";
const SYSTEM = "You are a helpful, friendly assistant. Keep answers clear and concise.";

const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
    });

export async function onRequestPost({ request, env }) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) {
        return json({ error: "forbidden" }, 403);
    }
    if (!env.GEMINI_API_KEY) return json({ error: "not configured" }, 503);

    let body;
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