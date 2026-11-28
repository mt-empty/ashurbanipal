import fc from "fast-check";

// Every property file imports fc from here, so this config is set before any property runs.
// A failure prints its seed and path; FC_SEED=<seed> FC_PATH=<path> replays exactly that case.
const env = process.env;
const numRuns = env.FC_RUNS ? Number(env.FC_RUNS) : 200;
if (!Number.isInteger(numRuns) || numRuns < 1)
  throw new Error(`FC_RUNS must be a positive integer, not ${env.FC_RUNS}`);
fc.configureGlobal({
  numRuns,
  ...(env.FC_SEED ? { seed: Number(env.FC_SEED) } : {}),
  ...(env.FC_PATH ? { path: env.FC_PATH } : {}),
});

export { fc };

// Characters where string handling usually slips: whitespace beyond ASCII, astral
// code points (two UTF-16 units), a lone surrogate, quotes, and control characters.
export const TRICKY_CHARS = ['"', "'", "\\", "\u00a0", "\u2028", "é", "😀", "\ud800", "\u0000", "\u001f", "\u007f"];

// Any string, biased toward the characters above and toward empty.
export const anyString = (maxLength = 8): fc.Arbitrary<string> =>
  fc.oneof(
    { weight: 3, arbitrary: fc.string({ unit: "binary", maxLength }) },
    { weight: 1, arbitrary: fc.constantFrom("", ...TRICKY_CHARS) },
  );
