import { PluginAuthorityError } from './plugin-authority';
/**
 * Active PluginManager accessor (main process).
 *
 * The PluginManager is constructed during core-service init in `index.ts` and
 * held in a module-local there. The web-server message handlers run in the same
 * main process but are not on that wiring path, so - mirroring the StatsDB
 * singleton (`stats/singleton.ts`) - this exposes the live instance to them
 * without threading it through the handler constructor.
 *
 * The live `encoreFeatures.plugins` predicate is captured alongside the manager:
 * handlers MUST gate on {@link isPluginsFeatureEnabled} rather than inferring the
 * flag from `getContributions()` (which aggregates active records and can be
 * stale relative to a freshly-toggled flag), matching the IPC handlers' gate.
 */
import type { PluginManager } from './plugin-manager';
import type { AgentSendProgressEvent } from '../../shared/plugins/rpc-protocol';
import type { PluginToolReceipt } from './plugin-tool-run-identity';

export interface HeadlessAgentReply {
	originalAttachments?: readonly [
		import('../../shared/plugins/media-tools').OriginalAttachmentReceipt,
	];
	success: boolean;
	response: string | null;
	sessionId: string | null;
	error?: string;
	/** Host-only: false proves a returned preflight failure started no provider work. */
	executionStarted?: boolean;
	usageStats?: import('../../shared/types').UsageStats;
	/** Present only for an authenticated CLI run that requested one tool ID. */
	toolReceipts?: PluginToolReceipt[];
}
export interface HeadlessTurnSettings {
	originalAttachment?: import('./plugin-media-tools').OriginalAttachmentLease;
}

export type HeadlessAgentRunner = (
	agentId: string,
	prompt: string,
	sessionId?: string,
	signal?: AbortSignal,
	origin?: 'user' | 'auto' | 'relay',
	onProgress?: (event: AgentSendProgressEvent) => void,
	receiptToolId?: string,
	requirePluginTools?: boolean,
	/** Host-only: Relay already holds the tab/provider reservation for this run. */
	writerLeaseHeld?: boolean,
	turn?: HeadlessTurnSettings
) => Promise<HeadlessAgentReply>;
let headlessAgentRunner: HeadlessAgentRunner | null = null;

export function setHeadlessAgentRunner(runner: HeadlessAgentRunner | null): void {
	headlessAgentRunner = runner;
}

export function getHeadlessAgentRunner(): HeadlessAgentRunner | null {
	return headlessAgentRunner;
}

let activePluginManager: PluginManager | null = null;
let pluginsEnabledCheck: (() => boolean) | null = null;
let managerTransition: object = {};
let hostStopped = false;
// At most one detached shutdown owner; retained only for bounded cleanup retry.
let shutdownManager: PluginManager | null = null;
let shutdownStopping = false;

export function setActivePluginManager(
	manager: PluginManager | null,
	isEnabled?: () => boolean
): void {
	if (hostStopped) {
		// Shutdown is permanent, including assignments from synchronous abort hooks.
		if (manager && manager === shutdownManager && shutdownStopping)
			throw new PluginAuthorityError('PLUGIN_DENIED');
		try {
			manager?.stopToolAuthority();
		} catch {
			throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		}
		if (manager) throw new PluginAuthorityError('PLUGIN_DENIED');
		return;
	}
	if (activePluginManager && manager && activePluginManager !== manager)
		activePluginManager.assertIndependentToolAuthority(manager);
	// Even an explicit clear while already detached cancels an older transition.
	const transition = {};
	managerTransition = transition;
	if (activePluginManager === manager) {
		pluginsEnabledCheck = isEnabled ?? null;
		return;
	}
	const previous = activePluginManager;
	// Remove ingress authority before cleanup can synchronously reenter this setter.
	activePluginManager = null;
	pluginsEnabledCheck = null;
	let failed = false;
	try {
		previous?.stopToolAuthority();
	} catch {
		failed = true;
	}
	if (managerTransition !== transition || failed) {
		// A newer transition owns the accessor. Never overwrite it or leave this
		// abandoned candidate's proofs alive; an adopted candidate stays its owner.
		if (manager && manager !== activePluginManager) {
			try {
				manager.stopToolAuthority();
			} catch {
				failed = true;
			}
		}
		if (failed) throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		return;
	}
	activePluginManager = manager;
	pluginsEnabledCheck = isEnabled ?? null;
}

/** Confirmed host quit only. Detach before cleanup; repeated calls retry the
 * same bounded owner without reopening ingress or accepting a replacement. */
export function stopActivePluginManager(): void {
	if (!hostStopped) {
		hostStopped = true;
		managerTransition = {};
		shutdownManager = activePluginManager;
		activePluginManager = null;
		pluginsEnabledCheck = null;
	}
	if (shutdownStopping) return;
	shutdownStopping = true;
	try {
		shutdownManager?.stopToolAuthority();
	} catch {
		throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
	} finally {
		shutdownStopping = false;
	}
}

export function getActivePluginManager(): PluginManager | null {
	return activePluginManager;
}

export function isPluginsFeatureEnabled(): boolean {
	return pluginsEnabledCheck ? pluginsEnabledCheck() : false;
}
