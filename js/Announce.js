/* silence · site-wide announcement banner
   Lives in the shell (index.html). Asks /api/announcement for the current message and
   shows it as a dismissible banner. Admins set it from the admin page.

   - never fetches or shows anything while the site is locked (disguise page)
   - dismissing remembers the announcement id, so a new announcement shows again
   - re-checks every 5 minutes while the tab is visible
*/
(() => {
    const SEEN = "silence:annSeen";
    const POLL = 5 * 60 * 1000;

    const locked = () => document.body.classList.contains("locked");
    const dismissed = () => { try { return localStorage.getItem(SEEN); } catch { return null; } };

    let bar = null, cur = null, last = 0;

    function css() {
        if (document.getElementById("sl-ann-css")) return;
        const s = document.createElement("style");
        s.id = "sl-ann-css";
        s.textContent = `
#sl-ann{position:fixed;top:92px;left:50%;transform:translateX(-50%);z-index:1000;display:flex;align-items:flex-start;gap:12px;
  width:min(560px,calc(100vw - 24px));padding:12px 14px 12px 16px;border-radius:14px;background:var(--panel);
  border:1px solid var(--accent);color:var(--fg);font:.86rem/1.5 var(--font);box-shadow:0 20px 50px -20px #000;
  animation:sl-ann-in .3s var(--ease)}
#sl-ann.warn{border-color:var(--warn,#f3b562)}
#sl-ann span{flex:1;overflow-wrap:anywhere}
#sl-ann button{flex:none;width:24px;height:24px;border-radius:50%;color:var(--muted);font-size:1.1rem;line-height:1;cursor:pointer;background:none;border:0}
#sl-ann button:hover{color:var(--fg)}
@keyframes sl-ann-in{from{opacity:0;transform:translate(-50%,-8px)}}`;
        document.head.append(s);
    }

    function hide() { bar?.remove(); bar = null; }

    function render(a) {
        hide(); css();
        bar = document.createElement("div");
        bar.id = "sl-ann";
        bar.className = a.level === "warn" ? "warn" : "";
        bar.setAttribute("role", "status");
        const t = document.createElement("span");
        t.textContent = a.text;                       // text only, nothing the admin types is ever parsed as html
        const x = document.createElement("button");
        x.type = "button"; x.setAttribute("aria-label", "dismiss"); x.textContent = "×";
        x.onclick = () => { try { localStorage.setItem(SEEN, a.id); } catch { } hide(); };
        bar.append(t, x);
        document.body.append(bar);
    }

    async function check() {
        try {
            const r = await fetch("/api/announcement");
            if (!r.ok || locked()) return;
            const d = await r.json();
            if (!d.text) { cur = null; hide(); return; }
            if (d.id === dismissed()) { cur = null; hide(); return; }
            if (cur && cur.id === d.id && bar) return;   // already showing
            cur = d; render(d);
        } catch { }
    }

    setInterval(() => {
        if (locked()) { hide(); cur = null; last = 0; return; }     // locked: remove it, ask for nothing
        if (!document.body.classList.contains("ready") || document.hidden) return;
        if (Date.now() - last < POLL) return;
        last = Date.now();
        check();
    }, 5000);
})();