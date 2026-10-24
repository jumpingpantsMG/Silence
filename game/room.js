// GameRoom: one Durable Object per chat room, holding that room's multiplayer game.
// worker.js checks the chat session + room access, then forwards the websocket here with the
// player's identity in x-sl-* headers (always overwritten by the worker, so they can't be forged).
//
// One game at a time per room. Everyone connected to the room can watch; players take seats.
// Uses the websocket hibernation API, so an idle room costs nothing. State is saved to storage after
// every change and restored when the object wakes up.
//
// client -> server (JSON):
//   {t:"new", game:"ttt"|"c4"|"chess"|"draw"}   open a lobby (only when no game is running)
//   {t:"join"} {t:"leave"} {t:"start", rounds}  {t:"resign"} {t:"again"} {t:"close"}
//   {t:"move", ...}  {t:"draw"} {t:"decline"}   turn games / chess draw offers
//   {t:"sb"|"sp"|"se"|"clear"|"undo", ...}       drawing strokes (drawer only)
//   {t:"guess", text}                            drawing game guesses
// server -> client: {t:"snap", ...} {t:"strokes", list} {t:"sb"|"sp"|"se"|"clear"|"undo"} {t:"msg", ...} {t:"err", error}
import * as ttt from "./tictactoe.js";
import * as c4 from "./connect4.js";
import * as chess from "./chess.js";
import * as draw from "./draw.js";
import { okGuess } from "./filter.js";

const TURN_GAMES = { ttt, c4, chess };
const GAMES = new Set([...Object.keys(TURN_GAMES), "draw"]);
const DISC_MS = 60000;            // a disconnected player has this long to come back
const IDLE_MS = 3600000;          // an empty room forgets its game after an hour
const MAX_SOCKETS = 40;
const MAX_MSG = 8192;
const MAX_STROKES = 400;
const MAX_STROKE_NUMS = 2400;

const fresh = () => ({ game: null, phase: "idle", host: "", seats: [null, null], players: {}, names: {}, gs: null, rematch: [false, false], disc: {}, rev: 0, touched: Date.now() });
const int = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo);

