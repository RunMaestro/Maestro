/**
 * Claude Token-Source Mode
 *
 * Claude Code can spend either Max-plan quota (by driving the real claude TUI
 * through `maestro-p`) or per-token API credit (`claude --print`). A Maestro
 * agent picks one of three behaviors:
 *
 *   - `api`         always `claude --print` (per-token API credit)
 *   - `interactive` always the maestro-p TUI (Max-plan quota)
 *   - `dynamic`     start interactive, fall back to API when the latest usage
 *                   snapshot shows a window at/above the limit threshold
 *
 * Storage keeps the legacy `enableMaestroP` boolean (the original Adaptive
 * toggle) plus a `maestroPMode` refinement so existing sessions migrate
 * losslessly: a pre-refinement session with the toggle on reads as `dynamic`
 * (its historical behavior), toggle off reads as `api`.
 */

export type ClaudeTokenMode = 'api' | 'interactive' | 'dynamic';

/** The persisted pair that encodes a token mode on a session / moderator config. */
export interface ClaudeTokenModeSource {
	/** Legacy Adaptive Mode opt-in. Off (or absent) means pure API. */
	enableMaestroP?: boolean;
	/** Refinement of the opt-in. Absent defaults to `dynamic` (legacy behavior). */
	maestroPMode?: 'interactive' | 'dynamic';
}

/**
 * The COMPLETE persisted Claude token-source set as stored on a Session (or
 * moderator config): the {@link ClaudeTokenModeSource} pair plus the optional
 * `maestroPPath` override (the "Path" field pointed directly at a maestro-p
 * binary). This is every field a spawn surface must forward for a Claude turn
 * to resolve the SAME token source the agent's own chat turn would.
 */
export interface ClaudeTokenSourceFields {
	/** Legacy Adaptive Mode opt-in. Off (or absent) means pure API. */
	enableMaestroP?: boolean;
	/** Refinement of the opt-in. Absent defaults to `dynamic` (legacy behavior). */
	maestroPMode?: 'interactive' | 'dynamic';
	/** Power-user override: a Path field pointed straight at a maestro-p binary. */
	maestroPPath?: string;
}

/**
 * Extract the canonical Claude token-source triple from a session (or any
 * object carrying the persisted fields).
 *
 * This is the single source of truth for "which token-source fields travel with
 * a spawn." Every surface that CANNOT hydrate the token mode from the persisted
 * session by id - tab naming and background synopsis both run under synthetic
 * session ids the `process:spawn` handler can't look up - MUST forward exactly
 * this set, or it can silently resolve a different provider than the chat
 * (e.g. carrying `enableMaestroP: true` but dropping `maestroPMode` downgrades
 * Dynamic to TUI). Centralizing the field selection makes a partial forward
 * structurally impossible: add a field here once and every caller inherits it.
 */
export function getClaudeTokenSourceFields(
	src: ClaudeTokenSourceFields | null | undefined
): ClaudeTokenSourceFields {
	return {
		enableMaestroP: src?.enableMaestroP,
		maestroPMode: src?.maestroPMode,
		maestroPPath: src?.maestroPPath,
	};
}

/** Options refining how an unconfigured source collapses. */
export interface GetClaudeTokenModeOptions {
	/**
	 * SSH-remote spawn. Flips the DEFAULT for an unconfigured agent from `api`
	 * to `interactive` (the remote maestro-p TUI): a remote agent the user
	 * spun up to run on their Max plan should default to the TUI, not per-token
	 * API credit. Only the never-chosen state (`enableMaestroP === undefined`)
	 * is affected - an explicit `false` (the user picked API) is still honored.
	 */
	sshEnabled?: boolean;
	/**
	 * Whether the SSH remote has `maestro-p` on its PATH (from a remote probe).
	 * When known to be `false`, the unconfigured SSH default flips back to `api`
	 * instead of `interactive`: the remote can't run the TUI, so defaulting to it
	 * would only exit 127. `undefined` (never probed) keeps the optimistic TUI
	 * default. Ignored when {@link sshEnabled} is not set.
	 */
	sshMaestroPAvailable?: boolean;
}

/**
 * Collapse the stored `(enableMaestroP, maestroPMode)` pair into the canonical
 * tri-state. The single source of truth every spawn surface reads through.
 *
 * Default (`enableMaestroP` unset): `api` locally, `interactive` over SSH (see
 * {@link GetClaudeTokenModeOptions.sshEnabled}). Note SSH never resolves to
 * `dynamic` at spawn time - the auto-switch reads a local usage snapshot that
 * can't see the remote account - so a stored `dynamic` on an SSH agent is
 * surfaced here unchanged but falls back to `api` in resolveClaudeSpawnMode.
 */
export function getClaudeTokenMode(
	src: ClaudeTokenModeSource | null | undefined,
	opts?: GetClaudeTokenModeOptions
): ClaudeTokenMode {
	// Remote default: an unconfigured SSH agent starts on the TUI (Max plan),
	// unless a probe has shown the remote has no maestro-p to run it - then API.
	if (opts?.sshEnabled && src?.enableMaestroP === undefined) {
		return opts.sshMaestroPAvailable === false ? 'api' : 'interactive';
	}
	if (!src?.enableMaestroP) {
		return 'api';
	}
	return src.maestroPMode === 'interactive' ? 'interactive' : 'dynamic';
}

/**
 * Inverse of {@link getClaudeTokenMode}: encode a tri-state back into the
 * stored pair. Keeps the legacy `enableMaestroP` boolean in sync so any reader
 * that hasn't migrated to the tri-state still behaves correctly.
 */
export function toClaudeTokenModeSource(mode: ClaudeTokenMode): Required<ClaudeTokenModeSource> {
	switch (mode) {
		case 'api':
			return { enableMaestroP: false, maestroPMode: 'dynamic' };
		case 'interactive':
			return { enableMaestroP: true, maestroPMode: 'interactive' };
		case 'dynamic':
			return { enableMaestroP: true, maestroPMode: 'dynamic' };
	}
}
