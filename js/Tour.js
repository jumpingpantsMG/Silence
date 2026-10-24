/* silence · first-visit site tour
   Lives in the shell (index.html), not in a page iframe, so it can dim the whole
   screen and walk across pages. Targets are looked up inside the visible page
   iframe; page iframes fill the viewport at 0,0, so their rects are screen rects.

   - auto-starts once, after unlock, when the page has settled and no update popup is open
   - never runs while locked (disguise page); locking mid-tour closes it without marking it done
   - replay:  window.silence.tour.start()   (settings page has a button for it)
   - reset:   localStorage.removeItem("silence:tourDone")
*/
(() => {
    const KEY = "silence:tourDone";
    const Z = 2147483000;

    const STEPS = [
        {
            page: "index", title: "welcome to silence",
            text: "a quick 30-second look around. use the arrow keys or the buttons. esc skips."
        },
        {
            page: "index", target: ".search", title: "find a game",
            text: "type to search. press / anywhere on this page to jump straight here."
        },
        {
            page: "index", target: "#chips", title: "filter",
            text: "html5 games run natively. flash games run through an emulator."
        },
        {
            page: "index", target: ".card", title: "play",
            text: "click a card to launch it. back or esc leaves the game. reload and fullscreen are in the top bar."
        },
        {
            target: '.links a[href="soundboard.html"]', title: "soundboard",
            text: "a pad-based soundboard with its own recorder."
        },
        {
            target: '.links a[href="ai.html"]', title: "ai",
            text: "free, no account. chats stay in your browser."
        },
        {
            target: '.links a[href="forms.html"]', title: "forms",
            text: "request a game, report a bug, or leave feedback."
        },
        {
            target: '.links a[href="chat.html"]', title: "chat",
            text: "global chat and rooms. pick a username, no links, be kind."
        },
        {
            page: "settings", target: "#key", title: "panic key",
            text: () => {
                let k = "`";
                try { k = window.silence.keyLabel(window.silence.read().panicKey); } catch { }
                return `press ${k} anywhere to lock the site and send this tab somewhere boring. you can change the key and the destination here.`;
            }
        },
        {
            page: "settings", target: "#lock", title: "lock",
            text: "lock goes back to the typing test without leaving. shortcut: alt + shift + L."
        },
        {
            page: "index", title: "that's it",
            text: "you can replay this tour from settings any time. have fun."
        },
    ];

    const locked = () => document.body.classList.contains("locked");
    const seen = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return true; } };
    const mark = () => { try { localStorage.setItem(KEY, "1"); } catch { } };
    const frameDoc = () => {
        try { return document.querySelector("#stage .page-frame.on")?.contentDocument || null; } catch { return null; }
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /* ───────── styles ───────── */
    function css() {
        if (document.getElementById("sl-tour-css")) return;
        const s = document.createElement("style");
        s.id = "sl-tour-css";
        s.textContent = `
#sl-tour{position:fixed;inset:0;z-index:${Z};font-family:var(--font)}
#sl-tour .tr-block{position:absolute;inset:0;transition:background .25s}
#sl-tour.nospot .tr-block{background:rgba(0,0,0,.66)}
#sl-tour .tr-spot{position:absolute;border-radius:14px;pointer-events:none;border:2px solid var(--accent);
  box-shadow:0 0 0 100vmax rgba(0,0,0,.66),0 0 28px color-mix(in srgb,var(--accent) 50%,transparent);
  transition:left .3s var(--ease),top .3s var(--ease),width .3s var(--ease),height .3s var(--ease),opacity .2s}
#sl-tour.nospot .tr-spot{opacity:0}
#sl-tour .tr-card{position:absolute;width:min(340px,calc(100vw - 24px));padding:18px 20px 16px;border-radius:18px;
  background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.01)),var(--panel);
  border:1px solid var(--line-2,rgba(255,255,255,.15));color:var(--fg);box-shadow:0 30px 80px -20px #000;
  transition:left .3s var(--ease),top .3s var(--ease),opacity .2s}
#sl-tour .tr-card.wait{opacity:0}
#sl-tour .tr-step{font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
#sl-tour h3{margin:6px 0 6px;font-size:1.05rem;font-weight:500;letter-spacing:-.01em}
#sl-tour p{margin:0;font-size:.86rem;line-height:1.55;color:color-mix(in srgb,var(--fg) 80%,transparent)}
#sl-tour .tr-row{display:flex;align-items:center;gap:8px;margin-top:16px}
#sl-tour .tr-grow{flex:1}
#sl-tour button{font:inherit;font-size:.78rem;height:34px;padding:0 14px;border-radius:999px;cursor:pointer;
  color:var(--fg);background:rgba(255,255,255,.04);border:1px solid var(--line-2,rgba(255,255,255,.15));transition:.2s}
#sl-tour button:hover{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent)}
#sl-tour button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#sl-tour .tr-skip{border-color:transparent;background:none;color:var(--muted);padding:0 6px}
#sl-tour .tr-next{background:var(--fg);color:#0a0a0c;border-color:var(--fg);font-weight:500}
#sl-tour .tr-next:hover{background:#fff;border-color:#fff}
#sl-tour .tr-back[hidden]{display:none}`;
        document.head.append(s);
    }

    /* ───────── state ───────── */
    let root = null, ui = null, idx = 0, run = 0, target = null, active = false;
    let raf = 0, lastKey = "";
    function track() {
        if (!active) return;
        if (target && target.isConnected) {
            const b = target.getBoundingClientRect();
            const k = [b.left, b.top, b.width, b.height, innerWidth, innerHeight].join();
            if (k !== lastKey) { lastKey = k; place(); }
        }
        raf = requestAnimationFrame(track);
    }

    const goto = name => new Promise(done => {
        if (window.currentpage !== name || !frameDoc()) {
            location.replace(location.pathname + location.search + (name === "index" ? "#/" : "#/" + name));
        }
        const t0 = Date.now();
        (function tick() {
            const d = frameDoc();
            if ((window.currentpage === name && d && d.readyState === "complete" && !document.body.classList.contains("busy")) || Date.now() - t0 > 6000) return done();
            setTimeout(tick, 100);
        })();
    });

    async function waitFor(sel, ms) {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            const el = frameDoc()?.querySelector(sel);
            if (el) {
                const b = el.getBoundingClientRect();
                if (b.width && b.height) return el;
            }
            await sleep(100);
        }
        return null;
    }

    /* ───────── layout ───────── */
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    function place() {
        if (!root) return;
        const card = ui.card, spot = ui.spot;
        let r = null;
        if (target && target.isConnected) {
            const b = target.getBoundingClientRect();
            if (b.width && b.height) r = b;
        }
        root.classList.toggle("nospot", !r);
        const vw = innerWidth, vh = innerHeight, cw = card.offsetWidth, ch = card.offsetHeight;
        if (!r) {
            card.style.left = (vw - cw) / 2 + "px";
            card.style.top = (vh - ch) / 2 + "px";
            return;
        }
        const p = 8;
        spot.style.left = r.left - p + "px";
        spot.style.top = r.top - p + "px";
        spot.style.width = r.width + p * 2 + "px";
        spot.style.height = r.height + p * 2 + "px";
        let top = r.bottom + p + 14;
        if (top + ch > vh - 12) top = r.top - p - 14 - ch;           // no room below: go above
        if (top < 12) top = clamp((vh - ch) / 2, 12, vh - ch - 12);  // no room either way: center
        card.style.top = top + "px";
        card.style.left = clamp(r.left + r.width / 2 - cw / 2, 12, vw - cw - 12) + "px";
    }

    async function show(i) {
        const my = ++run;
        idx = i;
        const s = STEPS[i];
        ui.card.classList.add("wait");
        if (s.page) await goto(s.page);
        if (my !== run || !root) return;
        target = s.target ? await waitFor(s.target, 3000) : null;
        if (my !== run || !root) return;
        try { target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); } catch { }
        await sleep(60);
        ui.count.textContent = `${i + 1} / ${STEPS.length}`;
        ui.title.textContent = s.title;
        ui.text.textContent = typeof s.text === "function" ? s.text() : s.text;
        ui.back.hidden = i === 0;
        ui.next.textContent = i === STEPS.length - 1 ? "done" : "next";
        place();
        ui.card.classList.remove("wait");
        ui.next.focus({ preventScroll: true });   // the page swap hands focus to the iframe; take it back
    }

    const next = () => (idx >= STEPS.length - 1 ? end(true) : show(idx + 1));
    const back = () => idx > 0 && show(idx - 1);

    function onKey(e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "Escape") { e.preventDefault(); end(true); }
        else if (e.key === "ArrowRight") { e.preventDefault(); next(); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    }

    /* ───────── lifecycle ───────── */
    function start() {
        if (active || locked()) return false;
        css();
        active = true;
        root = document.createElement("div");
        root.id = "sl-tour";
        root.innerHTML =
            '<div class="tr-block"></div><div class="tr-spot"></div>' +
            '<div class="tr-card wait" role="dialog" aria-live="polite">' +
            '<div class="tr-step"></div><h3></h3><p></p>' +
            '<div class="tr-row"><button type="button" class="tr-skip">skip</button><span class="tr-grow"></span>' +
            '<button type="button" class="tr-back">back</button><button type="button" class="tr-next">next</button></div></div>';
        document.body.append(root);
        const q = s => root.querySelector(s);
        ui = { spot: q(".tr-spot"), card: q(".tr-card"), count: q(".tr-step"), title: q("h3"), text: q("p"), back: q(".tr-back"), next: q(".tr-next") };
        q(".tr-skip").onclick = () => end(true);
        ui.back.onclick = back;
        ui.next.onclick = next;
        addEventListener("keydown", onKey, true);
        addEventListener("resize", place);
        show(0);
        raf = requestAnimationFrame(track);
        return true;
    }

    function end(markDone) {
        if (!active) return;
        active = false;
        run++;
        cancelAnimationFrame(raf);
        removeEventListener("keydown", onKey, true);
        removeEventListener("resize", place);
        root?.remove();
        root = ui = target = null;
        if (markDone) mark();
    }

    // locking mid-tour (panic, alt+shift+L, tab hidden) closes it without marking it done
    new MutationObserver(() => { if (active && locked()) end(false); })
        .observe(document.body, { attributes: true, attributeFilter: ["class"] });

    /* ───────── auto-start ───────── */
    // the page must be settled for ~3s (loader gone, unlocked, no update popup open) before we start
    let stable = 0;
    const auto = setInterval(() => {
        if (seen()) return clearInterval(auto);
        const d = frameDoc();
        const up = d?.getElementById("update-overlay");
        const ok = !active && !locked() && document.body.classList.contains("ready") &&
            window.currentpage !== "disguise" && d && d.readyState === "complete" &&
            !(up && up.style.display !== "none");
        stable = ok ? stable + 1 : 0;
        if (stable >= 3) { clearInterval(auto); start(); }
    }, 1000);

    window.silence = window.silence || {};
    window.silence.tour = { start, stop: () => end(false), reset: () => { try { localStorage.removeItem(KEY); } catch { } } };
})();