/* silence · first-run setup. Replaces the old tour (Tour.js).
   Loaded by the shell (index.html). Runs in the shell and talks to window.silence.
   Shows once for new visitors, never over a disguise page, and never until the
   "go to silence" prompt is finished. Also runs again from settings -> "run setup".
   Every choice is saved and applied right away. */
(() => {
    const S = window.silence;
    if (!S) return;

    const DONE = "silence:setupDone";
    // already finished, or already saved some settings: don't show it automatically
    const seen = () => { try { return !!(localStorage.getItem(DONE) || localStorage.getItem("silence:settings")); } catch { return true; } };
    const markDone = () => { try { localStorage.setItem(DONE, "1"); } catch { } };

    const TITLES = [["tempo · typing test", "Tempo Type"], ["Wordle", "Wordle"], ["New Tab", "new tab"], ["Untitled document", "untitled"], ["Home", "home"], ["Notes", "notes"]];
    const ICON_LABELS = { none: "none", tempotype: "Tempo Type", wordle: "Wordle", document: "doc", folder: "folder", calendar: "cal", dot: "dot", classroom: "classroom", docs: "docs", drive: "drive" };
    const PANIC_SITES = [["https://www.google.com", "Google"], ["https://classroom.google.com", "Classroom"], ["https://docs.google.com", "Docs"], ["https://drive.google.com", "Drive"], ["https://www.wikipedia.org", "Wikipedia"]];
    const IDLE = [[0, "off"], [1, "1 min"], [2, "2 min"], [5, "5 min"], [10, "10 min"], [15, "15 min"], [30, "30 min"]];
    const BGS = [["none", "none"], ["aurora", "aurora"], ["sunset", "sunset"], ["ocean", "ocean"], ["midnight", "midnight"]];
    const KEY_HINT = "Pick something you never type, like ` or Esc.";

    const CSS = `
.sl-setup{position:fixed;inset:0;z-index:90;display:grid;place-items:center;padding:16px;font-family:var(--font);color:var(--fg);
  background:radial-gradient(700px circle at 50% 30%,color-mix(in srgb,var(--accent) 18%,transparent),transparent 65%),rgba(0,0,0,.66);backdrop-filter:blur(8px);animation:sl-fade .3s ease both}
.sl-setup *{box-sizing:border-box}
.sl-card{position:relative;width:min(560px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:0 26px 22px;border-radius:22px;background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.01)),var(--panel);border:1px solid var(--line);box-shadow:0 40px 90px -30px #000;outline:0;animation:sl-pop .45s cubic-bezier(.2,.7,.2,1) both}
.sl-prog{position:sticky;top:0;z-index:2;height:3px;margin:0 -26px;background:color-mix(in srgb,var(--fg) 8%,transparent)}
.sl-prog i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .35s cubic-bezier(.2,.7,.2,1)}
.sl-top{display:flex;justify-content:space-between;align-items:center;margin-top:20px;font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.sl-brand{font-weight:300;letter-spacing:.24em;color:var(--fg)}
.sl-body.anim{animation:sl-in .32s cubic-bezier(.2,.7,.2,1) both}
.sl-card h2{margin:16px 0 4px;font-size:1.5rem;font-weight:300;letter-spacing:-.025em}
.sl-card .sub{margin:0 0 14px;color:var(--muted);font-size:.9rem;line-height:1.55}
.sl-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-top:1px solid var(--line)}
.sl-row.col{flex-direction:column;align-items:stretch;gap:10px}
.sl-row .t{font-size:.92rem}
.sl-row .d{margin-top:3px;font-size:.76rem;color:var(--muted);line-height:1.4}
.sl-row .d.bad{color:#ff7a7a}
.sl-list{margin:0 0 6px;padding:0;list-style:none;display:grid;gap:8px}
.sl-list li{display:flex;gap:10px;align-items:baseline;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:color-mix(in srgb,var(--fg) 3%,transparent);color:var(--muted);font-size:.88rem;line-height:1.45}
.sl-list li b{color:var(--fg);font-weight:500;min-width:62px}
.sl-seg{display:flex;flex-wrap:wrap;gap:6px}
.sl-seg button{padding:7px 14px;border-radius:999px;border:1px solid var(--line);background:none;color:var(--muted);font:inherit;font-size:.78rem;cursor:pointer;transition:border-color .2s,color .2s,background .2s}
.sl-seg button:hover{color:var(--fg);border-color:color-mix(in srgb,var(--fg) 30%,transparent)}
.sl-seg button.on{background:color-mix(in srgb,var(--accent) 22%,transparent);border-color:var(--accent);color:var(--fg)}
.sl-swatches{display:flex;flex-wrap:wrap;gap:10px}
.sl-swatch{width:36px;height:36px;border-radius:50%;border:2px solid transparent;cursor:pointer;transition:transform .2s}
.sl-swatch:hover{transform:scale(1.08)}
.sl-swatch[aria-pressed=true]{border-color:var(--fg);box-shadow:0 0 0 3px var(--panel) inset}
.sl-sw{position:relative;display:inline-block;flex:none;width:44px;height:26px}
.sl-sw input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;z-index:1}
.sl-sw span{position:absolute;inset:0;border-radius:999px;background:color-mix(in srgb,var(--fg) 8%,transparent);border:1px solid color-mix(in srgb,var(--fg) 18%,transparent);transition:.2s}
.sl-sw span::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--muted);transition:.2s}
.sl-sw input:checked+span{background:color-mix(in srgb,var(--accent) 30%,transparent);border-color:var(--accent)}
.sl-sw input:checked+span::after{transform:translateX(18px);background:var(--fg)}
.sl-sw input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
.sl-setup input[type=text],.sl-setup select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit;font-size:.88rem;outline:0}
.sl-setup select{width:auto}
.sl-setup input[type=text]:focus,.sl-setup select:focus{border-color:var(--accent)}
.sl-nav{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
.sl-left{display:flex;align-items:center;gap:6px}
.sl-btn{height:38px;padding:0 18px;border-radius:999px;border:1px solid color-mix(in srgb,var(--fg) 18%,transparent);background:none;color:var(--fg);font:inherit;font-size:.82rem;cursor:pointer;transition:border-color .2s,transform .2s}
.sl-btn:hover{border-color:var(--accent)}
.sl-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sl-btn.sm{height:32px;padding:0 14px;font-size:.78rem}
.sl-btn.main{border-color:transparent;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#08080a;font-weight:600}
.sl-btn.main:hover{transform:translateY(-1px)}
.sl-btn.link{border-color:transparent;color:var(--muted)}
.sl-btn.link:hover{color:var(--fg)}
@keyframes sl-fade{from{opacity:0}to{opacity:1}}
@keyframes sl-pop{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}
@keyframes sl-in{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.sl-setup,.sl-card,.sl-body.anim{animation:none}.sl-prog i,.sl-sw span,.sl-sw span::after,.sl-btn,.sl-swatch{transition:none}}
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
    const item = (k, v) => { const li = h("li"); li.append(h("b", null, k), document.createTextNode(v)); return li; };

    /* ── state ── */
    let root = null, card = null, step = 0, capturing = false, keyBtnRef = null, keyHintRef = null;

    function upd(patch) { set(patch); paint(); }

    /* ── steps ── */
    const STEPS = [
        {
            t: "set up silence", d: "a few quick choices. everything applies right away, and you can change it all later in settings.",
            body() {
                const ul = h("ul", "sl-list");
                ul.append(
                    item("look", "theme, colors and background"),
                    item("tab", "title and icon"),
                    item("panic", "key and where it sends you"),
                    item("hiding", "about:blank and auto-lock"),
                    item("more", "motion and updates"),
                );
                return [ul];
            },
        },
        {
            t: "look", d: "pick a theme, an accent color and a background.",
            body() {
                const c = get();
                const sw = h("div", "sl-swatches");
                for (const [k, [a, b]] of Object.entries(S.presets)) {
                    const x = h("button", "sl-swatch");
                    x.type = "button"; x.title = k;
                    x.style.background = `linear-gradient(135deg, ${a}, ${b})`;
                    x.setAttribute("aria-label", k);
                    x.setAttribute("aria-pressed", String(c.accent === k));
                    x.onclick = () => upd({ accent: k });
                    sw.append(x);
                }
                const url = h("input");
                url.type = "text"; url.maxLength = 500; url.spellcheck = false; url.placeholder = "https://… image address";
                url.value = c.bg === "custom" ? c.bgUrl : "";
                const err = h("div", "d");
                url.onchange = async () => {
                    if (!url.value.trim()) { upd({ bg: "none", bgUrl: "" }); return; }
                    err.className = "d"; err.textContent = "checking…";
                    try { const u = await S.bgFromUrl(url.value); upd({ bg: "custom", bgUrl: u }); }
                    catch (e) { err.className = "d bad"; err.textContent = e.message || "couldn't use that image"; }
                };
                const urlRow = row("Your own image", "Paste an image address and press enter. Leave it blank to remove it.", url, true);
                urlRow.append(err);
                return [
                    row("Theme", "", seg([["dark", "dark"], ["light", "light"]], c.theme, v => upd({ theme: v }))),
                    row("Accent", "", sw, true),
                    row("Card size", "How big the game tiles are.", seg(["compact", "comfortable", "large"].map(d => [d, d]), c.density, v => upd({ density: v })), true),
                    row("Background", "", seg(BGS, c.bg, v => upd({ bg: v })), true),
                    urlRow,
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
                    if (!S.cloak(true)) open.textContent = "allow pop-ups";   // true = the new window stays unlocked
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
            t: "more", d: "two last options.",
            body() {
                const c = get();
                return [
                    row("Reduce motion", "Turns off animations and transitions.", toggle(c.motion === "reduced", v => upd({ motion: v ? "reduced" : "full" }))),
                    row("Always load the newest version", "Checks for the latest update every time. Turn off if the site feels slow to open.", toggle(c.fresh, v => upd({ fresh: v }))),
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
                    item("panic", c.panicOn ? `${S.keyLabel(c.panicKey)} (goes to ${host})` : "off"),
                    item("lock", "Alt + Shift + L, any time"),
                    item("idle", c.idleMin ? `locks after ${c.idleMin} min` : "auto-lock is off"),
                    item("settings", "change anything later, or run setup again from there"),
                );
                return [ul];
            },
        },
    ];

    /* ── render ── */
    function go(n) { step = n; capturing = false; paint(true); if (card) card.scrollTop = 0; }

    function paint(animate) {
        if (!card) return;
        const s = STEPS[step], last = step === STEPS.length - 1, keep = card.scrollTop;

        const prog = h("div", "sl-prog"), fill = h("i");
        fill.style.width = ((step + 1) / STEPS.length * 100) + "%";
        prog.append(fill);

        const top = h("div", "sl-top");
        top.append(h("span", "sl-brand", "silence"), h("span", null, `step ${step + 1} of ${STEPS.length}`));

        const body = h("div", "sl-body" + (animate ? " anim" : ""));
        body.append(h("h2", null, s.t), h("p", "sub", s.d), ...s.body());

        const nav = h("div", "sl-nav"), left = h("div", "sl-left");
        if (step > 0) left.append(btn("back", "", () => go(step - 1)));
        if (!last) left.append(btn("skip setup", "link", () => { markDone(); close(); }));
        nav.append(left, btn(last ? "finish" : "next", "main", () => { if (last) { markDone(); close(); } else go(step + 1); }));

        card.replaceChildren(prog, top, body, nav);
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
        paint(true);
        card.focus();
    }

    function close() {
        removeEventListener("keydown", onKey, true);
        root?.remove();
        root = card = null;
        capturing = false;
    }

    /* ── when to show it ── */
    const goPrompt = document.getElementById("go-silence");
    function maybe() {
        if (root && !root.isConnected) close();          // the shell swept it (lock / panic)
        if (root || seen()) return;
        const b = document.body.classList;
        if (b.contains("locked") || !b.contains("ready")) return;   // never over a disguise page or the loader
        if (goPrompt && !goPrompt.hidden) return;        // wait for the "go to silence" prompt
        if (S.launched) return;                          // that prompt opened the new window: setup runs there
        open();
    }
    new MutationObserver(maybe).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    if (goPrompt) new MutationObserver(maybe).observe(goPrompt, { attributes: true, attributeFilter: ["hidden"] });
    maybe();

    S.setup = () => { if (!root) open(); };              // settings page: "run setup"
})();