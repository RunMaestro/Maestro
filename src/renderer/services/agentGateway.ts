/**
 * Setting an agent's Local Models gateway from the renderer.
 *
 * One entry for the Local Models gateway table and the Edit Agent dialog, so
 * both validate with `parseGatewayUrlEdit` and both FLUSH. The flush is the
 * part that is easy to skip and fails silently: the desktop spawn reads an
 * agent's gateway from the main-process sessions store, and the renderer's
 * ordinary persistence is debounced by two seconds, so a gateway that was only
 * written to the renderer store is not in force for a message sent straight
 * after it. A turn the user believes is proxied would go direct.
 *
 * `setAgentTokenProxyMode` is the same kind of write for the Maestro token
 * proxy: `off | passthrough | compress`. Turning the proxy on IS setting the
 * agent's gateway to the proxy's address, and turning it off is clearing that
 * gateway, so the mode and the URL are written together and flushed together.
 * The server reads the mode from the main-process store on every request.
 *
 * `setAgentBackgroundRequests` is the third write of that kind: where the proxy
 * sends the agent's side requests. It belongs to the proxy the way the mode
 * does, so it is refused for an agent that is not on the proxy and it leaves
 * with the proxy (`OFF_TOKEN_PROXY_FIELDS`): a setting nobody can see must not
 * come back into force when the proxy is switched on again somewhere else.
 *
 * `setAgentTokenProxyRetrieval` is the fourth: whether the agent's model is
 * given the tool that asks the proxy for a compressed result's original. It is
 * refused unless the proxy compresses for the agent, and it leaves with the
 * proxy the same way.
 *
 * The proxy DEFAULT (`defaultTokenProxyMode`) covers every agent that can use
 * the proxy. An agent follows it while its routing is what the default gives
 * it; one whose routing differs is an override. Changing the default moves the
 * followers and leaves the overrides (`syncAgentsToTokenProxyDefault`), so the
 * Gateway table lists only the overrides, never every agent.
 */

import { canonicalJson } from '../../shared/canonicalJson';
import {
	BACKGROUND_REQUESTS_NEEDS_PROXY,
	parseBackgroundRequestsEdit,
	type BackgroundRequests,
} from '../../shared/local-models/background-requests';
import { agentGatewaySupport, parseGatewayUrlEdit } from '../../shared/local-models/gateway';
import { runOnGatewayEditProblem } from '../../shared/local-models/run-on';
import {
	asTokenProxyMode,
	followsTokenProxyDefault,
	gatewayPointsAtTokenProxy,
	holdsTokenProxyFields,
	isCompressingTokenProxyMode,
	OFF_TOKEN_PROXY_FIELDS,
	parseTokenProxyRetrievalEdit,
	resolveTokenProxyMode,
	TOKEN_PROXY_DEFAULT_APPLIED_SETTING,
	TOKEN_PROXY_NAME,
	TOKEN_PROXY_RETRIEVAL_NEEDS_COMPRESSION,
	tokenProxyGatewayUrl,
	tokenProxyRouteForAgent,
	type TokenProxyMode,
} from '../../shared/local-models/token-proxy';
import { effectiveAgentCustomEnvVars } from '../../shared/providerProfiles';
import { useSettingsStore } from '../stores/settingsStore';
import { notifyToast } from '../stores/notificationStore';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import type { Session } from '../types';
import { logger } from '../utils/logger';

// Defined in shared so the pure group-defaults publish clears the same fields.
// Re-exported here, where every renderer writer already imports it from.
export { OFF_TOKEN_PROXY_FIELDS };

export type SetAgentGatewayResult =
	| { ok: true; gatewayUrl: string | undefined }
	| { ok: false; error: string };

/**
 * Write the main-process copy of one agent now. Best-effort callers leave a
 * failed write to the debounced flush. Routing decisions require confirmation
 * from main, so they opt into errors instead of reporting a route in force.
 */
export async function flushAgentToStore(
	sessionId: string,
	options?: { required?: boolean }
): Promise<void> {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session) {
		if (options?.required) throw new Error('Agent not found');
		return;
	}
	try {
		await window.maestro.sessions.setMany([session as any], []);
	} catch (err) {
		logger.error('[AgentGateway] Failed to persist agent gateway', undefined, err);
		if (options?.required) throw err;
	}
}

