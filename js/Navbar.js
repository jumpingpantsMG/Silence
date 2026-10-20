const navbar = `<header>
    <div class="wrap">
        <nav>
            <a class="logo" href="../index.html">
                <img src="../Silence-logo.png" alt="Silence" />
            </a>

            <div class="links">
                <a href="index.html">games</a>
                <a href="soundboard.html">soundboard</a>
                <a href="ai.html">ai</a>
                <a href="forms.html">forms</a>
                <a href="chat.html">chat</a>
                <a href="about.html">about</a>
                <a href="settings.html">settings</a>
            </div>
        </nav>
    </div>
</header>`

function createUpdateOverlay() {
    const overlay = document.createElement("div");
    overlay.id = "update-overlay";
    overlay.className = "update-overlay";
    overlay.style.display = "none";

    overlay.innerHTML = `
        <div class="update-content" style="max-width:380px;padding:1.5rem 2rem;">
            <div class="update-header" style="border-bottom:none;padding-bottom:0;margin-bottom:1rem;">
                <span style="font-family:monospace;font-size:11px;color:var(--accent);letter-spacing:0.1em;text-transform:uppercase;" id="update-title">No title has been provided</span>
            </div>
            <p class="update-body" id="update-body">No description has been provided.</p>
            <div class="update-actions" style="justify-content:flex-start;margin-top:1.25rem;">
                <button class="update-btn" style="width:100%;" id="update-confirm">Ok</button>
            </div>
			<p class="update-meta" id="update-meta" style="margin-top:0.75rem;color:rgba(255,255,255,0.45);font-size:9px;">Unknown author</p>
        </div>
		`;

    document.body.appendChild(overlay);
}

document.addEventListener("DOMContentLoaded", async () => {
    const fragment = document.createRange().createContextualFragment(navbar);

    // the shell tags each iframe with its own page name (data-page)
    const page = window.frameElement?.dataset.page;

    if (page) {
        const link = fragment.querySelector(`.links a[href="${page}.html"]`);
        if (link) link.classList.add("on");
    }

    document.body.prepend(fragment);
    const credit = document.createElement("div");
    credit.className = "credit";
    credit.innerHTML = 'made by <a href="https://github.com/jumpingpantsmg/Silence" target="_blank" rel="noopener">jumpingpantsmg</a>';
    document.body.append(credit);

    const commits = await window.parent.checkforupdates();
    const latest = commits[0];
    const latestSha = latest.sha;
    const seenSha = localStorage.getItem('last_seen_commit');

    if (seenSha === latestSha) return;

    const fullMessage = latest.commit.message || '';
    const nlIdx = fullMessage.indexOf('\n');
    const title = nlIdx > -1 ? fullMessage.slice(0, nlIdx).trim() : fullMessage.trim();
    const body = nlIdx > -1 ? fullMessage.slice(nlIdx).trim() : '';

    const authorName = latest.commit.author?.name || 'Unknown';
    const dateRaw = latest.commit.author?.date || '';
    const dateFormatted = dateRaw ? new Date(dateRaw).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    const shortSha = latestSha.slice(0, 7);

    if (!document.getElementById('update-overlay')) {
        createUpdateOverlay();
    }

    document.getElementById('update-title').textContent = title || 'Untitled update';
    document.getElementById('update-body').innerHTML = body
        ? parseMarkdown(body)
        : '<p style="color:var(--text-dim); font-style:italic;">No extended description provided.</p>';
    document.getElementById('update-meta').innerHTML =
        `<span> ${shortSha}</span> &nbsp;·&nbsp; ${authorName} &nbsp;·&nbsp; ${dateFormatted} `;

    document.getElementById('update-overlay').dataset.sha = latestSha;
    document.getElementById('update-overlay').style.display = 'flex';

    document.getElementById('update-confirm').onclick = () => {
        const overlay = document.getElementById('update-overlay');
        const sha = overlay.dataset.sha;
        if (sha) localStorage.setItem('last_seen_commit', sha);
        overlay.style.display = 'none';
    }
});

