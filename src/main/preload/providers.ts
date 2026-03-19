/**
 * Preload API for provider error tracking
 *
 * Provides the window.maestro.providers namespace for:
 * - Querying error stats per provider (for ProviderPanel health dashboard)
 * - Clearing error tracking for a session (after manual provider switch)
 * - Subscribing to failover suggestion events
 */

import { ipcRenderer } from 'electron';
import type { ProviderErrorStats, FailoverSuggestion } from '../../shared/account-types';

/**
 * Creates the providers API object for preload exposure
 */
export function createProvidersApi() {
	return {
		/** Get error stats for a specific provider */
		getErrorStats: (toolType: string): Promise<ProviderErrorStats | null> =>
			ipcRenderer.invoke('providers:get-error-stats', toolType),

		/** Get error stats for all providers */
		getAllErrorStats: (): Promise<Record<string, ProviderErrorStats>> =>
			ipcRenderer.invoke('providers:get-all-error-stats'),

		/** Clear error tracking for a session (e.g., after manual provider switch) */
		clearSessionErrors: (sessionId: string): Promise<void> =>
			ipcRenderer.invoke('providers:clear-session-errors', sessionId),

		/** Subscribe to failover suggestion events */
		onFailoverSuggest: (handler: (data: FailoverSuggestion) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: FailoverSuggestion) =>
				handler(data);
			ipcRenderer.on('provider:failover-suggest', wrappedHandler);
			return () => ipcRenderer.removeListener('provider:failover-suggest', wrappedHandler);
		},
	};
}

/**
 * TypeScript type for the providers API
 */
export type ProvidersApi = ReturnType<typeof createProvidersApi>;
