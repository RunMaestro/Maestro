/**
 * A Cappella dispatch executor - where a `RouteDecision` becomes a real agent
 * and a real tab.
 *
 * Main has NO tab authority. Tab state lives in the renderer, and even a web or
 * CLI request to open one is forwarded there for execution
 * (`src/main/web-server/callbacks/tabCallbacks.ts`). So nothing here creates a
 * tab: it resolves a decision into the same `remote:*` messages the web server
 * already uses and waits for the renderer's answer. Hand-rolling a parallel tab
 * path in main would produce tabs the renderer does not know about.
 *
 * The roster comes from the persisted sessions store, the same source
 * `registerSessionCallbacks` reads, so the Brain routes against what the user
 * actually has open.
 *
 * The renderer round trip is behind `VoiceRendererBridge` for the same reason
 * the session service takes its providers injected: the routing rules are worth
 * testing without an Electron window, and Phase 08 will hand the phone leg the
 * same executor with a different bridge.
 */

import type { BrowserWindow } from 'electron';

import type { RosterAgent, RosterTab, VoiceScope } from '../../../shared/acappella/protocol';
import type { RouteDecision } from '../../../shared/acappella/route-decision';
import { routeTargetSessionId } from '../../../shared/acappella/route-decision';
import type { StoredSession } from '../../stores/types';
import { getSessionsStore } from '../../stores/getters';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { logger } from '../../utils/logger';
import { requestFromRenderer } from '../../web-server/callbacks/remoteRequest';
import { VoiceDispatchError } from '../voice-session-service';
import type { VoiceDispatchResult, VoiceRouteExecutor } from '../voice-session-service';

const LOG_CONTEXT = 'ACappella';

/** Tab creation is a renderer round trip; 5s matches `tabCallbacks.ts`. */
const NEW_TAB_TIMEOUT_MS = 5000;

/** Delivery receipt window, matching `REMOTE_COMMAND_RECEIPT_TIMEOUT_MS`. */
const COMMAND_RECEIPT_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/**
 * Compact the persisted sessions into the roster the Brain routes against and
 * the phone's project wheel will later render. Only AI tabs are listed: a voice
 * session can address nothing else.
 */
export function buildAgentRoster(sessions: StoredSession[]): RosterAgent[] {
	return sessions
		.filter((session) => session && typeof session.id === 'string')
		.map((session) => ({
			sessionId: session.id,
			name: session.name ?? '',
			agentType: session.toolType ?? '',
			cwd: session.cwd ?? '',
			tabs: buildRosterTabs(session),
		}));
}

/** The roster as of right now, straight from the store. */
export function readAgentRoster(): RosterAgent[] {
	return buildAgentRoster(readStoredSessions());
}

function buildRosterTabs(session: StoredSession): RosterTab[] {
	const tabs: Array<Record<string, unknown>> = Array.isArray(session.aiTabs) ? session.aiTabs : [];
	return tabs
		.filter((tab) => tab && typeof tab.id === 'string' && tab.hidden !== true)
		.map((tab) => ({
			id: tab.id as string,
			name: typeof tab.name === 'string' && tab.name.length > 0 ? tab.name : null,
			lastActiveAt: tabLastActiveAt(tab),
		}));
}

/**
 * Best available "when did this tab last do anything". `AITab` has no such
 * field, so the last log entry's timestamp stands in, with creation time as the
 * floor for a tab nobody has spoken to yet. It only ever breaks recall ties, so
 * an approximation is fine; a wrong `null` would not be.
 */
function tabLastActiveAt(tab: Record<string, unknown>): number | null {
	const logs: Array<Record<string, unknown>> = Array.isArray(tab.logs) ? tab.logs : [];
	const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
	const stamps = [tab.createdAt, lastLog?.timestamp].filter(
		(value): value is number => typeof value === 'number' && Number.isFinite(value)
	);
	return stamps.length > 0 ? Math.max(...stamps) : null;
}

function readStoredSessions(): StoredSession[] {
	return getSessionsStore().get('sessions', []);
}

function readActiveSessionId(): string | null {
	return getSessionsStore().get('activeSessionId') ?? null;
}

