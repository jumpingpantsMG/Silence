// chess, server-authoritative. seat 0 = white, seat 1 = black.
// Board: 64 strings, index = rank-from-top * 8 + file (0 = a8, 63 = h1). Upper case = white, lower case = black.
// state: { b, turn, cast, ep, half, full, rep, moves: [SAN...], legal: [[from, to]...], last: [from, to] | null,
//          check: king index when in check else -1, over: null | { winner: 0 | 1 | -1, reason } }
// Includes: castling, en passant, promotion, check / checkmate / stalemate, 50-move rule,
// threefold repetition, insufficient material. Draw offers are handled in act().
export const id = "chess";
export const name = "chess";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KG = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const BD = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const RD = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const isWhite = (p) => p >= "A" && p <= "Z";
const sqName = (i) => "abcdefgh"[i & 7] + (8 - (i >> 3));

export function fromFen(fen) {
    const [place, side, cast, ep, half, full] = fen.trim().split(/\s+/);
    const b = [];
    for (const ch of place.replace(/\//g, "")) {
        if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) b.push("");
        else b.push(ch);
    }
    return {
        b, turn: side === "w" ? 0 : 1, cast: cast === "-" ? "" : cast,
        ep: !ep || ep === "-" ? -1 : (8 - +ep[1]) * 8 + "abcdefgh".indexOf(ep[0]),
        half: +half || 0, full: +full || 1,
    };
}

const kingSq = (b, color) => b.indexOf(color === 0 ? "K" : "k");

function attacked(b, sq, by) {
    const r = sq >> 3, f = sq & 7;
    const own = by === 0 ? "PNBRQK" : "pnbrqk";
    const pr = by === 0 ? r + 1 : r - 1;
    if (pr >= 0 && pr < 8) {
        if (f > 0 && b[pr * 8 + f - 1] === own[0]) return true;
        if (f < 7 && b[pr * 8 + f + 1] === own[0]) return true;
    }
    for (const [dr, df] of KN) {
        const nr = r + dr, nf = f + df;
        if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8 && b[nr * 8 + nf] === own[1]) return true;
    }
    for (const [dr, df] of KG) {
        const nr = r + dr, nf = f + df;
        if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8 && b[nr * 8 + nf] === own[5]) return true;
    }
    for (const [dirs, a, q] of [[BD, own[2], own[4]], [RD, own[3], own[4]]]) {
        for (const [dr, df] of dirs) {
            let nr = r + dr, nf = f + df;
            while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
                const p = b[nr * 8 + nf];
                if (p) { if (p === a || p === q) return true; break; }
                nr += dr; nf += df;
            }
        }
    }
    return false;
}

// move = { f, t, p: promotion piece letter (lower case) or "", k: "" | "ep" | "dbl" | "ck" | "cq" }
function pseudo(st) {
    const { b, turn } = st, out = [];
    const white = turn === 0;
    for (let i = 0; i < 64; i++) {
        const p = b[i];
        if (!p || isWhite(p) !== white) continue;
        const r = i >> 3, f = i & 7, kind = p.toLowerCase();
        const push = (t, k = "", pr = "") => out.push({ f: i, t, p: pr, k });
        if (kind === "p") {
            const dir = white ? -1 : 1, start = white ? 6 : 1, last = white ? 0 : 7;
            const add = (t, k) => {
                if ((t >> 3) === last) for (const pr of "qrbn") push(t, k, pr);
                else push(t, k);
            };
            const one = (r + dir) * 8 + f;
            if (!b[one]) {
                add(one, "");
                const two = (r + 2 * dir) * 8 + f;
                if (r === start && !b[two]) push(two, "dbl");
            }
            for (const df of [-1, 1]) {
                const nf = f + df;
                if (nf < 0 || nf > 7) continue;
                const t = (r + dir) * 8 + nf;
                if (b[t] && isWhite(b[t]) !== white) add(t, "");
                else if (t === st.ep && !b[t]) push(t, "ep");
            }
        } else if (kind === "n" || kind === "k") {
            for (const [dr, df] of kind === "n" ? KN : KG) {
                const nr = r + dr, nf = f + df;
                if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
                const t = nr * 8 + nf;
                if (!b[t] || isWhite(b[t]) !== white) push(t);
            }
            if (kind === "k") {
                const home = white ? 60 : 4, opp = white ? 1 : 0;
                if (i === home && !attacked(b, home, opp)) {
                    const ks = white ? "K" : "k", qs = white ? "Q" : "q", rook = white ? "R" : "r";
                    if (st.cast.includes(ks) && b[home + 3] === rook && !b[home + 1] && !b[home + 2]
                        && !attacked(b, home + 1, opp) && !attacked(b, home + 2, opp)) push(home + 2, "ck");
                    if (st.cast.includes(qs) && b[home - 4] === rook && !b[home - 1] && !b[home - 2] && !b[home - 3]
                        && !attacked(b, home - 1, opp) && !attacked(b, home - 2, opp)) push(home - 2, "cq");
                }
            }
        } else {
            const dirs = kind === "b" ? BD : kind === "r" ? RD : [...BD, ...RD];
            for (const [dr, df] of dirs) {
                let nr = r + dr, nf = f + df;
                while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
                    const t = nr * 8 + nf;
                    if (b[t]) { if (isWhite(b[t]) !== white) push(t); break; }
                    push(t);
                    nr += dr; nf += df;
                }
            }
        }
    }
    return out;
}

