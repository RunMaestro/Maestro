/**
 * restartPendingStore — tracks a deferred "restart to apply update" request.
 *
 * Set by the user when they want the downloaded update to install as soon as
 * the app reaches an idle state (no busy sessions, no active Auto Run batches).
 * `useRestartWhenIdle` watches this flag and fires `updates.install()` on the
 * idle transition.
 */

import { create } from 'zustand';

interface RestartPendingState {
	pending: boolean;
	setPending: (pending: boolean) => void;
}

export const useRestartPendingStore = create<RestartPendingState>((set) => ({
	pending: false,
	setPending: (pending) => set({ pending }),
}));
