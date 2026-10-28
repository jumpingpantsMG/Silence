/* silence · first-run setup. Replaces the old tour (Tour.js).
   Loaded by the shell (index.html). Runs in the shell and talks to window.silence.
   Shows once for new visitors (never while a disguise page is up), and again from
   settings -> "run setup". Every choice is saved and applied right away. */
(() => {
    const S = window.silence;
    if (!S) return;

    const DONE = "silence:setupDone";
    // already finished, or already saved some settings: don't show it automatically
    const seen = () => { try { return !!(localStorage.getItem(DONE) || localStorage.getItem("silence:settings")); } catch { return true; } };
    const markDone = () => { try { localStorage.setItem(DONE, "1"); } catch { } };

    const TITLES = [["tempo · typing test", "Tempo Type"], ["Lumen Study · Flashcards", "Lumen"], ["New Tab", "new tab"], ["Untitled document", "untitled"], ["Home", "home"], ["Notes", "notes"]];
    const ICON_LABELS = { none: "none", tempotype: "Tempo Type", lumen: "Lumen", document: "doc", folder: "folder", calendar: "cal", dot: "dot", classroom: "classroom", docs: "docs", drive: "drive" };
    const PANIC_SITES = [["https://www.google.com", "Google"], ["https://classroom.google.com", "Classroom"], ["https://docs.google.com", "Docs"], ["https://drive.google.com", "Drive"], ["https://www.wikipedia.org", "Wikipedia"]];
    const IDLE = [[0, "off"], [1, "1 min"], [2, "2 min"], [5, "5 min"], [10, "10 min"], [15, "15 min"], [30, "30 min"]];
    const KEY_HINT = "Pick something you never type, like ` or Esc.";

    const CSS = `
.sl-setup{position:fixed;inset:0;z-index:90;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.62);backdrop-filter:blur(6px);font-family:var(--font);color:var(--fg)}
.sl-setup *{box-sizing:border-box}
.sl-card{width:min(540px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:24px;border-radius:20px;background:var(--panel);border:1px solid var(--line);box-shadow:0 30px 80px -30px #000;outline:0}
.sl-top{display:flex;justify-content:space-between;align-items:center;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.sl-dots{display:flex;gap:5px}
.sl-dots i{width:18px;height:3px;border-radius:3px;background:color-mix(in srgb,var(--fg) 14%,transparent)}
.sl-dots i.on{background:var(--accent)}
.sl-card h2{margin:14px 0 4px;font-size:1.35rem;font-weight:400;letter-spacing:-.02em}
.sl-card .sub{margin:0 0 14px;color:var(--muted);font-size:.88rem;line-height:1.5}
.sl-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-top:1px solid var(--line)}
.sl-row.col{flex-direction:column;align-items:stretch;gap:10px}
.sl-row .t{font-size:.92rem}
.sl-row .d{margin-top:3px;font-size:.76rem;color:var(--muted);line-height:1.4}
.sl-list{margin:0 0 6px;padding-left:18px;color:var(--muted);font-size:.9rem;line-height:1.8}
.sl-seg{display:flex;flex-wrap:wrap;gap:4px}
.sl-seg button{padding:7px 13px;border-radius:999px;border:1px solid var(--line);background:none;color:var(--muted);font:inherit;font-size:.78rem;cursor:pointer}
.sl-seg button:hover{color:var(--fg)}
.sl-seg button.on{background:var(--fg);border-color:var(--fg);color:var(--bg)}
.sl-swatches{display:flex;flex-wrap:wrap;gap:10px}
.sl-swatch{width:34px;height:34px;border-radius:50%;border:2px solid transparent;cursor:pointer}
.sl-swatch[aria-pressed=true]{border-color:var(--fg);box-shadow:0 0 0 3px var(--panel) inset}
.sl-sw{position:relative;display:inline-block;flex:none;width:44px;height:26px}
.sl-sw input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;z-index:1}
.sl-sw span{position:absolute;inset:0;border-radius:999px;background:color-mix(in srgb,var(--fg) 8%,transparent);border:1px solid color-mix(in srgb,var(--fg) 18%,transparent);transition:.2s}
.sl-sw span::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--muted);transition:.2s}
.sl-sw input:checked+span{background:color-mix(in srgb,var(--accent) 30%,transparent);border-color:var(--accent)}
.sl-sw input:checked+span::after{transform:translateX(18px);background:var(--fg)}
.sl-setup input[type=text],.sl-setup select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit;font-size:.88rem;outline:0}
.sl-setup select{width:auto}
.sl-setup input[type=text]:focus,.sl-setup select:focus{border-color:var(--accent)}
.sl-nav{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
.sl-left{display:flex;align-items:center;gap:6px}
.sl-btn{height:38px;padding:0 18px;border-radius:999px;border:1px solid color-mix(in srgb,var(--fg) 18%,transparent);background:none;color:var(--fg);font:inherit;font-size:.82rem;cursor:pointer}
.sl-btn:hover{border-color:var(--accent)}
.sl-btn.sm{height:32px;padding:0 14px;font-size:.78rem}
.sl-btn.main{background:var(--fg);border-color:var(--fg);color:var(--bg);font-weight:500}
.sl-btn.link{border-color:transparent;color:var(--muted)}
.sl-btn.link:hover{color:var(--fg)}
@media (prefers-reduced-motion:reduce){.sl-sw span,.sl-sw span::after{transition:none}}
`;

    /* ── tiny helpers ── */
    const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const btn = (label, cls, fn) => { const b = h("button", "sl-btn " + cls, label); b.type = "button"; b.onclick = fn; return b; };
    const get = () => S.read();
    const set = patch => { S.write({ ...S.read(), ...patch }); S.apply(); };

    const seg = (opts, val, pick) => {
        const box = h("div", "sl-seg");
        for (const [v, label] of opts) {
            const b = h("button", v === val ? "on" : "", label);
            b.type = "button";
            b.onclick = () => pick(v);
            box.append(b);
        }
        return box;
    };
    const toggle = (on, change) => {
        const l = h("label", "sl-sw"), i = h("input"), s = h("span");
        i.type = "checkbox"; i.checked = !!on;
        i.onchange = () => change(i.checked);
        l.append(i, s);
        return l;
    };
    const row = (title, desc, control, stack) => {
        const r = h("div", "sl-row" + (stack ? " col" : "")), t = h("div");
        t.append(h("div", "t", title));
        if (desc) t.append(h("div", "d", desc));
        r.append(t, control);
        return r;
    };

    /* ── state ── */
    let root = null, card = null, step = 0, capturing = false, keyBtnRef = null, keyHintRef = null;

    function upd(patch) { set(patch); paint(); }

    /* ── steps ── */
    const STEPS = [
        {
            t: "set up silence", d: "a few quick choices. everything applies right away, and you can change it all later in settings.",
            body() {
                const ul = h("ul", "sl-list");
                for (const x of ["look: theme and colors", "tab: title and icon", "panic: key and where it sends you", "hiding: about:blank and auto-lock"]) ul.append(h("li", null, x));
                return [ul];
            },
        },
        {
            t: "look", d: "pick a theme and an accent color.",
            body() {
                const c = get();
                const sw = h("div", "sl-swatches");
                for (const [k, [a, b]] of Object.entries(S.presets)) {
                    const x = h("button", "sl-swatch");
                    x.type = "button"; x.title = k;
                    x.style.background = `linear-gradient(135deg, ${a}, ${b})`;
                    x.setAttribute("aria-pressed", String(c.accent === k));
                    x.onclick = () => upd({ accent: k });
                    sw.append(x);
                }
                return [
                    row("Theme", "", seg([["dark", "dark"], ["light", "light"]], c.theme, v => upd({ theme: v }))),
                    row("Accent", "", sw, true),
                    row("Card size", "How big the game tiles are.", seg(["compact", "comfortable", "large"].map(d => [d, d]), c.density, v => upd({ density: v })), true),
                ];
            },
        },
        {
            t: "tab", d: "change what the browser tab shows.",
            body() {
                const c = get();
                const inp = h("input");
                inp.type = "text"; inp.maxLength = 60; inp.placeholder = "custom title"; inp.value = c.title;
                inp.oninput = () => set({ title: inp.value });
                const icons = S.icons.filter(k => ICON_LABELS[k]).map(k => [k, ICON_LABELS[k]]);
                return [
                    row("Tab title", "", seg(TITLES, c.title, v => upd({ title: v })), true),
                    row("Custom title", "", inp, true),
                    row("Tab icon", "More options, including your own image, are in settings.", seg(icons, c.icon, v => upd({ icon: v })), true),
                ];
            },
        },
        {
            t: "panic", d: "one key that instantly locks the site and sends this tab somewhere boring.",
            body() {
                const c = get();
                const out = [row("Panic key", "", toggle(c.panicOn, v => upd({ panicOn: v })))];
                if (c.panicOn) {
                    const kb = h("button", "sl-btn sm", S.keyLabel(c.panicKey));
                    kb.type = "button";
                    const kr = row("Key", KEY_HINT, kb);
                    keyBtnRef = kb; keyHintRef = kr.querySelector(".d");
                    kb.onclick = () => { capturing = true; kb.textContent = "press a key…"; keyHintRef.textContent = "click away to cancel."; };
                    kb.onblur = () => { if (capturing) { capturing = false; kb.textContent = S.keyLabel(get().panicKey); keyHintRef.textContent = KEY_HINT; } };
                    out.push(kr);
                }
                const url = h("input");
                url.type = "text"; url.maxLength = 300; url.placeholder = "https://www.google.com"; url.spellcheck = false; url.value = c.panicUrl;
                url.onchange = () => { set({ panicUrl: url.value }); paint(); };
                out.push(
                    row("Go to", "", seg(PANIC_SITES, c.panicUrl, v => upd({ panicUrl: v })), true),
                    row("Custom address", "Any https:// address. Press enter to save.", url, true),
                    row("On-screen button", "A small dim × in the bottom-left corner.", toggle(c.panicBtn, v => upd({ panicBtn: v }))),
                );
                return out;
            },
        },
        {
            t: "hiding", d: "keep what's on your screen low-key.",
            body() {
                const c = get();
                const open = btn("open", "sm", () => {
                    markDone();                                  // this tab may be sent away, so don't ask again
                    if (!S.cloak()) open.textContent = "allow pop-ups";
                });
                const sel = h("select");
                for (const [v, l] of IDLE) { const o = h("option", null, l); o.value = v; sel.append(o); }
                sel.value = String(c.idleMin);
                sel.onchange = () => upd({ idleMin: Number(sel.value) });
                return [
                    row("Open in about:blank", "Opens the site in a window with a blank address. Allow pop-ups if nothing happens.", open),
                    row("Open in about:blank automatically", "On your first click or key press when you visit. Takes effect next time you open the site.", toggle(c.autoCloak, v => upd({ autoCloak: v }))),
                    row("Send this tab away after", "When opening in about:blank, this tab goes to your panic page.", toggle(c.cloakRedirect, v => upd({ cloakRedirect: v }))),
                    row("Lock when I leave the tab", "Switching tabs or minimising locks the site.", toggle(c.lockHidden, v => upd({ lockHidden: v }))),
                    row("Auto-lock when idle", "Locks after no mouse or keyboard activity.", sel),
                ];
            },
        },
        {
            t: "all set", d: "here's a quick recap.",
            body() {
                const c = get();
                let host = c.panicUrl;
                try { host = new URL(c.panicUrl).hostname; } catch { }
                const ul = h("ul", "sl-list");
                ul.append(
                    h("li", null, c.panicOn ? `panic key: ${S.keyLabel(c.panicKey)} (goes to ${host})` : "panic key: off"),
                    h("li", null, "lock any time: Alt + Shift + L"),
                    h("li", null, "change anything later in settings, or run setup again from there"),
                );
                return [ul];
            },
        },
    ];

    /* ── render ── */
    function go(n) { step = n; capturing = false; paint(); if (card) card.scrollTop = 0; }

    function paint() {
        if (!card) return;
        const s = STEPS[step], last = step === STEPS.length - 1, keep = card.scrollTop;

        const top = h("div", "sl-top"), dots = h("div", "sl-dots");
        STEPS.forEach((_, i) => dots.append(h("i", i <= step ? "on" : "")));
        top.append(h("span", null, `step ${step + 1} of ${STEPS.length}`), dots);

        const nav = h("div", "sl-nav"), left = h("div", "sl-left");
        if (step > 0) left.append(btn("back", "", () => go(step - 1)));
        if (!last) left.append(btn("skip setup", "link", () => { markDone(); close(); }));
        nav.append(left, btn(last ? "finish" : "next", "main", () => { if (last) { markDone(); close(); } else go(step + 1); }));

        card.replaceChildren(top, h("h2", null, s.t), h("p", "sub", s.d), ...s.body(), nav);
        card.scrollTop = keep;
    }

    // while "press a key" is active, swallow the key so the shell's panic hotkey doesn't fire
    function onKey(e) {
        if (!root || !capturing) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (!S.keyOk(e.code)) { if (keyHintRef) keyHintRef.textContent = "that's a key you type with. try ` , Esc, \\ or an F-key."; return; }
        capturing = false;
        upd({ panicKey: e.code });
    }

    function open() {
        if (root) return;
        step = 0; capturing = false;
        root = h("div", "sl-setup");
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-modal", "true");
        root.setAttribute("aria-label", "setup");
        const st = document.createElement("style");
        st.textContent = CSS;
        card = h("div", "sl-card");
        card.tabIndex = -1;
        root.append(st, card);
        document.body.append(root);
        addEventListener("keydown", onKey, true);
        paint();
        card.focus();
    }

    function close() {
        removeEventListener("keydown", onKey, true);
        root?.remove();
        root = card = null;
        capturing = false;
    }

    /* ── when to show it ── */
    function maybe() {
        if (root && !root.isConnected) close();          // the shell swept it (lock / panic)
        if (root || seen()) return;
        const b = document.body.classList;
        if (b.contains("locked") || !b.contains("ready")) return;   // never over a disguise page or the loader
        open();
    }
    new MutationObserver(maybe).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    maybe();

    S.setup = () => { if (!root) open(); };              // settings page: "run setup"
})();