// returns the position after the move (pure: does not touch st)
function play(st, mv) {
    const b = st.b.slice(), white = st.turn === 0;
    const p = b[mv.f];
    let cap = b[mv.t];
    b[mv.t] = mv.p ? (white ? mv.p.toUpperCase() : mv.p) : p;
    b[mv.f] = "";
    if (mv.k === "ep") { b[(mv.f >> 3) * 8 + (mv.t & 7)] = ""; cap = "p"; }
    if (mv.k === "ck") { b[mv.t - 1] = b[mv.t + 1]; b[mv.t + 1] = ""; }
    if (mv.k === "cq") { b[mv.t + 1] = b[mv.t - 2]; b[mv.t - 2] = ""; }
    let cast = st.cast;
    const strip = (chars) => { for (const c of chars) cast = cast.replace(c, ""); };
    if (p === "K") strip("KQ");
    if (p === "k") strip("kq");
    for (const sq of [mv.f, mv.t]) {
        if (sq === 63) strip("K"); else if (sq === 56) strip("Q"); else if (sq === 7) strip("k"); else if (sq === 0) strip("q");
    }
    return {
        b, turn: 1 - st.turn, cast,
        ep: mv.k === "dbl" ? (mv.f + mv.t) / 2 : -1,
        half: p.toLowerCase() === "p" || cap ? 0 : st.half + 1,
        full: st.full + (st.turn === 1 ? 1 : 0),
    };
}

export function legalMoves(st) {
    const out = [];
    for (const mv of pseudo(st)) {
        const n = play(st, mv);
        if (!attacked(n.b, kingSq(n.b, st.turn), 1 - st.turn)) out.push(mv);
    }
    return out;
}

export function perft(st, depth) {
    if (depth === 0) return 1;
    const ms = legalMoves(st);
    if (depth === 1) return ms.length;
    let n = 0;
    for (const mv of ms) n += perft(play(st, mv), depth - 1);
    return n;
}

const inCheck = (st) => attacked(st.b, kingSq(st.b, st.turn), 1 - st.turn);

function insufficient(b) {
    const rest = [];
    for (let i = 0; i < 64; i++) if (b[i] && b[i].toLowerCase() !== "k") rest.push([b[i].toLowerCase(), i]);
    if (!rest.length) return true;
    if (rest.length === 1) return rest[0][0] === "n" || rest[0][0] === "b";
    if (rest.every(([k]) => k === "b")) {
        const shade = ((rest[0][1] >> 3) + (rest[0][1] & 7)) & 1;
        return rest.every(([, i]) => (((i >> 3) + (i & 7)) & 1) === shade);
    }
    return false;
}