/**
 * Validate and store an agent's gateway. Blank or `none` clears it. Resolves
 * once main holds the new value, so the next spawn uses it.
 */
export async function setAgentGatewayUrl(
	sessionId: string,
	raw: string
): Promise<SetAgentGatewayResult> {
	const session: Session | undefined = useSessionStore
		.getState()
		.sessions.find((s) => s.id === sessionId);
	if (!session) return { ok: false, error: 'Agent not found' };

	const edit = parseGatewayUrlEdit(session.toolType, raw);
	if (!edit.ok) return edit;
	const problem = runOnGatewayEditProblem(session.runOn, { gatewayUrl: edit.gatewayUrl });
	if (problem) return { ok: false, error: problem };

	const gatewayUrl = edit.gatewayUrl ?? undefined;
	if (gatewayUrl === session.gatewayUrl) return { ok: true, gatewayUrl };

	// A proxy mode describes the gateway it was chosen for. A different gateway
	// starts from the default, so compression is never carried onto a URL the
	// user typed afterwards. Background requests leave with it.
	updateSessionWith(sessionId, (s) => ({ ...s, gatewayUrl, ...OFF_TOKEN_PROXY_FIELDS }));
	await flushAgentToStore(sessionId);
	return { ok: true, gatewayUrl };
}

export type SetAgentTokenProxyModeResult =
	| { ok: true; mode: TokenProxyMode; gatewayUrl: string | undefined }
	| { ok: false; error: string };

/** The agent's effective environment, merged the way the desktop spawn merges it. */
async function agentEffectiveEnv(session: Session): Promise<Record<string, string>> {
	let providerVars: Record<string, string> | null = null;
	try {
		providerVars = (await window.maestro.agents?.getCustomEnvVars?.(session.toolType)) ?? null;
	} catch {
		// Without the provider-level vars the agent's own still decide the route.
	}
	return {
		...(useSettingsStore.getState().shellEnvVars ?? {}),
		...(effectiveAgentCustomEnvVars(session.customEnvVars, providerVars ?? undefined) ?? {}),
	};
}

/** The agent's model: its own, or the provider default from Settings -> Agents. */
async function agentEffectiveModel(session: Session): Promise<string | undefined> {
	if (session.customModel?.trim()) return session.customModel;
	try {
		const model = (await window.maestro.agents?.getConfig?.(session.toolType))?.model;
		return typeof model === 'string' ? model : undefined;
	} catch {
		// Without the provider default the agent's own model (none) decides.
		return undefined;
	}
}

/**
 * Set how the Maestro token proxy carries one agent's requests.
 *
 * - `off` clears the agent's gateway when it is the proxy, and its background
 *   requests target and retrieval switch with it. A gateway that points somewhere else (Headroom,
 *   LiteLLM) is left alone: it is already off.
 * - `passthrough` and `compress` point the agent's gateway at the proxy (on the
 *   route its provider and credential need) unless it is there already, and
 *   store the mode. They are refused for a provider that cannot use a gateway
 *   and for an agent on an SSH remote, which cannot reach this machine's
 *   loopback address. A model source also refuses a gateway: its own model
 *   route already owns the target. Clearing remains allowed.
 *
 * Resolves once main holds the new values, so the next request uses them.
 *
 * `options.port` is the proxy's port when the caller already read it (a sync
 * over many agents), so `off` does not ask for the full report per agent.
 */
