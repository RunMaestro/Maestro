/**
 * Who asked for this turn: you, or an automation acting on your behalf.
 *
 * Every agent turn Maestro runs - one you typed, an Auto Run task, a Cue
 * subscription firing - ends up as the same thing on the machine: an ordinary
 * agent process, same binary, same arguments, same working directory, writing
 * to the same provider transcript. Nothing outside Maestro can tell them
 * apart. Tooling that hangs off the agent (Claude Code hooks, wrapper scripts,
 * telemetry sidecars) sees an identical process either way, so the only signal
 * left to it is the prompt text - which is a guess, not an answer, because Cue
 * prompts are the user's own words from `cue.yaml` and read exactly like
 * something a human typed.
 *
 * So Maestro states it outright. Every spawn stamps {@link QUERY_SOURCE_ENV_VAR}
 * into the child environment, and anything downstream of the process boundary
 * can read it without guessing. The variable is a stable external contract:
 * renaming it or changing the vocabulary breaks consumers that live outside
 * this repo.
 *
 * The value describes ORIGIN, not autonomy. A `user` turn whose prompt says
 * "go fix everything" is still `user`; an `auto` turn is `auto` even if it does
 * nothing. The distinction being drawn is only "did a human have to steer this
 * one".
 */

/**
 * Environment variable carrying the {@link QuerySource} of the turn being run.
 * Present on every agent process Maestro spawns, including PTY/TUI spawns and
 * the child `claude` that maestro-p drives (its env sanitizer strips only an
 * explicit denylist of Claude session-identity vars, so this passes through).
 */
export const QUERY_SOURCE_ENV_VAR = 'MAESTRO_QUERY_SOURCE';

/**
 * - `user` - a human sent this prompt: the composer, a slash command, the
 *   web/mobile remote, a fork or transfer. The default for anything that has
 *   not said otherwise.
 * - `auto` - Auto Run dispatched it from a playbook or task list.
 * - `cue`  - a Cue subscription fired it (file change, schedule, PR event,
 *   chained completion).
 */
export type QuerySource = 'user' | 'auto' | 'cue';

/**
 * What a spawn is assumed to be when no caller claims it. Ties break toward
 * the human: over-reporting delegation would flatter the numbers, and the
 * point of the marker is to be trusted.
 */
export const DEFAULT_QUERY_SOURCE: QuerySource = 'user';
