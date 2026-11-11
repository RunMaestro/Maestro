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
 */

import { canonicalJson } from '../../shared/canonicalJson';
import {
	BACKGROUND_REQUESTS_NEEDS_PROXY,
	parseBackgroundRequestsEdit,
	type BackgroundRequests,
} from '../../shared/local-models/background-requests';
import { agentGatewaySupport, parseGatewayUrlEdit } from '../../shared/local-models/gateway';
import {
	gatewayPointsAtTokenProxy,
	holdsTokenProxyFields,
	isCompressingTokenProxyMode,
	OFF_TOKEN_PROXY_FIELDS,
	parseTokenProxyRetrievalEdit,
	resolveTokenProxyMode,
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
 * Write the main-process copy of one agent now. Never throws: the renderer
 * store already holds the value and the debounced flush will follow.
 */
export async function flushAgentToStore(sessionId: string): Promise<void> {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session) return;
	try {
		await window.maestro.sessions.setMany([session as any], []);
	} catch (err) {
		logger.error('[AgentGateway] Failed to persist agent gateway', undefined, err);
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
 *   loopback address.
 *
 * Resolves once main holds the new values, so the next request uses them.
 */
export async function setAgentTokenProxyMode(
	sessionId: string,
	mode: TokenProxyMode
): Promise<SetAgentTokenProxyModeResult> {
	const session: Session | undefined = useSessionStore
		.getState()
		.sessions.find((s) => s.id === sessionId);
	if (!session) return { ok: false, error: 'Agent not found' };
	const proxy = window.maestro.localModels.proxy;

	if (mode === 'off') {
		const port = (await proxy.report()).status.port;
		const onProxy = port !== null && gatewayPointsAtTokenProxy(session.gatewayUrl, port);
		const gatewayUrl = onProxy ? undefined : session.gatewayUrl;
		if (gatewayUrl !== session.gatewayUrl || holdsTokenProxyFields(session)) {
			updateSessionWith(sessionId, (s) => ({ ...s, gatewayUrl, ...OFF_TOKEN_PROXY_FIELDS }));
			await flushAgentToStore(sessionId);
		}
		return { ok: true, mode, gatewayUrl };
	}

	const support = agentGatewaySupport(session.toolType);
	if (!support.supported) return { ok: false, error: support.reason };
	if (session.sessionSshRemoteConfig?.enabled) {
		return {
			ok: false,
			error: `The ${TOKEN_PROXY_NAME} listens on this machine's loopback address, which an agent on an SSH remote cannot reach.`,
		};
	}

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
		await flushAgentToStore(sessionId);
	}
	return { ok: true, mode, gatewayUrl };
}

export type SetAgentBackgroundRequestsResult =
	| { ok: true; backgroundRequests: BackgroundRequests | undefined }
	| { ok: false; error: string };

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
	if (
		!session ||
		session.gatewayUrl ||
		session.tokenProxyMode ||
		session.runOn ||
		session.sessionSshRemoteConfig?.enabled ||
		!agentGatewaySupport(session.toolType).supported
	)
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
