/**
 * quitWhenIdleStore.ts
 *
 * Tracks whether the user armed "Quit when idle" from the quit-confirmation
 * modal. When armed, the app stays open but a watcher (useQuitWhenIdle) polls
 * for active operations and quits automatically once everything goes idle.
 */

import { create } from 'zustand';

interface QuitWhenIdleState {
	/** True while the app is waiting for operations to finish before quitting. */
	armed: boolean;
	/** Arm the deferred quit - the watcher will quit once nothing is running. */
	arm: () => void;
	/** Cancel the deferred quit - the app keeps running normally. */
	cancel: () => void;
}

export const useQuitWhenIdleStore = create<QuitWhenIdleState>((set) => ({
	armed: false,
	arm: () => set({ armed: true }),
	cancel: () => set({ armed: false }),
}));