// repetition key: board, side, castling, and the en-passant square only when a pawn could really use it
function keyOf(st) {
    let ep = "";
    if (st.ep >= 0) {
        const pawn = st.turn === 0 ? "P" : "p", r = st.turn === 0 ? 3 : 4, f = st.ep & 7;
        if ((f > 0 && st.b[r * 8 + f - 1] === pawn) || (f < 7 && st.b[r * 8 + f + 1] === pawn)) ep = String(st.ep);
    }
    return st.b.map((x) => x || "-").join("") + st.turn + st.cast + ep;
}

function san(st, mv, legal) {
    if (mv.k === "ck") return "O-O";
    if (mv.k === "cq") return "O-O-O";
    const p = st.b[mv.f], kind = p.toUpperCase();
    const capture = !!st.b[mv.t] || mv.k === "ep";
    let s = "";
    if (kind === "P") {
        if (capture) s += "abcdefgh"[mv.f & 7];
    } else {
        s += kind;
        const rivals = legal.filter((m) => m.t === mv.t && m.f !== mv.f && st.b[m.f] === p);
        if (rivals.length) {
            const sameFile = rivals.some((m) => (m.f & 7) === (mv.f & 7));
            const sameRank = rivals.some((m) => (m.f >> 3) === (mv.f >> 3));
            if (!sameFile) s += "abcdefgh"[mv.f & 7];
            else if (!sameRank) s += 8 - (mv.f >> 3);
            else s += sqName(mv.f);
        }
    }
    if (capture) s += "x";
    s += sqName(mv.t);
    if (mv.p) s += "=" + mv.p.toUpperCase();
    return s;
}

// recompute everything derived from the position (legal moves, check, game over)
function refresh(s) {
    const legal = legalMoves(s);
    s.legal = [...new Set(legal.map((m) => m.f * 64 + m.t))].map((v) => [v >> 6, v & 63]);
    s.check = inCheck(s) ? kingSq(s.b, s.turn) : -1;
    if (!legal.length) s.over = s.check >= 0 ? { winner: 1 - s.turn, reason: "checkmate" } : { winner: -1, reason: "stalemate" };
    else if (insufficient(s.b)) s.over = { winner: -1, reason: "insufficient material" };
    else if (s.half >= 100) s.over = { winner: -1, reason: "50-move rule" };
    else if ((s.rep[keyOf(s)] || 0) >= 3) s.over = { winner: -1, reason: "threefold repetition" };
    return legal;
}

export function init() {
    const s = { ...fromFen(START_FEN), rep: {}, moves: [], last: null, over: null, drawOffer: -1 };
    s.rep[keyOf(s)] = 1;
    refresh(s);
    return s;
}

export function act(s, seat, msg) {
    if (s.over) return { error: "game is over" };
    if (msg.t === "draw") {                                  // offer / accept a draw
        if (s.drawOffer >= 0 && s.drawOffer !== seat) { s.over = { winner: -1, reason: "draw agreed" }; return { ok: true }; }
        s.drawOffer = seat;
        return { ok: true };
    }
    if (msg.t === "decline") { if (s.drawOffer >= 0 && s.drawOffer !== seat) s.drawOffer = -1; return { ok: true }; }
    if (msg.t !== "move") return { error: "unknown action" };
    if (seat !== s.turn) return { error: "not your turn" };
    const f = msg.from, t = msg.to;
    if (!Number.isInteger(f) || !Number.isInteger(t) || f < 0 || f > 63 || t < 0 || t > 63) return { error: "bad move" };
    const legal = legalMoves(s);
    const options = legal.filter((m) => m.f === f && m.t === t);
    if (!options.length) return { error: "illegal move" };
    const want = typeof msg.promo === "string" ? msg.promo.toLowerCase() : "q";
    const mv = options.length > 1 ? (options.find((m) => m.p === want) || options.find((m) => m.p === "q")) : options[0];

    const text = san(s, mv, legal);
    const n = play(s, mv);
    Object.assign(s, n);
    s.drawOffer = -1;
    s.last = [mv.f, mv.t];
    const k = keyOf(s);
    s.rep[k] = (s.rep[k] || 0) + 1;
    refresh(s);
    const suffix = s.over && s.over.reason === "checkmate" ? "#" : s.check >= 0 ? "+" : "";
    s.moves.push(text + suffix);
    return { ok: true };
}

export function view(s) {
    const { rep, ...rest } = s;
    return rest;
}
