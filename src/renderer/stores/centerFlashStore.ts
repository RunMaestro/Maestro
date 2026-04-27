/**
 * centerFlashStore - Zustand store for the unified Center Flash Message system.
 *
 * Center Flash is a momentary, exclusive (one-at-a-time), center-screen
 * confirmation overlay used for:
 *   - "Copy to Clipboard" acknowledgements
 *   - Quick success/info/warning notes triggered by user-initiated actions
 *
 * For longer-lived, dismissable notifications with project/session context,
 * use the toast system (notifyToast) instead.
 *
 * notifyCenterFlash() is callable from anywhere (React components, services).
 */

import { create } from 'zustand';

// ============================================================================
// Types
// ============================================================================

export type CenterFlashVariant = 'success' | 'info' | 'warning' | 'error';

export interface CenterFlash {
	id: number;
	message: string;
	detail?: string;
	variant: CenterFlashVariant;
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
	variant?: CenterFlashVariant;
	/** ms; defaults to 1500. Use 0 for "no auto-dismiss". */
	duration?: number;
}

const DEFAULT_DURATION_MS = 1500;

let nextId = 1;
let activeTimer: ReturnType<typeof setTimeout> | null = null;

function clearActiveTimer() {
	if (activeTimer) {
		clearTimeout(activeTimer);
		activeTimer = null;
	}
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
		variant: opts.variant ?? 'success',
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