export async function setAgentTokenProxyMode(
	sessionId: string,
	mode: TokenProxyMode,
	options?: { port?: number | null }
): Promise<SetAgentTokenProxyModeResult> {
	const session: Session | undefined = useSessionStore
		.getState()
		.sessions.find((s) => s.id === sessionId);
	if (!session) return { ok: false, error: 'Agent not found' };
	const proxy = window.maestro.localModels.proxy;

	if (mode === 'off') {
		const port = options?.port !== undefined ? options.port : (await proxy.report()).status.port;
		const onProxy = port !== null && gatewayPointsAtTokenProxy(session.gatewayUrl, port);
		const gatewayUrl = onProxy ? undefined : session.gatewayUrl;
		if (gatewayUrl !== session.gatewayUrl || holdsTokenProxyFields(session)) {
			updateSessionWith(sessionId, (s) => ({ ...s, gatewayUrl, ...OFF_TOKEN_PROXY_FIELDS }));
		}
		await flushAgentToStore(sessionId, { required: true });
		return { ok: true, mode, gatewayUrl };
	}

	const blocker = tokenProxyDefaultBlocker(session);
	if (blocker) return { ok: false, error: blocker };

	const port = await proxy.ensurePort();
	let gatewayUrl = session.gatewayUrl;
	if (!gatewayPointsAtTokenProxy(gatewayUrl, port)) {
		const route = tokenProxyRouteForAgent(
			session.toolType,
			await agentEffectiveEnv(session),
			await agentEffectiveModel(session)
		);
		if (!route.ok) return route;
		gatewayUrl = tokenProxyGatewayUrl(port, route.route, session.toolType);
	}
	if (gatewayUrl !== session.gatewayUrl || session.tokenProxyMode !== mode) {
		updateSessionWith(sessionId, (s) => ({ ...s, gatewayUrl, tokenProxyMode: mode }));
	}
	// A previous immediate write may have failed while renderer state kept the
	// intended setting. Even an unchanged choice must confirm main's copy.
	await flushAgentToStore(sessionId, { required: true });
	return { ok: true, mode, gatewayUrl };
}

export type SetAgentBackgroundRequestsResult =
	| { ok: true; backgroundRequests: BackgroundRequests | undefined }
	| { ok: false; error: string };

/**
 * Why an agent cannot be put on the Maestro token proxy, or null when it can.
 * A model source owns the agent's model route; a provider without gateway
 * support has no base-URL variable to set; an agent on an SSH remote cannot
 * reach this machine's loopback address. The one rule the per-agent writer,
 * the proxy default and the Gateway table all apply.
 */
export function tokenProxyDefaultBlocker(
	session: Pick<Session, 'toolType' | 'runOn' | 'sessionSshRemoteConfig'>
): string | null {
	const runOnProblem = runOnGatewayEditProblem(session.runOn, { tokenProxyMode: 'compress' });
	if (runOnProblem) return runOnProblem;
	const support = agentGatewaySupport(session.toolType);
	if (!support.supported) return support.reason;
	if (session.sessionSshRemoteConfig?.enabled) {
		return `The ${TOKEN_PROXY_NAME} listens on this machine's loopback address, which an agent on an SSH remote cannot reach.`;
	}
	return null;
}

/**
 * Put one agent back on the proxy default, ending its override. A gateway of
 * the user's own (not the proxy) is cleared first, so the default replaces it
 * whether the default is on or off. An agent that cannot use the proxy goes
 * direct. Resolves once main holds the result.
 */
export async function followTokenProxyDefault(
	sessionId: string
): Promise<SetAgentTokenProxyModeResult> {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session) return { ok: false, error: 'Agent not found' };
	const port = (await window.maestro.localModels.proxy.report()).status.port;
	if (
		session.gatewayUrl &&
		!(port !== null && gatewayPointsAtTokenProxy(session.gatewayUrl, port))
	) {
		const cleared = await setAgentGatewayUrl(sessionId, '');
		if (!cleared.ok) return cleared;
	}
	const mode = tokenProxyDefaultBlocker(session)
		? 'off'
		: (useSettingsStore.getState().defaultTokenProxyMode ?? 'off');
	return setAgentTokenProxyMode(sessionId, mode, { port });
}

export interface TokenProxyDefaultSyncResult {
	/** The default the agents now follow. */
	mode: TokenProxyMode;
	/** Agents moved from the previous default to this one. */
	moved: number;
	/** `<agent>: <reason>` for each agent that could not be moved. */
	failed: string[];
}

let tokenProxyDefaultSync: Promise<TokenProxyDefaultSyncResult | null> | null = null;

/** How many failed agents a sync's toast names before it summarizes the rest. */
const MAX_NAMED_SYNC_FAILURES = 5;

/**
 * Set the proxy default for every agent: what the Gateway section's Default
 * buttons call. Saves `defaultTokenProxyMode`, then, with `sync`, moves the
 * agents that follow the old default (`syncAgentsToTokenProxyDefault`). Only
 * the window that owns app-wide effects passes `sync`; any other window's
 * change reaches that window as a settings change, and its
 * `useTokenProxyDefaultSync()` moves the agents, so two windows never write
 * the same agents at once. Rejects when the default cannot be saved.
 */
