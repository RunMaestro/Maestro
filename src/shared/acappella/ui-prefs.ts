/**
 * The A Cappella UI preferences: what the HUD remembers between runs.
 *
 * Persisted under `ui` inside the same `acappella` settings blob everything else
 * in this feature uses, for the reason given in `useVoiceControls.ts`: A
 * Cappella's configuration is ONE object, and splitting a boolean across
 * `settingsMetadata`, `defaults.ts`, and the settings store would mean four
 * files to keep in step for a value only this feature reads.
 *
 * Pure and shared because the Settings panel writes these, the HUD reads them,
 * and the tests need to widen a half-written blob without a DOM.
 */

/** Where the user dragged the HUD, in viewport pixels from the top-left. */
export interface VoiceHudPosition {
	top: number;
	left: number;
}

/**
 * What minimizing does when the user is not the one asking.
 *
 *   - `manual` - the HUD only collapses when the minimize button is pressed.
 *   - `auto-idle` - it also collapses on its own once a turn finishes and the
 *     session goes quiet, and expands again the moment there is something to
 *     show.
 *
 * Never a third option that closes the session: minimize and close are
 * different actions and the whole point of the pair is that one of them does not
 * touch the microphone.
 */
export type VoiceHudMinimizeBehavior = 'manual' | 'auto-idle';

export interface VoiceUiPrefs {
	/** Whether the live transcript panel is open. Off by default. */
	transcriptVisible: boolean;
	/** Remembered HUD position, or null for the default bottom-right placement. */
	hudPosition: VoiceHudPosition | null;
	minimizeBehavior: VoiceHudMinimizeBehavior;
}

export const DEFAULT_VOICE_UI_PREFS: VoiceUiPrefs = {
	// Off by default: the HUD is meant to be something you are happy to leave on
	// screen all day, and a scrolling transcript is not that. It is one click
	// away and it remembers the answer.
	transcriptVisible: false,
	hudPosition: null,
	minimizeBehavior: 'manual',
};

/** A position is only usable if both numbers are real. Half a position is none. */
export function readVoiceHudPosition(value: unknown): VoiceHudPosition | null {
	if (typeof value !== 'object' || value === null) return null;
	const { top, left } = value as Record<string, unknown>;
	if (typeof top !== 'number' || !Number.isFinite(top)) return null;
	if (typeof left !== 'number' || !Number.isFinite(left)) return null;
	return { top, left };
}

/** Widen a stored `ui` object into a complete prefs object. */
export function readVoiceUiPrefs(stored: Record<string, unknown> | undefined): VoiceUiPrefs {
	const raw = stored ?? {};
	return {
		transcriptVisible: raw.transcriptVisible === true,
		hudPosition: readVoiceHudPosition(raw.hudPosition),
		minimizeBehavior: raw.minimizeBehavior === 'auto-idle' ? 'auto-idle' : 'manual',
	};
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Gap from the viewport edge for the default placement. */
export const VOICE_HUD_EDGE_MARGIN = 16;

export interface VoiceHudSize {
	width: number;
	height: number;
}

export interface VoiceHudViewport {
	width: number;
	height: number;
}

/**
 * Pull a position back on screen.
 *
 * Two things make this necessary rather than decorative: a position saved on a
 * second monitor that is no longer attached, and a window the user just made
 * smaller. Either one leaves the HUD entirely outside the viewport, and a
 * floating widget with a live microphone that cannot be seen is the exact
 * failure the close button exists to prevent.
 */
export function clampVoiceHudPosition(
	position: VoiceHudPosition,
	size: VoiceHudSize,
	viewport: VoiceHudViewport
): VoiceHudPosition {
	return {
		left: Math.round(
			Math.min(Math.max(position.left, 0), Math.max(0, viewport.width - size.width))
		),
		top: Math.round(
			Math.min(Math.max(position.top, 0), Math.max(0, viewport.height - size.height))
		),
	};
}

/** Opening placement: bottom-right, inset by the edge margin. */
export function defaultVoiceHudPosition(
	size: VoiceHudSize,
	viewport: VoiceHudViewport
): VoiceHudPosition {
	return clampVoiceHudPosition(
		{
			left: viewport.width - size.width - VOICE_HUD_EDGE_MARGIN,
			top: viewport.height - size.height - VOICE_HUD_EDGE_MARGIN,
		},
		size,
		viewport
	);
}
