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
 * Collapse the stored `(enableMaestroP, maestroPMode)` pair into the canonical
 * tri-state. The single source of truth every spawn surface reads through.
 */
export function getClaudeTokenMode(src: ClaudeTokenModeSource | null | undefined): ClaudeTokenMode {
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