(() => {
    const SKIP = ["chat", "disguise"];              // pages that must not show popups
    let page = "";
    try { page = window.frameElement?.dataset.page || ""; } catch { }
    if (SKIP.includes(page) || SKIP.some(p => location.pathname.includes(p))) return;

    const POLL_MS = 10000;                          // visible tab: one cheap request every 10s
    const IDLE_MS = 60 * 60 * 1000;                 // stop after 1h without any activity on the page

    let origin = location.origin;
    try { origin = window.parent.location.origin; } catch { }
    const API = origin + "/api/global";

    const read = (st, k, d) => { try { const v = JSON.parse(st.getItem(k)); return v ?? d; } catch { return d; } };
    const write = (st, k, v) => { try { st.setItem(k, JSON.stringify(v)); } catch { } };

    let v = "", timer = null, busy = false, fails = 0, stopped = false, lastActive = Date.now();

    /* ---- popup ui ---- */
    function ensureUi() {
        if (!document.getElementById("sl-pops-css")) {
            const s = document.createElement("style");
            s.id = "sl-pops-css";
            s.textContent = `
                #sl-pops{position:fixed;top:70px;right:14px;z-index:99990;display:flex;flex-direction:column;gap:8px;width:min(320px,calc(100vw - 28px));pointer-events:none}
                .sl-pop{pointer-events:auto;cursor:pointer;background:#17171c;color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:9px 12px;box-shadow:0 8px 28px rgba(0,0,0,.5);animation:sl-in .18s ease-out;overflow-wrap:anywhere;font:14px/1.35 system-ui,sans-serif}
                .sl-pop b{display:block;font-size:11px;opacity:.7;margin-bottom:2px}
                .sl-pop span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
                @keyframes sl-in{from{opacity:0;transform:translateY(-8px)}}`;
            document.head.append(s);
        }
        let box = document.getElementById("sl-pops");
        if (!box) { box = document.createElement("div"); box.id = "sl-pops"; document.body.append(box); }
        return box;
    }

    function popup(m, room) {
        const box = ensureUi();
        const el = document.createElement("div");
        el.className = "sl-pop";
        const b = document.createElement("b");
        b.textContent = (m.a ? "[admin] " : "") + m.n + " · " + (room === "general" ? "global chat" : "room");
        const s = document.createElement("span");
        s.textContent = m.t || "sent a file: " + (m.f?.name || "");
        el.append(b, s);
        const close = () => el.remove();
        el.onclick = () => {                                    // open the chat page, straight into that room
            write(sessionStorage, "silence:chatOpen", room);
            document.querySelector('.links a[href="chat.html"]')?.click();
            close();
        };
        box.append(el);
        while (box.children.length > 3) box.firstChild.remove();
        setTimeout(close, 5000);
    }

    function announce(list, room, mode) {
        for (const m of list.slice(-3)) {
            popup(m, room);
            if (mode === "system" && "Notification" in window && Notification.permission === "granted" && (document.hidden || !document.hasFocus())) {
                try { new Notification(m.n + " · silence chat", { body: m.t || "sent a file", tag: "silence-chat" }); } catch { }
            }
        }
    }

    /* ---- polling ---- */
    const mode = () => read(localStorage, "silence:chatAlerts", "popups");   // popups | system | off

    async function poll() {
        timer = null;
        if (busy || stopped) return;
        busy = true;
        try {
            const token = read(sessionStorage, "silence:chatToken", "");
            if (!token || mode() === "off") return;                          // not signed in to chat, or alerts off: no requests

            let room = read(sessionStorage, "silence:chatWatch", "general");
            if (room && typeof room === "object") room = room.id;           // tolerate the old object format
            if (typeof room !== "string" || !room) room = "general";
            const me = read(sessionStorage, "silence:chatUser", "");
            const headers = { authorization: "Bearer " + token };
            const pass = read(sessionStorage, "silence:roomPass", {})[room];
            if (pass) headers["x-room-pass"] = encodeURIComponent(pass);

            const res = await fetch(`${API}/rooms/${encodeURIComponent(room)}/messages?v=${encodeURIComponent(v)}`, { headers });
            if (res.status === 401) { stopped = true; return; }              // session ended (sign in on the chat page again)
            if (res.status === 403 || res.status === 404) {                  // room deleted or no longer allowed
                write(sessionStorage, "silence:chatWatch", "general"); v = ""; return;
            }
            if (!res.ok) throw new Error("bad status");
            const d = await res.json();
            fails = 0;
            if (d.same) return;
            v = d.v;

            const items = d.items || [];
            const newest = items.reduce((x, m) => Math.max(x, m.ts), 0);
            const since = read(sessionStorage, "silence:popSince", null);    // {r: room, t: newest message time already seen}
            write(sessionStorage, "silence:popSince", { r: room, t: Math.max(newest, since && since.r === room ? since.t : 0) });
            if (!since || since.r !== room) return;                          // first look at this room: learn the time, no popups

            const muted = new Set(read(localStorage, "silence:chatMuted", []));
            const hidden = new Set(read(localStorage, "silence:chatHidden", []));
            const fresh = items.filter(m => m.ts > since.t && m.n !== me && (m.a || !muted.has(m.n.toLowerCase())) && !hidden.has(m.id));
            if (fresh.length) announce(fresh, room, mode());
        } catch { fails++; }
        finally { busy = false; schedule(); }
    }

    function schedule() {
        clearTimeout(timer); timer = null;
        if (stopped || Date.now() - lastActive > IDLE_MS) return;
        const md = mode();
        if (document.hidden && md !== "system") return;                      // hidden tabs only poll for system notifications
        const base = !read(sessionStorage, "silence:chatToken", "") || md === "off" ? 30000 : document.hidden ? 15000 : POLL_MS;
        timer = setTimeout(poll, Math.min(base * (1 + fails), 60000));
    }

    document.addEventListener("visibilitychange", () => { if (!document.hidden && !busy) { clearTimeout(timer); poll(); } else schedule(); });
    for (const ev of ["pointerdown", "keydown", "pointermove"]) {
        document.addEventListener(ev, () => { lastActive = Date.now(); if (!timer && !busy && !stopped) schedule(); }, { passive: true, capture: true });
    }
    timer = setTimeout(poll, 1500);
})();

