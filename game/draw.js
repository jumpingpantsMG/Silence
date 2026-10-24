// drawing game (draw something, the others guess it). Server-authoritative: the word never leaves
// the server except to the drawer, to players who already guessed it, and when a turn ends.
//
// gs: { rounds, round, queue: [pid], sub: "draw" | "reveal" | "over", drawer, word, shown: [index],
//       startedAt, endsAt, total, hintAt: [ms timestamps], guessed: { pid: points }, scores: { pid: n },
//       lastWord, turns }
export const id = "draw";
export const name = "drawing game";
export const MAX_PLAYERS = 8;
export const TURN_MS = 80000;
export const REVEAL_MS = 5000;

const WORDS = `cat dog house tree sun moon star cloud rain snow fish bird horse cow pig sheep duck frog snake spider
bee butterfly ant elephant giraffe lion tiger bear monkey zebra penguin shark whale dolphin octopus crab turtle rabbit
mouse owl eagle dinosaur dragon unicorn robot alien ghost pirate wizard knight king queen princess ninja clown
pizza burger hotdog sandwich cake cookie donut ice-cream popcorn pancake banana apple orange grapes strawberry
watermelon pineapple carrot corn broccoli egg cheese bread soup coffee milk
car bus train plane boat bicycle motorcycle truck helicopter rocket submarine tractor skateboard scooter
bed chair table lamp door window clock mirror couch television computer phone keyboard camera headphones
book pencil scissors backpack umbrella glasses hat shoe sock shirt dress jacket crown ring key lock
guitar piano drum violin trumpet microphone
ball kite balloon present candle flag trophy medal puzzle dice
mountain river beach island volcano forest desert bridge castle tent lighthouse windmill igloo
flower rose cactus mushroom leaf grass rainbow lightning tornado fire
hand foot eye nose mouth ear heart tooth skeleton
sword shield arrow bow hammer axe ladder anchor compass map
bridge fence tower church school hospital stadium
swimming sleeping running dancing singing fishing camping
football basketball tennis golf bowling skiing surfing
snowman scarecrow mermaid vampire zombie superhero
battery magnet telescope microscope lightbulb`.split(/\s+/).map((w) => w.replace(/-/g, " "));

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

function lev1(a, b) {                       // true when the words are exactly one edit apart
    if (a === b || Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

export function init(pids, rounds) {
    return {
        rounds: Math.min(3, Math.max(1, rounds | 0 || 2)), round: 1, queue: shuffle(pids), sub: "draw", drawer: "",
        word: "", shown: [], startedAt: 0, endsAt: 0, total: TURN_MS, hintAt: [], guessed: {},
        scores: Object.fromEntries(pids.map((p) => [p, 0])), lastWord: "", turns: 0,
    };
}

// starts the next turn, or finishes the game. env = { r, strokes: { list } }
export function nextTurn(env, now) {
    const gs = env.r.gs, players = env.r.players;
    for (; ;) {
        while (gs.queue.length && !players[gs.queue[0]]) gs.queue.shift();
        if (gs.queue.length) break;
        if (gs.round >= gs.rounds) { gs.sub = "over"; gs.endsAt = 0; env.r.phase = "over"; return; }
        gs.round++;
        gs.queue = shuffle(Object.keys(players));
    }
    gs.drawer = gs.queue.shift();
    gs.word = WORDS[(Math.random() * WORDS.length) | 0];
    gs.shown = [];
    gs.sub = "draw";
    gs.startedAt = now;
    gs.total = TURN_MS;
    gs.endsAt = now + TURN_MS;
    gs.hintAt = [now + TURN_MS * 0.5, now + TURN_MS * 0.75];
    gs.guessed = {};
    gs.turns++;
    env.strokes.list = [];
}

export function endTurn(env, now) {
    const gs = env.r.gs;
    if (gs.sub !== "draw") return;
    gs.sub = "reveal";
    gs.lastWord = gs.word;
    gs.endsAt = now + REVEAL_MS;
    gs.hintAt = [];
}

// called from the room's alarm: ends turns, starts the next one, reveals hints
export function tick(env, now) {
    const gs = env.r.gs;
    if (!gs || gs.sub === "over") return;
    if (gs.sub === "draw") {
        while (gs.hintAt.length && now >= gs.hintAt[0]) {
            gs.hintAt.shift();
            const hidden = [...gs.word].map((c, i) => i).filter((i) => gs.word[i] !== " " && !gs.shown.includes(i));
            if (hidden.length > 1) gs.shown.push(hidden[(Math.random() * hidden.length) | 0]);
        }
        if (now >= gs.endsAt) endTurn(env, now);
    } else if (gs.sub === "reveal" && now >= gs.endsAt) nextTurn(env, now);
}

export function deadline(gs) {
    if (!gs || gs.sub === "over" || !gs.endsAt) return 0;
    return gs.sub === "draw" && gs.hintAt.length ? Math.min(gs.endsAt, gs.hintAt[0]) : gs.endsAt;
}

// returns { kind: "correct" | "close" | "wrong" | "ignored", pts? }
export function guess(env, pid, text, now) {
    const gs = env.r.gs;
    if (!gs || gs.sub !== "draw" || pid === gs.drawer || gs.guessed[pid] !== undefined || !env.r.players[pid]) return { kind: "ignored" };
    const g = norm(text);
    if (g === gs.word) {
        const left = Math.max(0, gs.endsAt - now) / gs.total;
        const pts = Math.round(50 + 150 * left);
        gs.guessed[pid] = pts;
        gs.scores[pid] = (gs.scores[pid] || 0) + pts;
        gs.scores[gs.drawer] = (gs.scores[gs.drawer] || 0) + 25;
        const guessers = Object.keys(env.r.players).filter((p) => p !== gs.drawer);
        if (guessers.every((p) => gs.guessed[p] !== undefined)) endTurn(env, now);
        return { kind: "correct", pts };
    }
    if (gs.word.length >= 4 && lev1(g, gs.word)) return { kind: "close" };
    return { kind: "wrong" };
}

export function view(gs, pid) {
    if (!gs) return null;
    const reveal = gs.sub !== "draw" || pid === gs.drawer || gs.guessed[pid] !== undefined;
    const mask = [...gs.word].map((c, i) => (c === " " ? " " : reveal || gs.shown.includes(i) ? c : "_")).join("");
    return {
        sub: gs.sub, turn: gs.turns, round: gs.round, rounds: gs.rounds, drawer: gs.drawer, endsAt: gs.endsAt, total: gs.total,
        len: gs.word.length, mask: gs.sub === "over" ? "" : mask, guessed: Object.keys(gs.guessed),
        pts: gs.guessed, scores: gs.scores, lastWord: gs.lastWord,
    };
}
