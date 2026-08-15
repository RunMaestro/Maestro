/**
 * Preload API for provider auth snapshots
 *
 * Provides the window.maestro.providerAuth namespace for:
 * - Reading every stored credential login state
 * - Re-probing one credential or all of them
 * - Marking a credential logged out
 * - Subscribing to snapshot changes pushed from main
 *
 * Types come from `shared/providerAuth`, never from `main/stores`, so the
 * renderer never pulls a main-process module into its bundle.
 */

import { ipcRenderer } from 'electron';
import type { ProviderAuthSnapshot, ProviderAuthSource } from '../../shared/providerAuth';

export type {
	CredentialIdentity,
	CredentialKind,
	ProviderAuthSnapshot,
	ProviderAuthSource,
	ProviderAuthStatus,
} from '../../shared/providerAuth';

/** One snapshot write pushed from main. `snapshot` is null when it was cleared. */
export interface ProviderAuthChange {
	key: string;
	snapshot: ProviderAuthSnapshot | null;
}

/** Counts from a probe pass, mirroring `StartupAuthProbeResult` in main. */
export interface ProviderAuthProbeCounts {
	identities: number;
	probed: number;
	skippedFresh: number;
	skippedNotInstalled: number;
	byStatus: Record<string, number>;
}

export interface ProviderAuthReprobeResult extends ProviderAuthProbeCounts {
	snapshot?: ProviderAuthSnapshot | null;
}

export interface ProviderAuthApi {
	getAll: () => Promise<Record<string, ProviderAuthSnapshot>>;
	reprobe: (key: string) => Promise<ProviderAuthReprobeResult>;
	reprobeAll: () => Promise<ProviderAuthProbeCounts>;
	markLoggedOut: (
		key: string,
		detail?: string,
		source?: ProviderAuthSource
	) => Promise<ProviderAuthSnapshot | null>;
	onChange: (callback: (change: ProviderAuthChange) => void) => () => void;
}

/**
 * Creates the provider auth API object for preload exposure
 */
export function createProviderAuthApi(): ProviderAuthApi {
	return {
		getAll: (): Promise<Record<string, ProviderAuthSnapshot>> =>
			ipcRenderer.invoke('providerAuth:getAll'),

		// Re-probe one credential by `CredentialIdentity.key`.
		reprobe: (key: string): Promise<ProviderAuthReprobeResult> =>
			ipcRenderer.invoke('providerAuth:reprobe', key),

		// Re-probe every credential (`manual` mode: ignores the freshness window
		// and includes SSH remotes, so this can take a few seconds).
		reprobeAll: (): Promise<ProviderAuthProbeCounts> =>
			ipcRenderer.invoke('providerAuth:reprobeAll'),

		markLoggedOut: (
			key: string,
			detail?: string,
			source?: ProviderAuthSource
		): Promise<ProviderAuthSnapshot | null> =>
			ipcRenderer.invoke('providerAuth:markLoggedOut', key, detail, source),

		// Snapshot writes from anywhere in main - the startup pass, a manual
		// re-probe, the reactive auth_expired marker.
		onChange: (callback: (change: ProviderAuthChange) => void): (() => void) => {
			const handler = (_e: unknown, change: ProviderAuthChange) => callback(change);
			ipcRenderer.on('providerAuth:changed', handler);
			return () => {
				ipcRenderer.removeListener('providerAuth:changed', handler);
			};
		},
	};
}
