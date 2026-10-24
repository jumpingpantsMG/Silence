// connect four. 7 columns x 6 rows. seat 0 = red (moves first), seat 1 = yellow.
// state: { b: [42] row-major from the top (index = row * 7 + col), turn, over, line: null | [4 cells], last }
export const id = "c4";
export const name = "connect four";

const W = 7, H = 6;

export const init = () => ({ b: Array(W * H).fill(0), turn: 0, over: null, line: null, last: -1 });

function findWin(b, last, who) {
    const r0 = Math.floor(last / W), c0 = last % W;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const cells = [last];
        for (const sgn of [1, -1]) {
            let r = r0 + dr * sgn, c = c0 + dc * sgn;
            while (r >= 0 && r < H && c >= 0 && c < W && b[r * W + c] === who) {
                cells.push(r * W + c);
                r += dr * sgn; c += dc * sgn;
            }
        }
        if (cells.length >= 4) return cells.slice(0, 4);
    }
    return null;
}

export function act(s, seat, msg) {
    if (msg.t !== "move") return { error: "unknown action" };
    if (s.over) return { error: "game is over" };
    if (seat !== s.turn) return { error: "not your turn" };
    const c = msg.c;
    if (!Number.isInteger(c) || c < 0 || c >= W) return { error: "bad column" };
    let r = H - 1;
    while (r >= 0 && s.b[r * W + c]) r--;
    if (r < 0) return { error: "column is full" };
    const at = r * W + c;
    s.b[at] = seat + 1;
    s.last = at;
    const line = findWin(s.b, at, seat + 1);
    if (line) { s.over = { winner: seat, reason: "four in a row" }; s.line = line; return { ok: true }; }
    if (s.b.every(Boolean)) { s.over = { winner: -1, reason: "board full" }; return { ok: true }; }
    s.turn = 1 - seat;
    return { ok: true };
}

export const view = (s) => s;