export class GameRoom {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.r = fresh();
        this.strokes = { list: [] };
        this.rate = new Map();
        this.lastGuess = new Map();
        ctx.blockConcurrencyWhile(async () => {
            this.r = (await ctx.storage.get("r")) || fresh();
            this.strokes.list = (await ctx.storage.get("sk")) || [];
        });
        if (typeof WebSocketRequestResponsePair !== "undefined") {
            ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
        }
    }

    /* ───────── plumbing ───────── */
    live() { return this.ctx.getWebSockets().filter((w) => w.readyState === 1); }
    who(ws) { try { return ws.deserializeAttachment() || null; } catch { return null; } }
    online(pid, except) { return this.live().some((w) => w !== except && this.who(w)?.pid === pid); }
    send(ws, o) { try { ws.send(typeof o === "string" ? o : JSON.stringify(o)); } catch { } }
    save() { return this.ctx.storage.put("r", this.r); }
    saveStrokes() { return this.ctx.storage.put("sk", this.strokes.list); }
    name(pid) { return this.r.names[pid] || "player"; }
    isIn(pid) { return this.r.seats.includes(pid) || !!this.r.players[pid]; }

    snap(pid, admin) {
        const r = this.r;
        const o = {
            t: "snap", rev: r.rev, now: Date.now(), game: r.game, phase: r.phase, host: r.host,
            you: { pid, admin, seat: r.seats.indexOf(pid), host: r.host === pid, player: !!r.players[pid] },
        };
        if (TURN_GAMES[r.game]) {
            o.seats = r.seats.map((p) => (p ? { pid: p, name: this.name(p), online: this.online(p) } : null));
            o.rematch = r.rematch;
            if (r.gs) o.gs = TURN_GAMES[r.game].view(r.gs);
        } else if (r.game === "draw") {
            o.players = Object.keys(r.players).map((p) => ({ pid: p, name: this.name(p), online: this.online(p) }));
            o.max = draw.MAX_PLAYERS;
            o.gs = draw.view(r.gs, pid);
        }
        return o;
    }

    broadcast() {
        this.r.rev++;
        for (const ws of this.live()) {
            const a = this.who(ws);
            if (a) this.send(ws, this.snap(a.pid, a.admin));
        }
    }

    async commit() {                    // save, schedule the next timer, tell everyone
        this.r.touched = Date.now();
        await this.save();
        await this.schedule();
        this.broadcast();
    }

    async schedule() {
        const r = this.r;
        let next = r.touched + IDLE_MS;
        for (const ts of Object.values(r.disc)) next = Math.min(next, ts + DISC_MS);
        if (r.game === "draw") { const d = draw.deadline(r.gs); if (d) next = Math.min(next, d); }
        await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 50));
    }

    limited(pid) {
        const now = Date.now(), e = this.rate.get(pid) || { t: now, n: 0 };
        if (now - e.t > 1000) { e.t = now; e.n = 0; }
        e.n++;
        this.rate.set(pid, e);
        if (this.rate.size > 500) for (const [k, v] of this.rate) if (now - v.t > 5000) this.rate.delete(k);
        return e.n > 90;
    }

    /* ───────── connections ───────── */
    async fetch(request) {
        if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
        const pid = request.headers.get("x-sl-pid") || "";
        const name = (request.headers.get("x-sl-name") || "player").slice(0, 32);
        const admin = request.headers.get("x-sl-admin") === "1";
        if (!pid) return new Response("forbidden", { status: 403 });
        if (this.live().length >= MAX_SOCKETS) return new Response("room is full", { status: 503 });

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ pid, name, admin });

        const r = this.r;
        r.names[pid] = name;
        if (Object.keys(r.names).length > 120) {          // forget people who aren't here or playing
            const here = new Set(this.live().map((w) => this.who(w)?.pid));
            for (const p of Object.keys(r.names)) if (!here.has(p) && !this.isIn(p) && p !== pid) delete r.names[p];
        }
        delete r.disc[pid];
        await this.commit();                                // sends everyone (including this socket) a fresh snapshot
        if (r.game === "draw" && this.strokes.list.length) this.send(server, { t: "strokes", list: this.strokes.list });
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketClose(ws, code) {
        try { ws.close(code && code !== 1005 && code !== 1006 ? code : 1000, "bye"); } catch { }
        await this.gone(ws);
    }
    async webSocketError(ws) { await this.gone(ws); }

    async gone(ws) {
        const a = this.who(ws);
        if (!a || !this.isIn(a.pid) || this.online(a.pid, ws)) return;      // only a player going offline matters
        this.r.disc[a.pid] = Date.now();
        await this.commit();
    }

    /* ───────── messages ───────── */
    async webSocketMessage(ws, raw) {
        if (typeof raw !== "string" || raw.length > MAX_MSG || raw === "ping") return;
        const a = this.who(ws);
        if (!a) return;
        if (this.limited(a.pid)) return this.send(ws, { t: "err", error: "slow down" });
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (!m || typeof m.t !== "string") return;
        const res = this.handle(ws, a, m, Date.now());
        if (res?.error) this.send(ws, { t: "err", error: res.error });
        if (res?.changed) await this.commit();
    }

    reset() {
        const names = this.r.names;
        this.r = fresh();
        this.r.names = names;
        this.strokes.list = [];
        this.saveStrokes();
    }

    startTurnGame(swap = Math.random() < 0.5) {            // first game: coin flip. rematch: swap sides
        const r = this.r;
        if (swap) r.seats.reverse();
        r.gs = TURN_GAMES[r.game].init();
        r.phase = "play";
        r.rematch = [false, false];
    }

    startDraw(now, rounds) {
        const r = this.r;
        r.gs = draw.init(Object.keys(r.players), rounds);
        r.phase = "play";
        draw.nextTurn({ r, strokes: this.strokes }, now);
        this.saveStrokes();
    }

    handle(ws, a, m, now) {
        const r = this.r, pid = a.pid, seat = r.seats.indexOf(pid);
        r.touched = now;
        switch (m.t) {
            case "new": {
                if (r.phase !== "idle") return { error: "a game is already running here" };
                if (!GAMES.has(m.game)) return { error: "unknown game" };
                r.game = m.game; r.phase = "lobby"; r.host = pid; r.gs = null; r.rematch = [false, false];
                r.seats = [null, null]; r.players = {};
                if (m.game === "draw") r.players[pid] = {}; else r.seats[0] = pid;
                this.strokes.list = []; this.saveStrokes();
                return { changed: true };
            }
            case "join": {
                if (r.game === "draw") {
                    if (r.phase === "idle" || r.phase === "over") return { error: "can't join right now" };
                    if (r.players[pid]) return {};
                    if (Object.keys(r.players).length >= draw.MAX_PLAYERS) return { error: "the game is full" };
                    r.players[pid] = {};
                    if (r.gs) r.gs.scores[pid] = r.gs.scores[pid] || 0;
                    return { changed: true };
                }
                if (r.phase !== "lobby") return { error: "can't join right now" };
                if (seat >= 0) return {};
                if (r.seats[1]) return { error: "the game is full" };
                r.seats[1] = pid;
                this.startTurnGame();
                return { changed: true };
            }
            case "leave": return this.leave(pid, now);
            case "start": {
                if (r.game !== "draw" || r.phase !== "lobby") return { error: "nothing to start" };
                if (r.host !== pid) return { error: "only the host can start" };
                if (Object.keys(r.players).length < 2) return { error: "need at least 2 players" };
                this.startDraw(now, m.rounds);
                return { changed: true };
            }
            case "resign": {
                if (!TURN_GAMES[r.game] || r.phase !== "play" || seat < 0) return {};
                r.gs.over = { winner: 1 - seat, reason: "resignation" };
                r.phase = "over";
                return { changed: true };
            }
            case "again": {
                if (r.phase !== "over") return {};
                if (r.game === "draw") {
                    if (r.host !== pid) return { error: "only the host can restart" };
                    if (Object.keys(r.players).length < 2) return { error: "need at least 2 players" };
                    this.startDraw(now, r.gs?.rounds);
                    return { changed: true };
                }
                if (seat < 0) return {};
                r.rematch[seat] = true;
                if (r.rematch[0] && r.rematch[1] && r.seats[0] && r.seats[1]) this.startTurnGame(true);
                return { changed: true };
            }
            case "close": {
                if (r.phase === "idle") return {};
                let ok = a.admin;
                if (!ok && (r.phase === "lobby" || r.phase === "over")) ok = this.isIn(pid) || r.host === pid;
                if (!ok && r.phase === "play") ok = r.game === "draw" && r.host === pid;
                if (!ok) return { error: r.phase === "play" ? "resign instead (only the host or an admin can end a running game)" : "not allowed" };
                this.reset();
                return { changed: true };
            }
            case "move": case "draw": case "decline": {
                if (!TURN_GAMES[r.game] || r.phase !== "play") return { error: "no game running" };
                if (seat < 0) return { error: "you're not playing" };
                const res = TURN_GAMES[r.game].act(r.gs, seat, m);
                if (res.error) return res;
                if (r.gs.over) r.phase = "over";
                return { changed: true };
            }
            case "sb": case "sp": case "se": case "clear": case "undo": return this.stroke(ws, a, m);
            case "guess": return this.guess(ws, a, m, now);
            default: return {};
        }
    }

    leave(pid, now) {
        const r = this.r;
        if (TURN_GAMES[r.game]) {
            const seat = r.seats.indexOf(pid);
            if (seat < 0) return {};
            if (r.phase === "lobby") {
                r.seats[seat] = null;
                if (!r.seats[0] && r.seats[1]) r.seats = [r.seats[1], null];
                if (!r.seats[0]) this.reset(); else r.host = r.seats[0];
            } else if (r.phase === "play") {
                r.gs.over = { winner: 1 - seat, reason: "left the game" };
                r.phase = "over";
            }
            return { changed: true };
        }
        if (r.game === "draw" && r.players[pid]) { this.dropDraw(pid, now); return { changed: true }; }
        return {};
    }

    dropDraw(pid, now) {
        const r = this.r, env = { r, strokes: this.strokes };
        delete r.players[pid];
        const left = Object.keys(r.players);
        if (!left.length) return this.reset();
        if (r.host === pid) r.host = left[0];
        if (r.phase !== "play" || !r.gs) return;
        if (left.length < 2) { r.gs.sub = "over"; r.gs.endsAt = 0; r.phase = "over"; return; }
        if (r.gs.sub === "draw") {
            const gs = r.gs;
            if (gs.drawer === pid) draw.endTurn(env, now);
            else if (left.filter((p) => p !== gs.drawer).every((p) => gs.guessed[p] !== undefined)) draw.endTurn(env, now);
        }
    }

    // a player stayed disconnected too long
    dropped(pid, now) {
        const r = this.r;
        if (TURN_GAMES[r.game]) {
            const seat = r.seats.indexOf(pid);
            if (seat < 0) return;
            if (r.phase === "play") { r.gs.over = { winner: 1 - seat, reason: "left the game" }; r.phase = "over"; }
            else if (r.phase === "lobby") this.leave(pid, now);
            else if (r.phase === "over" && !r.seats.some((p) => p && p !== pid && this.online(p))) this.reset();
        } else if (r.game === "draw") this.dropDraw(pid, now);
    }

    guess(ws, a, m, now) {
        const r = this.r, pid = a.pid;
        if (r.game !== "draw" || r.phase !== "play" || r.gs?.sub !== "draw" || !r.players[pid]) return {};
        const text = typeof m.text === "string" ? m.text.replace(/\s+/g, " ").trim() : "";
        if (!okGuess(text)) return { error: "letters and numbers only, no bad words" };
        if (now - (this.lastGuess.get(pid) || 0) < 600) return { error: "slow down" };
        this.lastGuess.set(pid, now);
        const gs = r.gs, n = this.name(pid);
        const tell = (to, o) => { for (const w of this.live()) { const p = this.who(w)?.pid; if (to(p)) this.send(w, o); } };
        if (pid === gs.drawer || gs.guessed[pid] !== undefined) {                         // chat between the drawer and people who already guessed
            tell((p) => p === gs.drawer || gs.guessed[p] !== undefined, { t: "msg", k: "team", n, text });
            return {};
        }
        const res = draw.guess({ r, strokes: this.strokes }, pid, text, now);
        if (res.kind === "correct") {
            tell(() => true, { t: "msg", k: "ok", n, text: `${n} guessed the word!` });
            return { changed: true };
        }
        if (res.kind === "close") this.send(ws, { t: "msg", k: "close", text: "so close!" });
        tell(() => true, { t: "msg", k: "g", n, text });
        return {};
    }

    stroke(ws, a, m) {
        const r = this.r, gs = r.gs;
        if (r.game !== "draw" || r.phase !== "play" || gs?.sub !== "draw" || gs.drawer !== a.pid) return {};
        const list = this.strokes.list;
        let out;
        if (m.t === "sb") {
            if (list.length >= MAX_STROKES) return { error: "too many strokes, clear the canvas" };
            const s = { id: int(m.id, 0, 1e9), c: int(m.c, 0, 15), w: int(m.w, 1, 40), p: [int(m.x, 0, 1000), int(m.y, 0, 1000)] };
            list.push(s);
            out = { t: "sb", id: s.id, c: s.c, w: s.w, x: s.p[0], y: s.p[1] };
        } else if (m.t === "sp") {
            if (!Array.isArray(m.p) || m.p.length < 2 || m.p.length > 120 || m.p.length % 2) return {};
            const id = int(m.id, 0, 1e9);
            let s;
            for (let i = list.length - 1; i >= 0; i--) if (list[i].id === id) { s = list[i]; break; }
            if (!s || s.p.length + m.p.length > MAX_STROKE_NUMS) return {};
            const p = m.p.map((v) => int(v, 0, 1000));
            s.p.push(...p);
            out = { t: "sp", id, p };
        } else if (m.t === "se") {
            out = { t: "se", id: int(m.id, 0, 1e9) };
            this.saveStrokes();
        } else if (m.t === "undo") {
            list.pop(); out = { t: "undo" }; this.saveStrokes();
        } else {
            list.length = 0; out = { t: "clear" }; this.saveStrokes();
        }
        const data = JSON.stringify(out);
        for (const w of this.live()) if (this.who(w)?.pid !== a.pid) this.send(w, data);
        return {};
    }

    /* ───────── timers ───────── */
    async alarm() {
        const r = this.r, now = Date.now();
        let changed = false;
        for (const [pid, ts] of Object.entries(r.disc)) {
            if (now - ts < DISC_MS) continue;
            delete r.disc[pid];
            if (!this.online(pid)) { this.dropped(pid, now); changed = true; }
        }
        if (r.game === "draw" && r.gs) {
            const d = draw.deadline(r.gs);
            if (d && now >= d) { draw.tick({ r, strokes: this.strokes }, now); this.saveStrokes(); changed = true; }
        }
        if (this.live().length) r.touched = now;
        else if (now - r.touched >= IDLE_MS) {            // nobody around for an hour: forget it
            await this.ctx.storage.deleteAll();
            this.r = fresh(); this.strokes.list = [];
            return;
        }
        if (changed) await this.commit();
        else { await this.save(); await this.schedule(); }
    }
}