(() => {
    // pages that get NO banner (player is yours; disguise must stay clean; chat/admin hold login tokens)
    const NO_ADS = ["player", "disguise", "admin", "chat"];
    let page = "";
    try { page = window.frameElement?.dataset.page || ""; } catch { }
    if (NO_ADS.includes(page) || NO_ADS.some(p => location.pathname.includes(p))) return;

    const ZONE_SRC = "https://bauval.org/21/7452e0aee68c2ce01139e82c3dd4bba3";
    const ZONE_ID = "container-7452e0aee68c2ce01139e82c3dd4bba3";

    document.addEventListener("DOMContentLoaded", () => {
        if (document.getElementById(ZONE_ID)) return;            // never two on one page

        const slot = document.createElement("div");
        slot.className = "ad-slot";
        slot.style.cssText = "margin:24px auto;padding:0 16px;max-width:900px;min-height:90px;";
        const box = document.createElement("div");
        box.id = ZONE_ID;
        slot.append(box);
        const credit = document.querySelector(".credit");
        credit ? credit.before(slot) : document.body.append(slot);

        // pages are preloaded hidden, so only load the ad once this page is the one on screen
        let done = false;
        const load = () => {
            if (done) return;
            let visible = true;
            try { visible = window.parent.currentpage === (page || "index"); } catch { }
            if (!visible) return;
            done = true;
            clearInterval(t);
            const s = document.createElement("script");
            s.async = true;
            s.dataset.cfasync = "false";
            s.src = ZONE_SRC;
            document.body.append(s);
        };
        const t = setInterval(load, 800);
        load();
    });
})();