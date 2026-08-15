/**
 * Provider Auth IPC Handlers
 *
 * Renderer-facing surface over `providerAuthStore` and the probe layer:
 * read every snapshot, re-probe one credential, re-probe everything, and mark a
 * credential logged out. The store is the single source of truth - nothing here
 * derives a login state on its own.
 *
 * Re-probing delegates to `runStartupAuthProbe(..., mode: 'manual')`, the same
 * function the boot path calls, so a refresh button takes the exact code path
 * that populated the store at launch. `mode: 'manual'` is what makes a refresh
 * ignore the freshness window, the 7-day session window, and the SSH exclusion:
 * the user asked and is present to wait.
 *
 * Change broadcasting is registered ONCE against the store rather than sprinkled
 * across these handlers, so a write from anywhere - the startup pass, a manual
 * re-probe, the reactive `auth_expired` marker - reaches the renderer.
 */

import { BrowserWindow, ipcMain } from 'electron';
import type Store from 'electron-store';

import { runStartupAuthProbe } from '../../agents/auth/auth-startup';
import type { StartupAuthProbeResult } from '../../agents/auth/auth-startup';
import type { AgentDetector } from '../../agents';
import type { CredentialIdentity } from '../../../shared/providerAuth';
import type {
	AuthFailureStatus,
	ProviderAuthChange,
	ProviderAuthSnapshot,
	ProviderAuthSource,
} from '../../stores/providerAuthStore';
import {
	getAllSnapshots,
	getSnapshot,
	markAuthFailure,
	onSnapshotChange,
} from '../../stores/providerAuthStore';
import type { AgentConfigsData, MaestroSettings, SessionsData } from '../../stores/types';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';

const LOG_CONTEXT = '[ProviderAuth]';

/** Channel every window listens on for snapshot writes. */
export const PROVIDER_AUTH_CHANGED_CHANNEL = 'providerAuth:changed';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/** Sources a renderer is allowed to attribute a mark to. */
const RENDERER_SOURCES: readonly ProviderAuthSource[] = ['error-pattern', 'login-flow'];

/** Statuses a renderer may write without a probe. See {@link AuthFailureStatus}. */
const RENDERER_STATUSES: readonly AuthFailureStatus[] = ['logged-out', 'unsupported'];

/** What the renderer sends with a mark. Everything but the key is optional. */
export interface ProviderAuthMarkRequest {
	/** Defaults to `logged-out`; anything outside {@link RENDERER_STATUSES} is ignored. */
	status?: AuthFailureStatus;
	detail?: string;
	source?: ProviderAuthSource;
	/**
	 * The resolved identity, so an agent that fails auth BEFORE any probe ran
	 * still gets a record. Without it the store has nothing to file the mark
	 * under and the call is a no-op.
	 */
	identity?: CredentialIdentity;
}

/**
 * Accept a renderer-supplied identity only when it is complete and self-consistent.
 *
 * This value is persisted and then rendered, so a half-filled object would put a
 * record on disk that the Left Bar cannot describe. The key check matters most:
 * an identity filed under someone else's key would report the wrong account as
 * broken.
 */
function validateIdentity(key: string, identity: unknown): CredentialIdentity | undefined {
	if (!identity || typeof identity !== 'object') return undefined;
	const candidate = identity as Record<string, unknown>;
	const strings = ['key', 'provider', 'kind', 'scope', 'host', 'label'];
	if (strings.some((field) => typeof candidate[field] !== 'string' || candidate[field] === '')) {
		return undefined;
	}
	if (candidate.key !== key) {
		logger.warn('Ignoring provider auth identity filed under a different key', LOG_CONTEXT, {
			key,
			identityKey: String(candidate.key),
		});
		return undefined;
	}
	return candidate as unknown as CredentialIdentity;
}

export interface ProviderAuthHandlerDependencies {
	/** Read-only store slices; the probe pass never writes to them. */
	sessionsStore: Pick<Store<SessionsData>, 'get'>;
	agentConfigsStore: Pick<Store<AgentConfigsData>, 'get'>;
	settingsStore: Pick<Store<MaestroSettings>, 'get'>;
	getAgentDetector: () => AgentDetector | null;
}

/**
 * Unsubscribe for the store listener, so registering twice (a test, a re-init)
 * replaces the broadcaster instead of stacking a second one that double-sends.
 */
let unsubscribeChangeBroadcast: (() => void) | null = null;