// ---------------------------------------------------------------------------
// Renderer bridge
// ---------------------------------------------------------------------------

/** The renderer's answer to `remote:newAITabWithPrompt`. */
export interface NewTabWithPromptResult {
	success: boolean;
	tabId?: string;
}

/** The renderer's delivery receipt for `remote:executeCommand`. */
export interface CommandReceipt {
	accepted: boolean;
	reason?: string;
}

/**
 * Every renderer operation dispatch needs, and nothing else. Each method maps
 * onto one existing `remote:*` channel; adding a method here means adding a
 * channel, not inventing a second way to do something the renderer already does.
 */
export interface VoiceRendererBridge {
	/** `remote:selectSession` - focus an agent, and a tab within it when given. */
	selectSession(agentSessionId: string, tabId?: string): void;
	/** `remote:renameTab` - name an existing AI tab. */
	renameTab(agentSessionId: string, tabId: string, name: string): void;
	/** `remote:newTab` - open an empty AI tab. Resolves to its id, or null. */
	newTab(agentSessionId: string): Promise<string | null>;
	/** `remote:newAITabWithPrompt` - open a tab and dispatch a prompt atomically. */
	newTabWithPrompt(agentSessionId: string, prompt: string): Promise<NewTabWithPromptResult>;
	/** `remote:executeCommand` - send a prompt to an existing tab, awaiting its receipt. */
	executeCommand(agentSessionId: string, tabId: string, prompt: string): Promise<CommandReceipt>;
}

/** The real bridge: one Electron window, the existing `remote:*` channels. */
export function createRendererVoiceBridge(
	getWindow: () => BrowserWindow | null
): VoiceRendererBridge {
	const requireWindow = (operation: string): BrowserWindow => {
		const win = getWindow();
		if (!isWebContentsAvailable(win)) {
			throw new VoiceDispatchError(`No renderer is available to ${operation}`);
		}
		return win;
	};

	return {
		selectSession(agentSessionId, tabId) {
			requireWindow('focus an agent').webContents.send(
				'remote:selectSession',
				agentSessionId,
				tabId
			);
		},

		renameTab(agentSessionId, tabId, name) {
			requireWindow('rename a tab').webContents.send(
				'remote:renameTab',
				agentSessionId,
				tabId,
				name
			);
		},

		async newTab(agentSessionId) {
			const result = await requestFromRenderer<{ tabId?: unknown } | null>(
				requireWindow('open a tab'),
				'remote:newTab',
				{
					fallback: null,
					timeoutMs: NEW_TAB_TIMEOUT_MS,
					parse: (raw) =>
						typeof raw === 'object' && raw !== null ? (raw as { tabId?: unknown }) : null,
					args: [agentSessionId],
				}
			);
			return typeof result?.tabId === 'string' ? result.tabId : null;
		},

		async newTabWithPrompt(agentSessionId, prompt) {
			// The channel takes `(sessionId, prompt, responseChannel, background?)`,
			// so omitting `background` both puts the response channel in the right
			// position and gets the focus behaviour voice wants: a tab the user
			// asked for out loud should be the tab they are looking at.
			return requestFromRenderer<NewTabWithPromptResult>(
				requireWindow('open a tab'),
				'remote:newAITabWithPrompt',
				{
					fallback: { success: false },
					timeoutMs: NEW_TAB_TIMEOUT_MS,
					parse: parseNewTabWithPromptResult,
					args: [agentSessionId, prompt],
				}
			);
		},

		async executeCommand(agentSessionId, tabId, prompt) {
			return requestFromRenderer<CommandReceipt>(
				requireWindow('send a prompt'),
				'remote:executeCommand',
				{
					fallback: { accepted: false, reason: 'renderer-timeout' },
					timeoutMs: COMMAND_RECEIPT_TIMEOUT_MS,
					parse: parseCommandReceipt,
					// Positional: (sessionId, command, inputMode, tabId, force, images,
					// background) before the receipt channel. `force: false` keeps the
					// renderer's busy guard - talking over a working agent must not
					// interleave two prompts in one tab.
					args: [agentSessionId, prompt, 'ai', tabId, false, undefined, false],
				}
			);
		},
	};
}

