// Same idea as the chat filter in worker.js (blocked words with leet-speak and repeated letters),
// kept here so the game code doesn't depend on worker.js. Keep BLOCKED_WORDS in sync with it.
const BLOCKED_WORDS = ["fuck", "shit", "bitch", "cunt", "asshole"];
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s" };
const squash = (s) => s.replace(/(.)\1+/g, "$1");
const BLOCK_RE = new RegExp(`\\b(${BLOCKED_WORDS.map(squash).join("|")})\\b`);

export const blockedWord = (s) =>
    BLOCK_RE.test(squash(String(s).toLowerCase().replace(/[013457@$]/g, (c) => LEET[c]).replace(/[^a-z]+/g, " ")));

// guesses are short plain text: letters, numbers, spaces, ' and -. No dots or slashes, so no links.
export const okGuess = (s) => typeof s === "string" && /^[\p{L}\p{N} '\-]{1,30}$/u.test(s) && !blockedWord(s);
