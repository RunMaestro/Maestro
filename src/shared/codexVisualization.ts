/**
 * Wire types for rendering a Codex `visualize` content reference inline.
 * See `src/main/codex-visualization.ts` for how the document is built.
 */

export interface CodexVisualizationLoadRequest {
	/** The agent that wrote the reference; picks its CODEX_HOME and SSH status. */
	sessionId?: string;
	/** Absolute path to the HTML fragment, as written in the reference. */
	path: string;
	title?: string;
}

/**
 * Why a visualization could not be rendered inline. Every failure falls back
 * to the file chip, so the reason only decides what the chip's hover says.
 */
export type CodexVisualizationFailure = 'remote' | 'no-runtime' | 'not-found' | 'invalid';

export type CodexVisualizationLoadResult =
	| { ok: true; id: string; revision: number }
	| { ok: false; reason: CodexVisualizationFailure; message: string };

/** Largest height the bridge may ask for, matching Codex's own shell. */
export const MAX_CODEX_VISUALIZATION_HEIGHT = 10_000;

/** Width of a `mode: "wide"` visualization, per the skill's contract. */
export const CODEX_VISUALIZATION_WIDE_MAX_WIDTH = 1024;
