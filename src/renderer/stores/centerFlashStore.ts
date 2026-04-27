/**
 * centerFlashStore - Zustand store for the unified Center Flash Message system.
 *
 * Center Flash is a momentary, exclusive (one-at-a-time), center-screen
 * confirmation overlay used for:
 *   - "Copy to Clipboard" acknowledgements
 *   - Quick mode-change / success notes triggered by user-initiated actions
 *   - External notifications fired via `maestro-cli notify flash`
 *
 * The look is **themed** — every theme produces a visually distinct flash by
 * default (`color: 'theme'` uses `theme.colors.accent`). Use one of the four
 * fixed colors when you want explicit semantics that do not depend on theme:
 *
 *   green  - succeeded
 *   yellow - heads-up / soft warning
 *   orange - more emphatic warning
 *   red    - failed / blocked
 *   theme  - default; matches the active theme's accent color (no semantic)
 *
 * For longer-lived, dismissable notifications with project/session context,
 * use the toast system (`notifyToast`) instead.
 *
 * notifyCenterFlash() is callable from anywhere (React components, services).
 */

import { create } from 'zustand';

// ============================================================================
// Types
// ============================================================================

/** Five canonical Center Flash colors. `theme` adapts to the active theme. */
export type CenterFlashColor = 'green' | 'yellow' | 'orange' | 'red' | 'theme';

export const CENTER_FLASH_COLORS: readonly CenterFlashColor[] = [
	'green',
	'yellow',
	'orange',
	'red',
	'theme',
] as const;

/**
 * Legacy semantic alias kept for back-compat. Prefer `CenterFlashColor`.
 *   success → green, info → theme, warning → yellow, error → red
 */
export type CenterFlashVariant = 'success' | 'info' | 'warning' | 'error';

const VARIANT_TO_COLOR: Record<CenterFlashVariant, CenterFlashColor> = {
	success: 'green',
	info: 'theme',
	warning: 'yellow',
	error: 'red',
};

export interface CenterFlash {
	id: number;
	message: string;
	detail?: string;
	color: CenterFlashColor;
	/** ms; 0 = no auto-dismiss */
	duration: number;
}

interface CenterFlashStoreState {
	active: CenterFlash | null;
}

interface CenterFlashStoreActions {
	/** Internal — callers should use notifyCenterFlash() / dismissCenterFlash(). */
	setActive: (flash: CenterFlash | null) => void;
}

export type CenterFlashStore = CenterFlashStoreState & CenterFlashStoreActions;

// ============================================================================
// Store
// ============================================================================

export const useCenterFlashStore = create<CenterFlashStore>()((set) => ({
	active: null,
	setActive: (active) => set({ active }),
}));

// ============================================================================
// Public API
// ============================================================================

export interface NotifyCenterFlashOptions {
	message: string;
	detail?: string;
	/** One of the 5 canonical colors. Default: `'theme'` (matches active theme). */
	color?: CenterFlashColor;
	/**
	 * @deprecated Use `color`. Accepted for back-compat; mapped to its color
	 * equivalent (success→green, info→theme, warning→yellow, error→red).
	 * If both `color` and `variant` are provided, `color` wins.
	 */
	variant?: CenterFlashVariant;
	/** ms; defaults to 1500. Use 0 for "no auto-dismiss". */
	duration?: number;
}

const DEFAULT_DURATION_MS = 1500;
const DEFAULT_COLOR: CenterFlashColor = 'theme';

let nextId = 1;
let activeTimer: ReturnType<typeof setTimeout> | null = null;

function clearActiveTimer() {
	if (activeTimer) {
		clearTimeout(activeTimer);
		activeTimer = null;
	}
}

function resolveColor(opts: NotifyCenterFlashOptions): CenterFlashColor {
	if (opts.color) return opts.color;
	if (opts.variant) return VARIANT_TO_COLOR[opts.variant];
	return DEFAULT_COLOR;
}

/**
 * Fire a center flash. Replaces any currently visible flash (no queue).
 * Returns the flash id.
 */
export function notifyCenterFlash(opts: NotifyCenterFlashOptions): number {
	clearActiveTimer();

	const flash: CenterFlash = {
		id: nextId++,
		message: opts.message,
		detail: opts.detail,
		color: resolveColor(opts),
		duration: opts.duration ?? DEFAULT_DURATION_MS,
	};

	useCenterFlashStore.getState().setActive(flash);

	if (flash.duration > 0) {
		activeTimer = setTimeout(() => {
			activeTimer = null;
			const current = useCenterFlashStore.getState().active;
			if (current?.id === flash.id) {
				useCenterFlashStore.getState().setActive(null);
			}
		}, flash.duration);
	}

	return flash.id;
}

/** Dismiss the current flash immediately (if any). */
export function dismissCenterFlash(): void {
	clearActiveTimer();
	useCenterFlashStore.getState().setActive(null);
}
