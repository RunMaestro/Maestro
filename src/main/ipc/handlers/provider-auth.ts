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
import type {
	ProviderAuthChange,
	ProviderAuthSnapshot,
	ProviderAuthSource,
} from '../../stores/providerAuthStore';
import {
	getAllSnapshots,
	getSnapshot,
	markLoggedOut,
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

/** Sources a renderer is allowed to attribute a logged-out mark to. */
const RENDERER_SOURCES: readonly ProviderAuthSource[] = ['error-pattern', 'login-flow'];

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

	// Flip a credential to `logged-out` without probing. Returns null when
	// nothing is stored for the key yet: with no identity on record there is
	// nothing to file the mark under, and a half-record the UI cannot render is
	// worse than none. A caller that HAS the identity should write it through
	// `markLoggedOut(key, detail, source, identity)` in main instead.
	ipcMain.handle(
		'providerAuth:markLoggedOut',
		withIpcErrorLogging(
			handlerOpts('markLoggedOut'),
			async (
				key: string,
				detail?: string,
				source?: ProviderAuthSource
			): Promise<ProviderAuthSnapshot | null> => {
				const resolvedSource: ProviderAuthSource =
					source && RENDERER_SOURCES.includes(source) ? source : 'error-pattern';
				return markLoggedOut(key, detail, resolvedSource);
			}
		)
	);
}