function parseNewTabWithPromptResult(raw: unknown): NewTabWithPromptResult {
	if (typeof raw === 'object' && raw !== null) {
		const result = raw as { success?: unknown; tabId?: unknown };
		return {
			success: result.success === true,
			tabId: typeof result.tabId === 'string' ? result.tabId : undefined,
		};
	}
	// Older renderers ack with a bare boolean and no tab id.
	return { success: raw === true };
}

function parseCommandReceipt(raw: unknown): CommandReceipt {
	if (typeof raw === 'object' && raw !== null && 'accepted' in raw) {
		const receipt = raw as { accepted?: unknown; reason?: unknown };
		return {
			accepted: receipt.accepted === true,
			reason: typeof receipt.reason === 'string' ? receipt.reason : undefined,
		};
	}
	return { accepted: false, reason: 'malformed-receipt' };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface VoiceRouteExecutorOptions {
	bridge: VoiceRendererBridge;
	/** Persisted sessions. Defaults to the main sessions store. */
	getSessions?: () => StoredSession[];
	/** The agent the desktop is on, used when the Brain targets the conductor. */
	getActiveSessionId?: () => string | null;
}

interface ResolvedExecutorDeps {
	bridge: VoiceRendererBridge;
	getSessions: () => StoredSession[];
	getActiveSessionId: () => string | null;
}

/** Bind an executor for `VoiceSessionServiceOptions.executeRoute`. */
export function createVoiceRouteExecutor(options: VoiceRouteExecutorOptions): VoiceRouteExecutor {
	const deps: ResolvedExecutorDeps = {
		bridge: options.bridge,
		getSessions: options.getSessions ?? readStoredSessions,
		getActiveSessionId: options.getActiveSessionId ?? readActiveSessionId,
	};
	return (decision, context) => executeRouteDecision(decision, context, deps);
}

/**
 * Perform one decision and report what actually happened. The result becomes the
 * `dispatch` event, so every field has to describe the real outcome rather than
 * the request: "opened a new tab named Auth Refactor on agent Backend" is only
 * true if the renderer says it is.
 *
 * Every known failure throws `VoiceDispatchError`, which the session service
 * turns into a `dispatch-failed` event. Anything else is a bug and reaches
 * Sentry unchanged.
 */
export async function executeRouteDecision(
	decision: RouteDecision,
	context: { roster: RosterAgent[]; scope: VoiceScope },
	deps: ResolvedExecutorDeps
): Promise<VoiceDispatchResult> {
	// Re-read rather than trusting the roster the Brain saw: routing is async and
	// the user can close a tab while a decision is in flight.
	const sessions = deps.getSessions();
	const roster = buildAgentRoster(sessions);
	const agent = resolveAgent(decision, context, roster, deps.getActiveSessionId());
	const prompt = decision.prompt.trim();

	if (decision.tabAction === 'new') {
		return openNewTab(agent, prompt, decision.tabName, deps.bridge);
	}

	// `activeTabId` is deliberately not on `RosterAgent` - the Brain routes by
	// name, not by which tab happens to be on screen - so it is read here.
	const stored = sessions.find((session) => session.id === agent.sessionId);
	const activeTabId = typeof stored?.activeTabId === 'string' ? stored.activeTabId : null;
	const tabId =
		decision.tabAction === 'recall'
			? resolveRecalledTab(agent, decision.tabId)
			: resolveCurrentTab(agent, activeTabId);

	if (!tabId) {
		// The agent has no AI tab to talk into. Creating one is the only honest way
		// to land the prompt, and the result says `created` so nobody is told a tab
		// was focused that never existed.
		logger.info(`Agent '${agent.name}' has no open AI tab; creating one`, LOG_CONTEXT);
		return openNewTab(agent, prompt, decision.tabName, deps.bridge);
	}

	deps.bridge.selectSession(agent.sessionId, tabId);
	const promptSent = await sendPrompt(deps.bridge, agent.sessionId, tabId, prompt);

	return {
		agentSessionId: agent.sessionId,
		agentName: agent.name,
		tabId,
		tabName: agent.tabs.find((tab) => tab.id === tabId)?.name ?? undefined,
		action: decision.tabAction === 'recall' ? 'recalled' : 'focused',
		promptSent,
	};
}

/**
 * A conductor-targeted decision still has to land somewhere. Preference order:
 * the session's bound agent, then the agent the desktop is showing, then the
 * only agent there is. With several agents and no signal, guessing would put a
 * spoken instruction in the wrong repository, so it fails instead.
 */
function resolveAgent(
	decision: RouteDecision,
	context: { roster: RosterAgent[]; scope: VoiceScope },
	roster: RosterAgent[],
	activeSessionId: string | null
): RosterAgent {
	const byId = (sessionId: string | null): RosterAgent | undefined =>
		sessionId ? roster.find((agent) => agent.sessionId === sessionId) : undefined;

	const targetId = routeTargetSessionId(decision.target);
	if (targetId) {
		const agent = byId(targetId);
		if (!agent) {
			throw new VoiceDispatchError(`Agent '${targetId}' is no longer running`);
		}
		return agent;
	}

	const scoped = context.scope.kind === 'agent' ? byId(context.scope.sessionId) : undefined;
	const fallback = scoped ?? byId(activeSessionId) ?? (roster.length === 1 ? roster[0] : undefined);
	if (!fallback) {
		throw new VoiceDispatchError(
			roster.length === 0
				? 'No agents are open to dispatch to'
				: 'No agent was named and none is active, so the request has no target'
		);
	}
	return fallback;
}

/** Recall is a promise to return somewhere specific. A gone tab is a failure. */
function resolveRecalledTab(agent: RosterAgent, tabId: string | undefined): string {
	if (!tabId) {
		throw new VoiceDispatchError(`Cannot recall a tab on '${agent.name}' without a tab id`);
	}
	if (!agent.tabs.some((tab) => tab.id === tabId)) {
		throw new VoiceDispatchError(`That tab is no longer open on '${agent.name}'`);
	}
	return tabId;
}

/** The agent's active tab, or its most recently used one. */
function resolveCurrentTab(agent: RosterAgent, activeTabId: string | null): string | null {
	if (agent.tabs.length === 0) return null;
	if (activeTabId && agent.tabs.some((tab) => tab.id === activeTabId)) return activeTabId;
	const mostRecent = [...agent.tabs].sort(
		(a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
	)[0];
	return mostRecent.id;
}

async function openNewTab(
	agent: RosterAgent,
	prompt: string,
	tabName: string | undefined,
	bridge: VoiceRendererBridge
): Promise<VoiceDispatchResult> {
	let tabId: string | null;
	let promptSent = false;

	if (prompt) {
		// One atomic renderer operation: a separate create-then-send would leave an
		// orphan tab behind whenever the send is dropped.
		const result = await bridge.newTabWithPrompt(agent.sessionId, prompt);
		if (!result.success || !result.tabId) {
			throw new VoiceDispatchError(`Could not open a new tab on '${agent.name}'`);
		}
		tabId = result.tabId;
		promptSent = true;
	} else {
		tabId = await bridge.newTab(agent.sessionId);
		if (!tabId) {
			throw new VoiceDispatchError(`Could not open a new tab on '${agent.name}'`);
		}
	}

	if (tabName) {
		bridge.renameTab(agent.sessionId, tabId, tabName);
	}

	return {
		agentSessionId: agent.sessionId,
		agentName: agent.name,
		tabId,
		tabName,
		action: 'created',
		promptSent,
	};
}

/**
 * A rejected receipt is a real failure, not a `promptSent: false` footnote: the
 * session holds the floor open waiting for a reply that would never come.
 */
async function sendPrompt(
	bridge: VoiceRendererBridge,
	agentSessionId: string,
	tabId: string,
	prompt: string
): Promise<boolean> {
	if (!prompt) return false;

	const receipt = await bridge.executeCommand(agentSessionId, tabId, prompt);
	if (!receipt.accepted) {
		throw new VoiceDispatchError(
			`The prompt was not delivered (${receipt.reason ?? 'no reason given'})`
		);
	}
	return true;
}
