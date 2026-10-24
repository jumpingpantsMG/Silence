// tic-tac-toe. seat 0 = X (moves first), seat 1 = O.
// state: { b: [9] of 0 | 1 | 2, turn: 0 | 1, over: null | { winner: 0 | 1 | -1, reason }, line: null | [i, i, i], last: number }
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

export const id = "ttt";
export const name = "tic-tac-toe";

export const init = () => ({ b: Array(9).fill(0), turn: 0, over: null, line: null, last: -1 });

export function act(s, seat, msg) {
    if (msg.t !== "move") return { error: "unknown action" };
    if (s.over) return { error: "game is over" };
    if (seat !== s.turn) return { error: "not your turn" };
    const i = msg.i;
    if (!Number.isInteger(i) || i < 0 || i > 8) return { error: "bad square" };
    if (s.b[i]) return { error: "square taken" };
    s.b[i] = seat + 1;
    s.last = i;
    for (const l of LINES) {
        if (s.b[l[0]] && s.b[l[0]] === s.b[l[1]] && s.b[l[1]] === s.b[l[2]]) {
            s.over = { winner: seat, reason: "three in a row" };
            s.line = l;
            return { ok: true };
        }
    }
    if (s.b.every(Boolean)) { s.over = { winner: -1, reason: "board full" }; return { ok: true }; }
    s.turn = 1 - seat;
    return { ok: true };
}

export const view = (s) => s;
