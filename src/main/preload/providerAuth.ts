/**
 * Preload API for provider auth snapshots
 *
 * Provides the window.maestro.providerAuth namespace for:
 * - Reading every stored credential login state
 * - Re-probing one credential or all of them
 * - Marking a credential logged out (or unsupported, for a credential no login
 *   flow can repair)
 * - Subscribing to snapshot changes pushed from main
 *
 * Types come from `shared/providerAuth`, never from `main/stores`, so the
 * renderer never pulls a main-process module into its bundle.
 */

import { ipcRenderer } from 'electron';
import type {
	CredentialIdentity,
	ProviderAuthSnapshot,
	ProviderAuthSource,
	ProviderAuthStatus,
} from '../../shared/providerAuth';

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

/**
 * Options for a single-credential re-probe.
 *
 * `source` is what the recovery modal uses to attribute its check to the login
 * flow, so a stored `authenticated` says a user just finished a login rather
 * than that a background sweep found a live token.
 */
export interface ProviderAuthReprobeOptions {
	source?: ProviderAuthSource;
}

/**
 * What a renderer sends when it learns of an auth failure without probing.
 *
 * `identity` is what lets a NEVER-PROBED credential be marked: main has no
 * record to read the identity from, and the renderer resolved it to find the key
 * in the first place. `status` is what keeps a revoked API key out of the
 * logged-out bucket, since no login flow can fix one.
 */
export interface ProviderAuthMarkRequest {
	status?: Extract<ProviderAuthStatus, 'logged-out' | 'unsupported'>;
	detail?: string;
	source?: ProviderAuthSource;
	identity?: CredentialIdentity;
}

/**
 * What the recovery modal asks for when it starts a login.
 *
 * `runSessionId` comes from `buildLoginRunSessionId()` in `shared/providerAuth`:
 * the renderer mounts its terminal on that id first, so it has to mint it. Main
 * validates the shape before spawning - see `isLoginRunSessionId()`.
 */
export interface ProviderAuthStartLoginRequest {
	identityKey: string;
	runSessionId: string;
	cols?: number;
	rows?: number;
	/** claude-code: bill against Anthropic Console instead of a subscription. */
	preferConsole?: boolean;
	/** claude-code: force the SSO flow. */
	sso?: boolean;
}

/** Outcome of a login spawn. `started: false` always carries an `error`. */
export interface ProviderAuthStartLoginResult {
	started: boolean;
	runSessionId: string;
	/** The command line as spawned, for the modal's "Show command" reveal. */
	commandLine?: string;
	/** Note about the flow's shape (device code, provider picker). */
	note?: string;
	/** True when the login is running on an SSH remote rather than this machine. */
	remote?: boolean;
	pid?: number;
	error?: string;
}

export interface ProviderAuthApi {
	getAll: () => Promise<Record<string, ProviderAuthSnapshot>>;
	reprobe: (
		key: string,
		options?: ProviderAuthReprobeOptions
	) => Promise<ProviderAuthReprobeResult>;
	reprobeAll: () => Promise<ProviderAuthProbeCounts>;
	mark: (key: string, request?: ProviderAuthMarkRequest) => Promise<ProviderAuthSnapshot | null>;
	startLogin: (request: ProviderAuthStartLoginRequest) => Promise<ProviderAuthStartLoginResult>;
	stopLogin: (runSessionId: string) => Promise<boolean>;
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
		reprobe: (
			key: string,
			options?: ProviderAuthReprobeOptions
		): Promise<ProviderAuthReprobeResult> =>
			ipcRenderer.invoke('providerAuth:reprobe', key, options),

		// Re-probe every credential (`manual` mode: ignores the freshness window
		// and includes SSH remotes, so this can take a few seconds).
		reprobeAll: (): Promise<ProviderAuthProbeCounts> =>
			ipcRenderer.invoke('providerAuth:reprobeAll'),

		// Record a failure the renderer observed (an `auth_expired` match, an
		// abandoned login) against one credential. See ProviderAuthMarkRequest.
		mark: (key: string, request?: ProviderAuthMarkRequest): Promise<ProviderAuthSnapshot | null> =>
			ipcRenderer.invoke('providerAuth:mark', key, request),

		// Run this credential's login command in a PTY. Output and input flow over
		// the normal `process.onData` / `process.write` channels under
		// `request.runSessionId`, which matches no agent listener.
		startLogin: (request: ProviderAuthStartLoginRequest): Promise<ProviderAuthStartLoginResult> =>
			ipcRenderer.invoke('providerAuth:startLogin', request),

		// Kill a login PTY (modal closed, or the user re-ran the command).
		stopLogin: (runSessionId: string): Promise<boolean> =>
			ipcRenderer.invoke('providerAuth:stopLogin', runSessionId),

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
