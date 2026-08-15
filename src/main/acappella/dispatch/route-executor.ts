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

import type { RosterAgent, VoiceScope } from '../../../shared/acappella/protocol';
import type { RouteDecision } from '../../../shared/acappella/route-decision';
import { isClarification, routeTargetSessionId } from '../../../shared/acappella/route-decision';
import type { StoredSession } from '../../stores/types';
import { getSessionsStore } from '../../stores/getters';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { logger } from '../../utils/logger';
import { requestFromRenderer } from '../../web-server/callbacks/remoteRequest';
import { buildRoutingRoster } from '../router/routing-context';
import { resolveRecall } from '../router/tab-recall';
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
 * the phone's project wheel will later render.
 *
 * One builder, shared with the router: the Brain and the executor disagreeing
 * about which tabs exist is how a decision becomes undispatchable between being
 * made and being performed.
 */
export function buildAgentRoster(sessions: StoredSession[]): RosterAgent[] {
	return buildRoutingRoster(sessions);
}

/** The roster as of right now, straight from the store. */
export function readAgentRoster(): RosterAgent[] {
	return buildAgentRoster(readStoredSessions());
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
 * What the renderer did to land on a tab.
 *
 * `focused` is the ordinary case; the other two are the states main cannot
 * resolve on its own, because waking a snoozed tab and reopening a closed one
 * both need renderer-owned state. Reporting which one happened is what lets the
 * `dispatch` event say something true: "back in the auth conversation" is a lie
 * if the tab was still snoozed underneath.
 */
export interface FocusTabResult {
	ok: boolean;
	/** The tab actually landed on. It can differ when a wake found a duplicate. */
	tabId?: string;
	action?: 'focused' | 'woke' | 'reopened';
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
	/**
	 * `remote:focusAiTab` - land on one AI tab and say what that took.
	 *
	 * Distinct from `selectSession` because it is a REQUEST: it waits for the
	 * renderer, which is the only side that can wake a snoozed tab, reopen a
	 * closed one, or honour the tiling invariant. Announcing a recall before the
	 * renderer confirmed it is how a client ends up narrating a tab the user
	 * cannot see.
	 */
	focusTab(agentSessionId: string, tabId: string): Promise<FocusTabResult>;
	/** `remote:renameTab` - name an existing AI tab. */
	renameTab(agentSessionId: string, tabId: string, name: string): void;
	/** `remote:newTab` - open an empty AI tab. Resolves to its id, or null. */
	newTab(agentSessionId: string): Promise<string | null>;
	/** `remote:newAITabWithPrompt` - open a tab and dispatch a prompt atomically. */
	newTabWithPrompt(agentSessionId: string, prompt: string): Promise<NewTabWithPromptResult>;
	/** `remote:executeCommand` - send a prompt to an existing tab, awaiting its receipt. */
	executeCommand(agentSessionId: string, tabId: string, prompt: string): Promise<CommandReceipt>;
}

/**
 * The real bridge: the window that OWNS the agent, and the existing `remote:*`
 * channels.
 *
 * `getWindowForSession` is what makes dispatch multi-window aware. Agent
 * ownership is per window while `activeSessionId` is global, so sending a voice
 * dispatch to whichever window happens to be "main" would activate an agent that
 * window does not own - the documented way to make a window render "No agents".
 * The owning window is also raised, because a spoken instruction that landed
 * behind another window has, from the user's side, done nothing.
 */
export function createRendererVoiceBridge(
	getWindow: () => BrowserWindow | null,
	getWindowForSession?: (agentSessionId: string) => BrowserWindow | null
): VoiceRendererBridge {
	const requireWindow = (operation: string, agentSessionId?: string): BrowserWindow => {
		const owner = agentSessionId ? getWindowForSession?.(agentSessionId) : null;
		const win = isWebContentsAvailable(owner) ? owner : getWindow();
		if (!isWebContentsAvailable(win)) {
			throw new VoiceDispatchError(`No renderer is available to ${operation}`);
		}
		return win;
	};

	/** Raise the window a dispatch is about to land in. Never steals from another app. */
	const revealWindow = (win: BrowserWindow): void => {
		if (win.isMinimized()) win.restore();
		win.show();
	};

	return {
		selectSession(agentSessionId, tabId) {
			const win = requireWindow('focus an agent', agentSessionId);
			revealWindow(win);
			win.webContents.send('remote:selectSession', agentSessionId, tabId);
		},

		async focusTab(agentSessionId, tabId) {
			const win = requireWindow('focus a tab', agentSessionId);
			revealWindow(win);
			return requestFromRenderer<FocusTabResult>(win, 'remote:focusAiTab', {
				fallback: { ok: false, reason: 'renderer-timeout' },
				timeoutMs: NEW_TAB_TIMEOUT_MS,
				parse: parseFocusTabResult,
				args: [agentSessionId, tabId],
			});
		},

		renameTab(agentSessionId, tabId, name) {
			requireWindow('rename a tab', agentSessionId).webContents.send(
				'remote:renameTab',
				agentSessionId,
				tabId,
				name
			);
		},

		async newTab(agentSessionId) {
			const result = await requestFromRenderer<{ tabId?: unknown } | null>(
				requireWindow('open a tab', agentSessionId),
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
				requireWindow('open a tab', agentSessionId),
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
				requireWindow('send a prompt', agentSessionId),
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

function parseFocusTabResult(raw: unknown): FocusTabResult {
	if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'malformed-result' };
	const result = raw as { ok?: unknown; tabId?: unknown; action?: unknown; reason?: unknown };
	return {
		ok: result.ok === true,
		tabId: typeof result.tabId === 'string' ? result.tabId : undefined,
		action:
			result.action === 'woke' || result.action === 'reopened' || result.action === 'focused'
				? result.action
				: undefined,
		reason: typeof result.reason === 'string' ? result.reason : undefined,
	};
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
	/** How long an identical decision replays instead of executing again. */
	replayWindowMs?: number;
}

interface ResolvedExecutorDeps {
	bridge: VoiceRendererBridge;
	getSessions: () => StoredSession[];
	getActiveSessionId: () => string | null;
	recentDispatches?: DispatchReplayCache;
}

/**
 * Remembers what each decision already did, briefly.
 *
 * A dispatch is retried whenever a renderer round trip times out and the caller
 * tries again, and the failure mode that costs the user something is a decision
 * that opened a tab, lost the receipt, and opened a second one. Replaying the
 * first result is idempotence: the same decision performed twice is the same
 * dispatch, not two.
 *
 * The window is short on purpose. Beyond it, saying the same thing again is a
 * person repeating themselves, and they mean it.
 */
export interface DispatchReplayCache {
	get(key: string): VoiceDispatchResult | undefined;
	set(key: string, value: VoiceDispatchResult): void;
}

/** Thirty seconds: long enough for a retry, short enough not to swallow intent. */
export const DEFAULT_REPLAY_WINDOW_MS = 30_000;

export function createDispatchReplayCache(
	ttlMs: number = DEFAULT_REPLAY_WINDOW_MS,
	now: () => number = Date.now
): DispatchReplayCache {
	const entries = new Map<string, { at: number; result: VoiceDispatchResult }>();

	return {
		get(key) {
			// A window of zero disables replay outright rather than depending on two
			// dispatches landing in different milliseconds.
			if (ttlMs <= 0) return undefined;
			const entry = entries.get(key);
			if (!entry) return undefined;
			if (now() - entry.at > ttlMs) {
				entries.delete(key);
				return undefined;
			}
			return entry.result;
		},
		set(key, result) {
			const at = now();
			entries.set(key, { at, result });
			// Swept on write rather than on a timer: the map only grows when someone
			// is talking, so the moment it grows is the moment to prune it.
			for (const [candidate, entry] of entries) {
				if (at - entry.at > ttlMs) entries.delete(candidate);
			}
		},
	};
}

/** Bind an executor for `VoiceSessionServiceOptions.executeRoute`. */
export function createVoiceRouteExecutor(options: VoiceRouteExecutorOptions): VoiceRouteExecutor {
	const deps: ResolvedExecutorDeps = {
		bridge: options.bridge,
		getSessions: options.getSessions ?? readStoredSessions,
		getActiveSessionId: options.getActiveSessionId ?? readActiveSessionId,
		recentDispatches: createDispatchReplayCache(options.replayWindowMs),
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
	// A clarification is a question, not an instruction. Reaching the executor
	// with one means a caller skipped the guard, and dispatching it would send
	// the user their own half-finished request.
	if (isClarification(decision)) {
		throw new VoiceDispatchError('That decision is a question, not a dispatch');
	}

	// Re-read rather than trusting the roster the Brain saw: routing is async and
	// the user can close a tab while a decision is in flight.
	const sessions = deps.getSessions();
	const roster = buildAgentRoster(sessions);
	const agent = resolveAgent(decision, context, roster, deps.getActiveSessionId());
	const prompt = decision.prompt.trim();

	// Idempotency is checked AFTER the roster read so a retry that is no longer
	// performable still fails rather than replaying a stale success, and before
	// anything is created so a retried decision cannot open a second tab.
	const key = dispatchKey(decision, agent.sessionId);
	const replayed = deps.recentDispatches?.get(key);
	if (replayed) {
		logger.info(`Replaying the dispatch for an identical decision on '${agent.name}'`, LOG_CONTEXT);
		return replayed;
	}

	const result = await performDispatch(decision, agent, roster, sessions, prompt, deps);
	deps.recentDispatches?.set(key, result);
	return result;
}

async function performDispatch(
	decision: RouteDecision,
	agent: RosterAgent,
	roster: RosterAgent[],
	sessions: StoredSession[],
	prompt: string,
	deps: ResolvedExecutorDeps
): Promise<VoiceDispatchResult> {
	if (decision.tabAction === 'new') {
		return openNewTab(agent, prompt, decision.tabName, deps.bridge);
	}

	if (decision.tabAction === 'recall') {
		return recallTab(decision, agent, roster, prompt, deps);
	}

	// `activeTabId` is deliberately not on `RosterAgent` - the Brain routes by
	// name, not by which tab happens to be on screen - so it is read here.
	const stored = sessions.find((session) => session.id === agent.sessionId);
	const activeTabId = typeof stored?.activeTabId === 'string' ? stored.activeTabId : null;
	const tabId = resolveCurrentTab(agent, activeTabId);

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
		action: 'focused',
		promptSent,
	};
}

/**
 * Return to an existing conversation, waking or reopening it if that is what it
 * takes.
 *
 * The focus is a REQUEST rather than a fire-and-forget send, because the three
 * states a recalled tab can be in are only distinguishable in the renderer, and
 * announcing a recall the renderer did not perform would tell the user they are
 * somewhere they are not.
 */
async function recallTab(
	decision: RouteDecision,
	agent: RosterAgent,
	roster: RosterAgent[],
	prompt: string,
	deps: ResolvedExecutorDeps
): Promise<VoiceDispatchResult> {
	const resolution = resolveRecall(decision, roster, { confirmed: true });
	if (resolution.kind === 'missing') {
		// Recall is a promise to return somewhere specific. A gone tab is a failure,
		// never a silently different tab.
		throw new VoiceDispatchError(
			decision.tabId
				? `That tab is no longer open on '${agent.name}'`
				: `Cannot recall a tab on '${agent.name}' without a tab id`
		);
	}
	if (resolution.kind === 'offer') {
		// The router turns an offer into a spoken question before it ever reaches
		// here; arriving with one means the confirmation was skipped.
		throw new VoiceDispatchError(`That conversation is closed and was not confirmed for reopening`);
	}

	const focus = await deps.bridge.focusTab(resolution.agentSessionId, resolution.tab.id);
	if (!focus.ok) {
		throw new VoiceDispatchError(
			`Could not return to that conversation on '${agent.name}' (${focus.reason ?? 'no reason given'})`
		);
	}

	// The renderer may have landed on a different tab: waking a snooze whose
	// conversation is already open focuses the copy that exists rather than
	// restoring a duplicate.
	const tabId = focus.tabId ?? resolution.tab.id;
	const promptSent = await sendPrompt(deps.bridge, resolution.agentSessionId, tabId, prompt);

	return {
		agentSessionId: resolution.agentSessionId,
		agentName: agent.name,
		tabId,
		tabName: resolution.tab.name ?? undefined,
		action: 'recalled',
		promptSent,
	};
}

/**
 * Identity of a dispatch, for the replay guard.
 *
 * The prompt is part of the key because two identical requests to the same tab
 * ARE the same dispatch as far as the user is concerned - they said it twice
 * because the first one appeared to do nothing - while the same tab with a
 * different prompt is a new turn. The agent id rather than the decision's target
 * so a conductor-targeted retry resolved to the same agent still matches.
 */
function dispatchKey(decision: RouteDecision, agentSessionId: string): string {
	return [
		agentSessionId,
		decision.tabAction,
		decision.tabId ?? '',
		decision.tabName ?? '',
		decision.prompt.trim(),
	].join(' ');
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

/**
 * The agent's active tab, or its most recently used one.
 *
 * Only OPEN tabs are eligible. The roster deliberately lists snoozed and closed
 * ones so recall can name them, and "carry on where we were" landing on a tab
 * the user put away last week would be the worst possible reading of "current".
 */
function resolveCurrentTab(agent: RosterAgent, activeTabId: string | null): string | null {
	const open = agent.tabs.filter((tab) => (tab.state ?? 'open') === 'open');
	if (open.length === 0) return null;
	if (activeTabId && open.some((tab) => tab.id === activeTabId)) return activeTabId;
	const mostRecent = [...open].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0];
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