export async function chooseTokenProxyDefault(
	mode: TokenProxyMode,
	options: { sync: boolean }
): Promise<TokenProxyDefaultSyncResult | null> {
	// Record the default the agents follow now, before it changes: on an install
	// that never synced, the first sync would otherwise take the NEW default as
	// the baseline and move nobody.
	const applied = asTokenProxyMode(
		await window.maestro.settings.get(TOKEN_PROXY_DEFAULT_APPLIED_SETTING)
	);
	if (applied === undefined) {
		await window.maestro.settings.set(
			TOKEN_PROXY_DEFAULT_APPLIED_SETTING,
			useSettingsStore.getState().defaultTokenProxyMode ?? 'off'
		);
	}
	await useSettingsStore.getState().setDefaultTokenProxyMode(mode);
	return options.sync ? syncAgentsToTokenProxyDefault() : null;
}

/**
 * Move every agent that follows the previous proxy default onto the current
 * one (`defaultTokenProxyMode`). An agent follows a default while its routing
 * is what that default gives it (`followsTokenProxyDefault`); anything else is
 * an override and is left alone. The default the agents last followed is kept
 * in `TOKEN_PROXY_DEFAULT_APPLIED_SETTING`, so a default changed while the app
 * was closed (`maestro-cli settings set defaultTokenProxyMode`) is applied on
 * the next run.
 *
 * Callers share one run: a call while a run is in flight gets that run, and a
 * default changed during it is applied by another pass before it resolves.
 * Resolves with the last pass, or null when the agents already followed the
 * current default. An agent that could not be moved keeps its old routing, so
 * it shows as an override, and is named in a toast.
 */
export function syncAgentsToTokenProxyDefault(): Promise<TokenProxyDefaultSyncResult | null> {
	if (!tokenProxyDefaultSync) {
		tokenProxyDefaultSync = runTokenProxyDefaultSync().finally(() => {
			tokenProxyDefaultSync = null;
		});
	}
	return tokenProxyDefaultSync;
}