/**
 * Push one snapshot change to every window.
 *
 * Every window can show the auth badge, so this goes to all of them rather than
 * through the single-window `safeSend`. Same shape as `notifyPeerWindows` in
 * `persistence.ts`, minus the sender exclusion: a change here originates in main,
 * not in one renderer, so nobody is echoing their own write back at themselves.
 */
function broadcastChange(change: ProviderAuthChange): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!isWebContentsAvailable(win)) continue;
		win.webContents.send(PROVIDER_AUTH_CHANGED_CHANNEL, change);
	}
}

/** Result of a manual re-probe request. */
export interface ProviderAuthReprobeResult extends StartupAuthProbeResult {
	/** The stored snapshot after the pass, for a single-key re-probe. */
	snapshot?: ProviderAuthSnapshot | null;
}

/**
 * Register the `providerAuth:*` handlers.
 *
 * Wire this from `setupIpcHandlers()` in `src/main/index.ts`. Registering it
 * only in `registerAllHandlers()` would leave it dead: the running app does not
 * call that function.
 */
export function registerProviderAuthHandlers(deps: ProviderAuthHandlerDependencies): void {
	const { sessionsStore, agentConfigsStore, settingsStore, getAgentDetector } = deps;

	unsubscribeChangeBroadcast?.();
	unsubscribeChangeBroadcast = onSnapshotChange(broadcastChange);

	/**
	 * Run a manual pass, optionally narrowed to specific identity keys. Returns
	 * zeroed counts (never throws) when the detector is not up yet, which happens
	 * if the renderer asks before agent detection finished on a cold boot.
	 */
	const runManualProbe = async (onlyKeys?: string[]): Promise<StartupAuthProbeResult> => {
		const agentDetector = getAgentDetector();
		if (!agentDetector) {
			logger.warn('Skipping provider auth re-probe: agent detector not ready', LOG_CONTEXT, {
				onlyKeys,
			});
			return { identities: 0, probed: 0, skippedFresh: 0, skippedNotInstalled: 0, byStatus: {} };
		}
		return runStartupAuthProbe({
			sessionsStore,
			agentConfigsStore,
			settingsStore,
			agentDetector,
			mode: 'manual',
			...(onlyKeys ? { onlyKeys } : {}),
		});
	};

	// Every stored snapshot, keyed by `CredentialIdentity.key`. The renderer
	// reads this once on mount and then follows the change broadcast.
	ipcMain.handle(
		'providerAuth:getAll',
		withIpcErrorLogging(
			handlerOpts('getAll'),
			async (): Promise<Record<string, ProviderAuthSnapshot>> => getAllSnapshots()
		)
	);

	// Re-probe one credential. `snapshot` is whatever is stored afterwards, which
	// is the previous value when the key matched no session (the agent that used
	// it was deleted) - the store is still the source of truth either way.
	ipcMain.handle(
		'providerAuth:reprobe',
		withIpcErrorLogging(
			handlerOpts('reprobe'),
			async (key: string): Promise<ProviderAuthReprobeResult> => {
				const result = await runManualProbe([key]);
				return { ...result, snapshot: getSnapshot(key) };
			}
		)
	);

	// Re-probe everything.
	ipcMain.handle(
		'providerAuth:reprobeAll',
		withIpcErrorLogging(
			handlerOpts('reprobeAll'),
			async (): Promise<StartupAuthProbeResult> => runManualProbe()
		)
	);

	// Record an auth failure against a credential without probing.
	//
	// The reactive `auth_expired` path is the caller, and it knows two things the
	// store may not: WHICH identity failed (an agent can fail before any probe ran,
	// so there may be no record to read the identity from) and WHAT KIND of failure
	// it is. A revoked API key is not a logged-out login - it is marked
	// `unsupported` so no login button is offered for something a login cannot fix.
	//
	// Still returns null when neither the store nor the caller can supply an
	// identity: a half-record the UI cannot render is worse than none.
	ipcMain.handle(
		'providerAuth:mark',
		withIpcErrorLogging(
			handlerOpts('mark'),
			async (
				key: string,
				request?: ProviderAuthMarkRequest
			): Promise<ProviderAuthSnapshot | null> => {
				const source: ProviderAuthSource =
					request?.source && RENDERER_SOURCES.includes(request.source)
						? request.source
						: 'error-pattern';
				const status: AuthFailureStatus =
					request?.status && RENDERER_STATUSES.includes(request.status)
						? request.status
						: 'logged-out';
				return markAuthFailure(
					key,
					status,
					request?.detail,
					source,
					validateIdentity(key, request?.identity)
				);
			}
		)
	);
}
