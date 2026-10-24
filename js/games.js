/* ───────── multiplayer games inside chat rooms ─────────
   Loaded by Pages/chat.html. Talks to the room's GameRoom Durable Object over a websocket
   (GET /api/global/rooms/:id/game). The server decides everything; this file only draws what
   it's told and sends the player's clicks.

   chat.html calls   SilenceGames.enter(room)   when you open a room
                     SilenceGames.leave()       when you go back to the lobby or sign out
   and has an empty <div id="sg"></div> where the panel goes. */
(() => {
    "use strict";

    const GAME_NAMES = { ttt: "tic-tac-toe", c4: "connect four", chess: "chess", draw: "drawing game" };
    const COLORS = ["#111111", "#ffffff", "#7f7f7f", "#c1c1c1", "#ef130b", "#ff7100", "#ffe400", "#00cc00",
        "#00b2ff", "#231fd3", "#a300ba", "#d37caa", "#a0522d", "#ffc89a", "#006400", "#5ce1c6"];
    const WIDTHS = [4, 9, 18, 34];
    const PIECE = { K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟" };   // filled glyphs for both sides, coloured by css
    const FILES = "abcdefgh";

    const h = (tag, props = {}, ...kids) => {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (k === "class") e.className = v;
            else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
            else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
        }
        e.append(...kids.flat().filter((x) => x != null && x !== false));
        return e;
    };
    const ss = (k, d) => { try { const v = JSON.parse(sessionStorage.getItem(k)); return v ?? d; } catch { return d; } };
    const sset = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { } };
    const btn = (label, fn, cls = "") => h("button", { class: "btn sm " + cls, type: "button", onclick: fn }, label);

    /* ───────── state ───────── */
    let root = null, bar = null, sumEl = null, body = null, errEl = null;
    let ws = null, snap = null, roomId = "", stopped = true, open = false;
    let offset = 0, tries = 0, retryT = null, pingT = null, errT = null;
    let viewKey = "", patch = null, cleanup = null;
    let sel = -1, promo = null;                  // chess: selected square, pending promotion {from, to}
    let feed = [], lastTurn = -1, lastSub = "";  // drawing game
    const draw = { strokes: [], ctx: null, canvas: null, color: 0, width: 1, id: 0, pending: [], flushT: null, active: false, last: null };

    /* ───────── css ───────── */
    function css() {
        if (document.getElementById("sg-css")) return;
        const s = document.createElement("style");
        s.id = "sg-css";
        s.textContent = `
        .sg{border:1px solid var(--line,rgba(255,255,255,.12));border-radius:12px;background:rgba(255,255,255,.03);overflow:hidden}
        .sg-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;flex-wrap:wrap}
        .sg-bar b{font-size:.9em}.sg-sum{flex:1;min-width:0;font-size:.82em;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .sg-sum.hot{opacity:1;color:var(--accent2,#5ce1c6)}
        .sg-err{font-size:.8em;color:var(--danger,#ff6b81);padding:0 12px 6px}
        .sg-body{padding:4px 12px 14px;display:flex;flex-direction:column;gap:10px}
        .sg-body[hidden]{display:none}
        .sg-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
        .sg-note{font-size:.85em;opacity:.75;margin:0}
        .sg-status{font-size:.95em;margin:0}
        .sg-status.win{color:var(--ok,#5ce1a0)}.sg-status.lose{color:var(--danger,#ff6b81)}
        .sg-seats{display:flex;gap:14px;flex-wrap:wrap;font-size:.85em}
        .sg-seat{display:flex;align-items:center;gap:6px;opacity:.65}.sg-seat.turn{opacity:1;font-weight:600}
        .sg-chip{width:12px;height:12px;border-radius:50%;display:inline-block;border:1px solid rgba(255,255,255,.4)}
        .sg-off{opacity:.5;font-size:.85em}
        /* tic-tac-toe */
        .sg-ttt{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;width:min(100%,260px)}
        .sg-ttt button{aspect-ratio:1;font-size:2.2rem;font-weight:300;border-radius:10px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12)}
        .sg-ttt button:not(:disabled):hover{border-color:var(--accent,#8b7cff)}
        .sg-ttt .win{background:color-mix(in srgb,var(--ok,#5ce1a0) 25%,transparent)}.sg-ttt .last{border-color:var(--accent,#8b7cff)}
        /* connect four */
        .sg-c4{display:grid;grid-template-columns:repeat(7,1fr);gap:5px;padding:8px;border-radius:12px;background:#1d3fa8;width:min(100%,380px)}
        .sg-c4 i{aspect-ratio:1;border-radius:50%;background:#0b1b4d;cursor:pointer;display:block}
        .sg-c4 i.p1{background:#ef3b3b}.sg-c4 i.p2{background:#ffd23f}
        .sg-c4 i.win{box-shadow:0 0 0 3px #fff}.sg-c4 i.last{outline:2px dashed rgba(255,255,255,.8);outline-offset:-4px}
        /* chess */
        .sg-chess{display:grid;grid-template-columns:repeat(8,1fr);width:min(100%,440px);border:2px solid rgba(255,255,255,.15);border-radius:6px;overflow:hidden}
        .sg-sq{aspect-ratio:1;position:relative;font-size:clamp(1.3rem,5.4vw,2.3rem);line-height:1;padding:0;display:grid;place-items:center;border:0;border-radius:0}
        .sg-sq.lt{background:#d7c9a8}.sg-sq.dk{background:#a2825b}
        .sg-sq.last{background:#cdd26a}.sg-sq.dk.last{background:#aaa23a}
        .sg-sq.sel{background:#7bc47f!important}.sg-sq.chk{background:#e8605a!important}
        .sg-sq.tgt::after{content:"";width:28%;height:28%;border-radius:50%;background:rgba(20,20,20,.35);position:absolute}
        .sg-sq .w{color:#fff;text-shadow:0 0 2px #000,0 0 2px #000,0 0 1px #000}.sg-sq .k{color:#151515;text-shadow:0 0 1px rgba(255,255,255,.5)}
        .sg-moves{font-family:var(--mono,monospace);font-size:.78em;opacity:.8;max-height:5.5em;overflow:auto;width:min(100%,440px);line-height:1.5}
        .sg-promo{display:flex;gap:6px;align-items:center}
        .sg-promo button{font-size:1.6rem;width:46px;height:46px;border-radius:8px;background:#a2825b;border:1px solid rgba(255,255,255,.3)}
        /* drawing game */
        .sg-draw{display:grid;grid-template-columns:minmax(0,1fr) 200px;gap:12px}
        @media (max-width:620px){.sg-draw{grid-template-columns:1fr}}
        .sg-top{display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
        .sg-word{font-family:var(--mono,monospace);font-size:1.3rem;letter-spacing:.25em}
        .sg-time{font-family:var(--mono,monospace);opacity:.8}
        .sg-canvas{width:100%;aspect-ratio:5/3;background:#fff;border-radius:8px;touch-action:none;display:block;cursor:default}
        .sg-canvas.can{cursor:crosshair}
        .sg-tools{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
        .sg-tools[hidden]{display:none}
        .sg-col{width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,255,255,.25);padding:0}
        .sg-col.on{border-color:var(--accent,#8b7cff);box-shadow:0 0 0 2px var(--accent,#8b7cff)}
        .sg-w{width:30px;height:30px;border-radius:8px;border:1px solid rgba(255,255,255,.2);display:grid;place-items:center;padding:0}
        .sg-w.on{border-color:var(--accent,#8b7cff)}.sg-w i{background:var(--fg,#fff);border-radius:50%;display:block}
        .sg-side{display:flex;flex-direction:column;gap:8px;min-width:0}
        .sg-players{display:flex;flex-direction:column;gap:3px;font-size:.85em}
        .sg-pl{display:flex;justify-content:space-between;gap:6px;opacity:.85}.sg-pl.me{font-weight:600}.sg-pl.gd{color:var(--ok,#5ce1a0)}.sg-pl.dr{color:var(--accent,#8b7cff)}
        .sg-feed{height:150px;overflow-y:auto;font-size:.82em;display:flex;flex-direction:column;gap:2px;background:rgba(0,0,0,.2);border-radius:8px;padding:6px 8px;overflow-wrap:anywhere}
        .sg-feed .ok{color:var(--ok,#5ce1a0)}.sg-feed .sys{opacity:.6;font-style:italic}.sg-feed .close{color:var(--warn,#f3b562)}.sg-feed .team{color:var(--accent2,#5ce1c6)}
        .sg-in{width:100%;padding:8px 10px;border-radius:8px;background:var(--bg,#08080a);border:1px solid var(--line,rgba(255,255,255,.12));color:inherit}
        .sg-board{list-style:none;display:flex;flex-direction:column;gap:6px;max-width:320px}
        .sg-board li{display:flex;justify-content:space-between;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.05)}
        .sg-board li:first-child{background:color-mix(in srgb,var(--accent,#8b7cff) 22%,transparent)}`;
        document.head.append(s);
    }

    /* ───────── connection ───────── */
    const originWs = () => {
        let o = location.origin;
        try { o = window.parent.location.origin; } catch { }
        return o.replace(/^http/, "ws");
    };

    function connect() {
        if (stopped || ws) return;
        const token = ss("silence:chatToken", "");
        if (!token) return flash("sign in to chat first");
        const pass = (ss("silence:roomPass", {}) || {})[roomId];
        const url = `${originWs()}/api/global/rooms/${encodeURIComponent(roomId)}/game?t=${encodeURIComponent(token)}${pass ? "&pw=" + encodeURIComponent(pass) : ""}`;
        let opened = false;
        const sock = new WebSocket(url);
        ws = sock;
        sock.onopen = () => { opened = true; tries = 0; clearInterval(pingT); pingT = setInterval(() => { try { sock.send("ping"); } catch { } }, 25000); render(); };
        sock.onmessage = (e) => {
            if (typeof e.data !== "string" || e.data === "pong") return;
            let m; try { m = JSON.parse(e.data); } catch { return; }
            onMessage(m);
        };
        sock.onclose = () => {
            if (ws === sock) ws = null;
            clearInterval(pingT);
            if (stopped) return;
            tries = opened ? 1 : tries + 1;
            if (tries > 5) { flash("couldn't connect to games here"); snap = null; render(); return; }
            clearTimeout(retryT);
            retryT = setTimeout(connect, Math.min(15000, 800 * 2 ** tries));
            render();
        };
        sock.onerror = () => { };
    }

    function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); else flash("not connected yet"); }

    function flash(t) {
        if (!errEl) return;
        errEl.textContent = t; errEl.hidden = !t;
        clearTimeout(errT);
        if (t) errT = setTimeout(() => { errEl.hidden = true; }, 3500);
    }

    function onMessage(m) {
        if (m.t === "snap") {
            const prev = snap;
            snap = m;
            offset = m.now - Date.now();
            // a new move or a different game clears the chess selection; presence updates keep it
            if (!prev || prev.game !== m.game || prev.phase !== m.phase || prev.gs?.moves?.length !== m.gs?.moves?.length) { sel = -1; promo = null; }
            noteDraw(prev, m);
            render();
        } else if (m.t === "err") flash(m.error);
        else if (m.t === "msg") { addFeed(m.k, m.n ? `${m.n}: ${m.text}` : m.text, m.k === "g" ? "" : m.k); }
        else if (m.t === "strokes") { draw.strokes = Array.isArray(m.list) ? m.list : []; redraw(); }
        else if (m.t === "sb") { draw.strokes.push({ id: m.id, c: m.c, w: m.w, p: [m.x, m.y] }); dot(draw.strokes[draw.strokes.length - 1]); }
        else if (m.t === "sp") {
            const s = [...draw.strokes].reverse().find((x) => x.id === m.id);
            if (!s) return;
            const from = s.p.slice(-2);
            s.p.push(...m.p);
            segment(s, [...from, ...m.p]);
        }
        else if (m.t === "undo") { draw.strokes.pop(); redraw(); }
        else if (m.t === "clear") { draw.strokes = []; redraw(); }
    }

    /* ───────── helpers ───────── */
    const seatName = (s, i) => s.seats?.[i]?.name || "?";
    const you = () => snap?.you?.seat ?? -1;
    const isWhite = (p) => p >= "A" && p <= "Z";
    const nameOf = (s, pid) => s.players?.find((p) => p.pid === pid)?.name || "someone";

    function summary(s) {
        if (!ws || ws.readyState !== 1) return { t: stopped ? "" : open ? "connecting…" : "tap show to play with this room" };
        if (!s) return { t: "connecting…" };
        if (s.phase === "idle") return { t: "no game running" };
        const g = GAME_NAMES[s.game];
        if (s.phase === "lobby") return { t: `${g} · waiting for players` };
        if (s.phase === "over") return { t: `${g} · finished` };
        if (s.game === "draw") return { t: `${g} · round ${s.gs.round}/${s.gs.rounds}`, hot: s.gs.sub === "draw" && s.gs.drawer === s.you.pid };
        const mine = s.you.seat >= 0 && s.gs.turn === s.you.seat;
        return { t: `${g} · ${mine ? "your turn" : s.you.seat >= 0 ? "opponent's turn" : "watching"}`, hot: mine };
    }

    /* ───────── panel ───────── */
    function mount() {
        css();
        root = document.getElementById("sg");
        if (!root) return false;
        sumEl = h("span", { class: "sg-sum" });
        const tog = btn(open ? "hide" : "show", () => setOpen(!open));
        bar = h("div", { class: "sg-bar" }, h("b", {}, "games"), sumEl, tog);
        errEl = h("div", { class: "sg-err", hidden: true });
        body = h("div", { class: "sg-body", hidden: !open });
        root.replaceChildren(h("div", { class: "sg" }, bar, errEl, body));
        root.hidden = false;
        bar.tog = tog;
        return true;
    }

    function setOpen(v) {
        open = v;
        sset("silence:gamesOpen", v);
        if (!body) return;
        body.hidden = !v;
        bar.tog.textContent = v ? "hide" : "show";
        if (v) { stopped = false; connect(); }
        render();
    }

    function render() {
        if (!root || !body) return;
        const sm = summary(snap);
        sumEl.textContent = sm.t;
        sumEl.classList.toggle("hot", !!sm.hot);
        if (!open) return;

        let key = "wait";
        if (snap) key = snap.phase === "idle" ? "idle" : snap.game === "draw" ? "draw:" + (snap.phase === "play" ? "play" : snap.phase) : snap.game + ":" + (snap.phase === "lobby" ? "lobby" : "board");
        if (key !== viewKey) {
            if (cleanup) cleanup();
            cleanup = null; patch = null;
            const built = build(key);
            patch = built.patch; cleanup = built.cleanup || null;
            body.replaceChildren(built.el);
            viewKey = key;
        }
        if (patch) patch(snap);
    }

    // a container whose contents are re-rendered by fn(snap) on every update
    const simple = (fn) => {
        const el = h("div", { class: "sg-body", style: "padding:0" });
        return { el, patch: (s) => el.replaceChildren(...fn(s).filter(Boolean)) };
    };

    function build(key) {
        if (key === "wait") return simple(() => [h("p", { class: "sg-note" }, ws ? "loading…" : "connecting…")]);
        if (key === "idle") return simple(idleView);
        if (key === "draw:lobby") return simple(drawLobby);
        if (key === "draw:play") return drawPlay();
        if (key === "draw:over") return simple(drawOver);
        if (key.endsWith(":lobby")) return simple(turnLobby);
        return simple(turnBoard);
    }

    /* ───────── lobby views ───────── */
    function idleView() {
        return [
            h("p", { class: "sg-note" }, "start a game that everyone in this room can play or watch."),
            h("div", { class: "sg-row" },
                btn("tic-tac-toe", () => send({ t: "new", game: "ttt" })),
                btn("connect four", () => send({ t: "new", game: "c4" })),
                btn("chess", () => send({ t: "new", game: "chess" })),
                btn("drawing game (2-8)", () => send({ t: "new", game: "draw" }))),
        ];
    }

    function turnLobby(s) {
        const me = s.you.seat >= 0;
        return [
            h("p", { class: "sg-status" }, `${GAME_NAMES[s.game]} · ${seatName(s, 0)} is waiting for an opponent`),
            h("div", { class: "sg-row" },
                me ? btn("cancel", () => send({ t: "leave" })) : btn("join game", () => send({ t: "join" }), "primary"),
                s.you.admin && !me ? btn("close", () => send({ t: "close" })) : null),
        ];
    }

    function drawLobby(s) {
        const me = s.you.player, isHost = s.you.host;
        const rounds = h("select", { class: "sg-in", style: "width:auto" }, [1, 2, 3].map((n) => h("option", { value: n, selected: n === 2 }, `${n} round${n > 1 ? "s" : ""}`)));
        return [
            h("p", { class: "sg-status" }, `drawing game · ${s.players.length}/${s.max} players`),
            h("p", { class: "sg-note" }, "one player draws a secret word, everyone else guesses it. faster guesses score more."),
            h("div", { class: "sg-players" }, s.players.map((p) => h("div", { class: "sg-pl" + (p.pid === s.you.pid ? " me" : "") },
                h("span", {}, p.name + (p.pid === s.host ? " (host)" : "")), p.online ? "" : h("span", { class: "sg-off" }, "offline")))),
            h("div", { class: "sg-row" },
                me ? null : btn("join", () => send({ t: "join" }), "primary"),
                isHost ? rounds : null,
                isHost ? btn("start", () => send({ t: "start", rounds: +rounds.value }), "primary") : null,
                me && !isHost ? btn("leave", () => send({ t: "leave" })) : null,
                isHost || s.you.admin ? btn("close", () => send({ t: "close" })) : null),
            isHost && s.players.length < 2 ? h("p", { class: "sg-note" }, "waiting for at least one more player…") : null,
        ];
    }

    /* ───────── turn games ───────── */
    function resultLine(s) {
        const o = s.gs.over, me = s.you.seat;
        if (o.winner === -1) return h("p", { class: "sg-status" }, `draw · ${o.reason}`);
        const cls = me < 0 ? "" : o.winner === me ? " win" : " lose";
        const who = me >= 0 ? (o.winner === me ? "you win" : "you lose") : `${seatName(s, o.winner)} wins`;
        return h("p", { class: "sg-status" + cls }, `${who} · ${o.reason}`);
    }

    function turnBoard(s) {
        const gs = s.gs, me = s.you.seat, over = s.phase === "over";
        const marks = { ttt: ["X", "O"], c4: ["red", "yellow"], chess: ["white", "black"] }[s.game];
        const chip = { c4: ["#ef3b3b", "#ffd23f"], chess: ["#fff", "#151515"] }[s.game];
        const seats = h("div", { class: "sg-seats" }, [0, 1].map((i) => h("div", { class: "sg-seat" + (!over && gs.turn === i ? " turn" : "") },
            chip ? h("span", { class: "sg-chip", style: `background:${chip[i]}` }) : null,
            `${seatName(s, i)}${me === i ? " (you)" : ""} · ${marks[i]}`,
            s.seats[i] && !s.seats[i].online ? h("span", { class: "sg-off" }, "offline") : null)));

        let status;
        if (over) status = resultLine(s);
        else {
            const mine = me >= 0 && gs.turn === me;
            const chk = s.game === "chess" && gs.check >= 0 ? " · check" : "";
            status = h("p", { class: "sg-status" }, (mine ? "your turn" : `${seatName(s, gs.turn)}'s turn`) + chk);
        }

        const board = s.game === "ttt" ? tttBoard(s) : s.game === "c4" ? c4Board(s) : chessBoard(s);
        const acts = [];
        if (!over && me >= 0) acts.push(btn("resign", () => { if (confirm("resign this game?")) send({ t: "resign" }); }));
        if (!over && me >= 0 && s.game === "chess") {
            if (gs.drawOffer === -1) acts.push(btn("offer draw", () => send({ t: "draw" })));
            else if (gs.drawOffer === me) acts.push(h("span", { class: "sg-note" }, "draw offered…"));
            else acts.push(btn("accept draw", () => send({ t: "draw" }), "primary"), btn("decline", () => send({ t: "decline" })));
        }
        if (over) {
            if (me >= 0) acts.push(s.rematch[me] ? h("span", { class: "sg-note" }, "waiting for your opponent…") : btn(s.rematch[1 - me] ? "accept rematch" : "play again", () => send({ t: "again" }), "primary"));
            if (me >= 0 || s.you.admin) acts.push(btn("close", () => send({ t: "close" })));
        } else if (s.you.admin && me < 0) acts.push(btn("end game", () => send({ t: "close" })));

        return [seats, status, board, promo ? promoPicker(s) : null, s.game === "chess" ? movesList(gs) : null, h("div", { class: "sg-row" }, acts)];
    }

    function tttBoard(s) {
        const gs = s.gs, can = s.phase === "play" && s.you.seat === gs.turn;
        return h("div", { class: "sg-ttt" }, gs.b.map((v, i) => h("button", {
            type: "button", disabled: !can || !!v, "aria-label": `square ${i + 1}`,
            class: (gs.line?.includes(i) ? "win " : "") + (gs.last === i ? "last" : ""),
            onclick: () => send({ t: "move", i }),
        }, v === 1 ? "X" : v === 2 ? "O" : "")));
    }

    function c4Board(s) {
        const gs = s.gs, can = s.phase === "play" && s.you.seat === gs.turn;
        return h("div", { class: "sg-c4" }, gs.b.map((v, i) => h("i", {
            class: (v ? "p" + v : "") + (gs.line?.includes(i) ? " win" : "") + (gs.last === i ? " last" : ""),
            onclick: () => { if (can) send({ t: "move", c: i % 7 }); },
        })));
    }

    function chessBoard(s) {
        const gs = s.gs, me = s.you.seat, flip = me === 1;
        const mine = s.phase === "play" && me >= 0 && gs.turn === me;
        const targets = new Set(sel >= 0 ? gs.legal.filter(([f]) => f === sel).map(([, t]) => t) : []);
        const cells = [];
        for (let rr = 0; rr < 8; rr++) {
            for (let ff = 0; ff < 8; ff++) {
                const r = flip ? 7 - rr : rr, f = flip ? 7 - ff : ff, i = r * 8 + f, p = gs.b[i];
                const cls = "sg-sq " + ((r + f) % 2 ? "dk" : "lt") + (sel === i ? " sel" : "") + (gs.last?.includes(i) ? " last" : "")
                    + (gs.check === i ? " chk" : "") + (targets.has(i) ? " tgt" : "");
                cells.push(h("button", { type: "button", class: cls, title: FILES[f] + (8 - r), onclick: () => clickSquare(i) },
                    p ? h("span", { class: isWhite(p) ? "w" : "k" }, PIECE[p.toUpperCase()] + "︎") : null));
            }
        }
        function clickSquare(i) {
            if (!mine || promo) return;
            const p = gs.b[i], own = p && isWhite(p) === (me === 0);
            if (sel >= 0 && targets.has(i)) {
                const pawn = gs.b[sel].toLowerCase() === "p" && (i >> 3 === 0 || i >> 3 === 7);
                if (pawn) { promo = { from: sel, to: i }; sel = -1; }
                else { send({ t: "move", from: sel, to: i }); sel = -1; }
            } else sel = own && sel !== i ? i : -1;
            render();
        }
        return h("div", { class: "sg-chess" }, cells);
    }

    function promoPicker(s) {
        const white = s.you.seat === 0;
        return h("div", { class: "sg-promo" }, h("span", { class: "sg-note" }, "promote to:"),
            ["q", "r", "b", "n"].map((k) => h("button", {
                type: "button", onclick: () => { send({ t: "move", from: promo.from, to: promo.to, promo: k }); promo = null; render(); },
            }, h("span", { class: white ? "w" : "k", style: white ? "color:#fff;text-shadow:0 0 2px #000" : "color:#151515" }, PIECE[k.toUpperCase()] + "︎"))),
            btn("cancel", () => { promo = null; render(); }));
    }

    function movesList(gs) {
        if (!gs.moves.length) return null;
        const out = [];
        for (let i = 0; i < gs.moves.length; i += 2) out.push(`${i / 2 + 1}. ${gs.moves[i]}${gs.moves[i + 1] ? " " + gs.moves[i + 1] : ""}`);
        const el = h("div", { class: "sg-moves" }, out.join("  "));
        queueMicrotask(() => { el.scrollTop = el.scrollHeight; });
        return el;
    }

    /* ───────── drawing game ───────── */
    function addFeed(kind, text, cls) {
        feed.push({ k: cls || kind, text });
        if (feed.length > 60) feed.shift();
        paintFeed();
    }

    // turn changes → system lines in the feed
    function noteDraw(prev, s) {
        if (s.game !== "draw" || !s.gs) { lastTurn = -1; lastSub = ""; return; }
        const g = s.gs;
        if (g.turn !== lastTurn) {
            if (lastTurn === -1 && !prev) feed = [];
            draw.strokes = []; redraw();
            if (g.sub === "draw") addFeed("sys", `${nameOf(s, g.drawer)} is drawing`, "sys");
            lastTurn = g.turn;
        }
        if (g.sub !== lastSub) {
            if (g.sub === "reveal") addFeed("sys", `the word was "${g.lastWord}"`, "sys");
            if (g.sub === "over") addFeed("sys", "game over", "sys");
            lastSub = g.sub;
        }
    }

    let feedEl = null;
    function paintFeed() {
        if (!feedEl) return;
        feedEl.replaceChildren(...feed.map((l) => h("div", { class: l.k }, l.text)));
        feedEl.scrollTop = feedEl.scrollHeight;
    }

    const cx = (v) => v * draw.canvas.width / 1000, cy = (v) => v * draw.canvas.height / 600;
    function dot(s) {
        if (!draw.ctx) return;
        const c = draw.ctx;
        c.fillStyle = COLORS[s.c] || "#000";
        c.beginPath(); c.arc(cx(s.p[0]), cy(s.p[1]), s.w * draw.canvas.width / 2000, 0, Math.PI * 2); c.fill();
    }
    function segment(s, pts) {                 // draw a piece of a stroke: pts = [x0, y0, x1, y1, ...]
        if (!draw.ctx) return;
        const c = draw.ctx;
        c.strokeStyle = COLORS[s.c] || "#000";
        c.lineWidth = s.w * draw.canvas.width / 1000;
        c.lineCap = c.lineJoin = "round";
        c.beginPath();
        c.moveTo(cx(pts[0]), cy(pts[1]));
        for (let i = 2; i < pts.length; i += 2) c.lineTo(cx(pts[i]), cy(pts[i + 1]));
        c.stroke();
    }
    function redraw() {
        if (!draw.ctx) return;
        draw.ctx.fillStyle = "#fff";
        draw.ctx.fillRect(0, 0, draw.canvas.width, draw.canvas.height);
        for (const s of draw.strokes) { if (s.p.length <= 2) dot(s); else segment(s, s.p); }
    }

    function drawPlay() {
        const el = h("div", { class: "sg-body", style: "padding:0" });
        const topWord = h("span", { class: "sg-word" }), topInfo = h("span", { class: "sg-note" }), topTime = h("span", { class: "sg-time" });
        const canvas = h("canvas", { class: "sg-canvas", width: 1000, height: 600 });
        draw.canvas = canvas; draw.ctx = canvas.getContext("2d"); draw.active = false;
        redraw();

        const colors = COLORS.map((c, i) => h("button", { type: "button", class: "sg-col", style: `background:${c}`, "aria-label": "colour " + (i + 1), onclick: () => { draw.color = i; paintTools(); } }));
        const widths = WIDTHS.map((w, i) => h("button", { type: "button", class: "sg-w", "aria-label": "pen size " + (i + 1), onclick: () => { draw.width = i; paintTools(); } },
            h("i", { style: `width:${Math.max(4, w / 2.2)}px;height:${Math.max(4, w / 2.2)}px` })));
        const tools = h("div", { class: "sg-tools", hidden: true }, colors, widths,
            btn("undo", () => { draw.strokes.pop(); redraw(); send({ t: "undo" }); }),
            btn("clear", () => { draw.strokes = []; redraw(); send({ t: "clear" }); }));
        const paintTools = () => {
            colors.forEach((b, i) => b.classList.toggle("on", i === draw.color));
            widths.forEach((b, i) => b.classList.toggle("on", i === draw.width));
        };
        paintTools();

        const players = h("div", { class: "sg-players" });
        const endBtn = btn("end game", () => send({ t: "close" }), "danger");
        feedEl = h("div", { class: "sg-feed" });
        const input = h("input", { class: "sg-in", maxlength: 30, autocomplete: "off", placeholder: "type your guess…" });
        input.addEventListener("keydown", (e) => {
            if (e.key !== "Enter" || e.isComposing) return;
            const t = input.value.trim();
            if (t) send({ t: "guess", text: t });
            input.value = "";
        });

        /* pointer drawing (drawer only) */
        const pos = (e) => {
            const r = canvas.getBoundingClientRect();
            return [Math.min(1000, Math.max(0, Math.round((e.clientX - r.left) / r.width * 1000))), Math.min(1000, Math.max(0, Math.round((e.clientY - r.top) / r.height * 600)))];
        };
        const canDraw = () => snap?.game === "draw" && snap.gs?.sub === "draw" && snap.gs.drawer === snap.you.pid;
        const flush = () => {
            draw.flushT = null;
            if (!draw.pending.length) return;
            send({ t: "sp", id: draw.id, p: draw.pending });
            draw.pending = [];
        };
        canvas.addEventListener("pointerdown", (e) => {
            if (!canDraw() || e.button > 0) return;
            e.preventDefault();
            canvas.setPointerCapture(e.pointerId);
            draw.active = true;
            draw.id = (Math.random() * 1e9) | 0;
            const [x, y] = pos(e), s = { id: draw.id, c: draw.color, w: WIDTHS[draw.width], p: [x, y] };
            draw.strokes.push(s); dot(s);
            draw.last = [x, y];
            send({ t: "sb", id: s.id, c: s.c, w: s.w, x, y });
        });
        canvas.addEventListener("pointermove", (e) => {
            if (!draw.active) return;
            const [x, y] = pos(e), [lx, ly] = draw.last;
            if (Math.abs(x - lx) + Math.abs(y - ly) < 3) return;
            const s = draw.strokes[draw.strokes.length - 1];
            if (!s || s.id !== draw.id || s.p.length > 2300) return;
            segment(s, [lx, ly, x, y]);
            s.p.push(x, y);
            draw.pending.push(x, y);
            draw.last = [x, y];
            if (draw.pending.length >= 100) flush(); else if (!draw.flushT) draw.flushT = setTimeout(flush, 50);
        });
        const end = () => {
            if (!draw.active) return;
            draw.active = false;
            clearTimeout(draw.flushT); flush();
            send({ t: "se", id: draw.id });
        };
        canvas.addEventListener("pointerup", end);
        canvas.addEventListener("pointercancel", end);

        const left = () => {
            const g = snap?.gs;
            if (!g || !g.endsAt) return 0;
            return Math.max(0, Math.ceil((g.endsAt - (Date.now() + offset)) / 1000));
        };
        const tick = () => { topTime.textContent = snap?.gs?.sub === "over" ? "" : left() + "s"; };
        const timer = setInterval(tick, 250);

        el.append(
            h("div", { class: "sg-top" }, topInfo, topWord, topTime),
            h("div", { class: "sg-draw" },
                h("div", { class: "sg-side", style: "gap:8px" }, canvas, tools),
                h("div", { class: "sg-side" }, players, feedEl, input,
                    h("div", { class: "sg-row" }, btn("leave", () => send({ t: "leave" })), endBtn))));
        paintFeed();

        const patchFn = (s) => {
            const g = s.gs;
            if (!g) return;
            const iDraw = g.drawer === s.you.pid, guessed = g.guessed.includes(s.you.pid);
            topInfo.textContent = `round ${g.round}/${g.rounds} · ${g.sub === "reveal" ? "time's up" : iDraw ? "you are drawing" : `${nameOf(s, g.drawer)} is drawing`}`;
            topWord.textContent = g.mask.split("").map((c) => (c === " " ? " " : c)).join(" ");
            endBtn.hidden = !(s.you.host || s.you.admin);
            tools.hidden = !(iDraw && g.sub === "draw");
            canvas.classList.toggle("can", iDraw && g.sub === "draw");
            input.placeholder = iDraw ? "chat with people who guessed…" : guessed ? "chat with the drawer…" : "type your guess…";
            input.disabled = !s.you.player || g.sub !== "draw";
            const rows = [...s.players].sort((a, b) => (g.scores[b.pid] || 0) - (g.scores[a.pid] || 0));
            players.replaceChildren(...rows.map((p) => h("div", { class: "sg-pl" + (p.pid === s.you.pid ? " me" : "") + (g.guessed.includes(p.pid) ? " gd" : "") + (p.pid === g.drawer ? " dr" : "") },
                h("span", {}, (p.pid === g.drawer ? "✎ " : g.guessed.includes(p.pid) ? "✓ " : "") + p.name + (p.online ? "" : " (offline)")),
                h("span", {}, g.scores[p.pid] || 0))));
            tick();
        };
        return { el, patch: patchFn, cleanup: () => { clearInterval(timer); clearTimeout(draw.flushT); draw.ctx = null; draw.canvas = null; feedEl = null; } };
    }

    function drawOver(s) {
        const g = s.gs, rows = [...s.players].sort((a, b) => (g.scores[b.pid] || 0) - (g.scores[a.pid] || 0));
        return [
            h("p", { class: "sg-status" }, rows.length ? `${rows[0].name} wins!` : "game over"),
            h("ol", { class: "sg-board" }, rows.map((p) => h("li", {}, h("span", {}, p.name), h("b", {}, g.scores[p.pid] || 0)))),
            h("div", { class: "sg-row" },
                s.you.host ? btn("play again", () => send({ t: "again" }), "primary") : h("span", { class: "sg-note" }, "waiting for the host…"),
                s.you.host || s.you.player || s.you.admin ? btn("close", () => send({ t: "close" })) : null),
        ];
    }

    /* ───────── public api ───────── */
    function leave() {
        stopped = true;
        clearTimeout(retryT); clearInterval(pingT);
        if (cleanup) cleanup();
        cleanup = null; patch = null; viewKey = "";
        if (ws) { const w = ws; ws = null; try { w.close(1000); } catch { } }
        snap = null; sel = -1; promo = null; feed = []; lastTurn = -1; lastSub = ""; draw.strokes = [];
        if (root) { root.replaceChildren(); root.hidden = true; }
        body = null; bar = null;
    }

    function enter(room) {
        leave();
        roomId = room.id;
        open = !!ss("silence:gamesOpen", false);
        tries = 0;
        if (!mount()) return;
        stopped = false;
        if (open) connect();
        render();
    }

    window.SilenceGames = { enter, leave };
})();