async function runTokenProxyDefaultSync(): Promise<TokenProxyDefaultSyncResult | null> {
	let result: TokenProxyDefaultSyncResult | null = null;
	for (;;) {
		const target = useSettingsStore.getState().defaultTokenProxyMode ?? 'off';
		const applied = asTokenProxyMode(
			await window.maestro.settings.get(TOKEN_PROXY_DEFAULT_APPLIED_SETTING)
		);
		if (applied === target) break;
		if (applied === undefined) {
			// First sync on this install: agents are where earlier versions put
			// them. Record the default without moving anyone.
			await window.maestro.settings.set(TOKEN_PROXY_DEFAULT_APPLIED_SETTING, target);
			break;
		}
		const port = (await window.maestro.localModels.proxy.report()).status.port;
		const followers = useSessionStore
			.getState()
			.sessions.filter(
				(s) =>
					s.toolType !== 'terminal' &&
					!tokenProxyDefaultBlocker(s) &&
					followsTokenProxyDefault(s, applied, port)
			);
		let moved = 0;
		const failed: string[] = [];
		for (const session of followers) {
			try {
				const outcome = await setAgentTokenProxyMode(session.id, target, { port });
				if (outcome.ok) moved++;
				else failed.push(`${session.name}: ${outcome.error}`);
			} catch (error) {
				failed.push(`${session.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		await window.maestro.settings.set(TOKEN_PROXY_DEFAULT_APPLIED_SETTING, target);
		result = { mode: target, moved, failed };
		if (failed.length > 0) {
			notifyToast({
				color: 'yellow',
				title: `Proxy default not applied to ${failed.length} agent${failed.length === 1 ? '' : 's'}`,
				// Named up to a few; the rest show as overrides in Settings -> Models -> Gateway.
				message:
					failed.slice(0, MAX_NAMED_SYNC_FAILURES).join('\n') +
					(failed.length > MAX_NAMED_SYNC_FAILURES
						? `\n...and ${failed.length - MAX_NAMED_SYNC_FAILURES} more, listed as overrides in Settings -> Models -> Gateway.`
						: ''),
				dismissible: true,
			});
		}
	}
	return result;
}

/**
 * Copy the saved proxy default onto a new local agent before its first turn.
 * Explicit routing and group seeds win. Worktrees inherit their parent's routing
 * instead. Reuse the same writer as the Gateway controls so URL, mode and the
 * main-process record are ready together. A refusal stays visible to the user.
 */
export async function applyDefaultAgentTokenProxy(sessionId: string): Promise<void> {
	const mode = useSettingsStore.getState().defaultTokenProxyMode;
	if (!mode || mode === 'off') return;
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session || session.gatewayUrl || session.tokenProxyMode || tokenProxyDefaultBlocker(session))
		return;

	try {
		const result = await setAgentTokenProxyMode(sessionId, mode);
		if (!result.ok) throw new Error(result.error);
	} catch (error) {
		notifyToast({
			color: 'yellow',
			title: 'Proxy default was not applied',
			message: `${session.name}: ${error instanceof Error ? error.message : String(error)}`,
			dismissible: true,
		});
	}
}

/**
 * Set where the Maestro token proxy sends one agent's background requests, or
 * turn that off with `undefined` / `null`.
 *
 * A target is checked the way every writer checks it
 * (`parseBackgroundRequestsEdit`: the provider, the saved sources, the route
 * the source serves) and is refused for an agent that is not on the proxy,
 * which would store a setting that does nothing. Turning it off is always
 * allowed.
 *
 * Resolves once main holds the new value: the proxy reads it from the
 * main-process store on every request.
 */
export async function setAgentBackgroundRequests(
	sessionId: string,
	value: unknown
): Promise<SetAgentBackgroundRequestsResult> {
	const session: Session | undefined = useSessionStore
		.getState()
		.sessions.find((s) => s.id === sessionId);
	if (!session) return { ok: false, error: 'Agent not found' };

	const edit = parseBackgroundRequestsEdit(
		session.toolType,
		value,
		useSettingsStore.getState().localModelEndpoints ?? []
	);
	if (!edit.ok) return edit;
	const { backgroundRequests } = edit;

	if (backgroundRequests) {
		const port = (await window.maestro.localModels.proxy.report()).status.port;
		const mode = resolveTokenProxyMode({
			gatewayUrl: session.gatewayUrl,
			storedMode: session.tokenProxyMode,
			port,
		});
		if (mode === 'off') return { ok: false, error: BACKGROUND_REQUESTS_NEEDS_PROXY };
	}

	if (
		canonicalJson(session.backgroundRequests ?? null) !== canonicalJson(backgroundRequests ?? null)
	) {
		updateSessionWith(sessionId, (s) => ({ ...s, backgroundRequests }));
		await flushAgentToStore(sessionId);
	}
	return { ok: true, backgroundRequests };
}

export type SetAgentTokenProxyRetrievalResult =
	| { ok: true; retrieval: boolean }
	| { ok: false; error: string };

/**
 * Turn retrieval on (`true`) or off (`false` / `null`) for one agent.
 *
 * On is refused unless the proxy compresses this agent's requests (`compress`
 * or `compress-early`): in any other mode nothing is shortened, so the switch
 * would store a setting that does nothing. Off is always allowed.
 *
 * Resolves once main holds the new value, so the next launch reads it.
 */
export async function setAgentTokenProxyRetrieval(
	sessionId: string,
	value: unknown
): Promise<SetAgentTokenProxyRetrievalResult> {
	const session: Session | undefined = useSessionStore
		.getState()
		.sessions.find((s) => s.id === sessionId);
	if (!session) return { ok: false, error: 'Agent not found' };

	const edit = parseTokenProxyRetrievalEdit(value);
	if (!edit.ok) return edit;
	const { retrieval } = edit;

	if (retrieval) {
		const port = (await window.maestro.localModels.proxy.report()).status.port;
		const mode = resolveTokenProxyMode({
			gatewayUrl: session.gatewayUrl,
			storedMode: session.tokenProxyMode,
			port,
		});
		if (!isCompressingTokenProxyMode(mode)) {
			return { ok: false, error: TOKEN_PROXY_RETRIEVAL_NEEDS_COMPRESSION };
		}
	}

	if (session.tokenProxyRetrieval !== retrieval) {
		updateSessionWith(sessionId, (s) => ({ ...s, tokenProxyRetrieval: retrieval }));
		await flushAgentToStore(sessionId);
	}
	return { ok: true, retrieval: retrieval === true };
}
