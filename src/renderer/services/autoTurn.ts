/**
 * autoTurn - the renderer's side of a turn sent on the Auto model.
 *
 * A send never waits for the model router (`shared/autoTurn.ts`, rule 2). So a
 * turn on Auto takes its tab at once, with a `pending` stamp that holds rule
 * 1's verdict (`codifyTurnSettings`), and is finished here, in the async
 * stretch every spawn already has before it launches:
 *
 *   - {@link settleAutoTurn} asks the router, writes the final model, effort
 *     and place onto the tab, and returns what the spawn launches with. Every
 *     spawn of a user turn calls it: the composer, the queue drain, and a
 *     command that arrives from the CLI or the web.
 *   - {@link routeQueuedAutoItem} is how a message queued behind a busy agent is
 *     routed WHEN IT IS QUEUED: the router is asked then, and its answer is
 *     written onto the item. The drain reads it and asks nothing.
 *
 * The router runs in the main process (it owns the models and the decision
 * ledger), so both go through `window.maestro.localModels.routeTurn`. No
 * answer, for any reason, is a "no decision": the turn runs on the agent's
 * default, and the send is never failed by a routing.
 */

import type { AITab, QueuedItem, Session } from '../types';
import { isAutoModel } from '../../shared/autoModel';
import { autoRouteStamp, unreachableAutoRoute, type AutoRouteStamp } from '../../shared/autoTurn';
import {
	MODEL_ROUTING_TIMEOUT_MS,
	type ModelRoutingRecent,
} from '../../shared/local-models/model-routing-task';
import type { RunOnTarget } from '../../shared/local-models/run-on';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { logger } from '../utils/logger';
import {
	autoTurnLaunch,
	settleAutoTurnOnTab,
	type AutoTurnLaunch,
} from '../utils/providerTabSessions';
import { captureException } from '../utils/sentry';

/**
 * How long past the router's own timeout the bridge to it may take before the
 * turn stops waiting. The router answers inside its timeout by contract; this
 * covers the one thing it cannot, a bridge that never delivers the answer (the
 * browser build's socket dropping mid-request).
 */
export const ROUTE_BRIDGE_GRACE_MS = 250;

/** True for a transcript entry that is the agent's own answer. */
function isAssistantEntry(entry: AITab['logs'][number]): boolean {
	return entry.source === 'stdout' || entry.source === 'ai';
}

/**
 * The exchange before the message being sent: the agent's last answer and the
 * user message that led to it. Only so a short prompt ("do it") can be judged;
 * the router is never shown the transcript. The user's bubble for the message
 * being sent may already be in the log (the tab is marked busy first), which is
 * why the user message is the one BEFORE the last answer, never the last one.
 */
export function recentExchange(tab: AITab | undefined): ModelRoutingRecent | undefined {
	const logs = tab?.logs ?? [];
	let answerIndex = -1;
	for (let i = logs.length - 1; i >= 0; i--) {
		if (isAssistantEntry(logs[i]) && logs[i].text.trim() !== '') {
			answerIndex = i;
			break;
		}
	}
	if (answerIndex < 0) return undefined;
	let user: string | undefined;
	for (let i = answerIndex - 1; i >= 0; i--) {
		if (logs[i].source === 'user' && logs[i].text.trim() !== '') {
			user = logs[i].text;
			break;
		}
	}
	return { ...(user ? { user } : {}), assistant: logs[answerIndex].text };
}

/**
 * Ask the model router about one prompt. Never rejects and never outlasts the
 * router's timeout plus {@link ROUTE_BRIDGE_GRACE_MS}: every way of getting no
 * answer comes back as a stamp that says why.
 */
export async function requestTurnRoute(args: {
	sessionId: string;
	tab?: AITab;
	prompt: string;
	/** How long the router may take. Defaults to the send's {@link MODEL_ROUTING_TIMEOUT_MS}. */
	timeoutMs?: number;
}): Promise<AutoRouteStamp> {
	const { sessionId, tab, prompt, timeoutMs } = args;
	const recent = recentExchange(tab);
	const waitMs = (timeoutMs ?? MODEL_ROUTING_TIMEOUT_MS) + ROUTE_BRIDGE_GRACE_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bridgeTimeout = new Promise<AutoRouteStamp>((resolve) => {
		timer = setTimeout(
			() => resolve(unreachableAutoRoute(`The model router did not answer within ${waitMs} ms.`)),
			waitMs
		);
	});
	try {
		return await Promise.race([
			window.maestro.localModels
				.routeTurn({
					prompt,
					...(recent ? { recent } : {}),
					agentId: sessionId,
					...(tab ? { tabId: tab.id } : {}),
					...(timeoutMs !== undefined ? { timeoutMs } : {}),
				})
				.then(autoRouteStamp),
			bridgeTimeout,
		]);
	} catch (error) {
		// A routing never rejects, so this is a request the main process could not
		// read or a bridge that failed: a bug worth knowing about, and still not a
		// reason to fail the send.
		logger.error('[autoTurn] The model router could not be asked:', undefined, error);
		captureException(error, { extra: { operation: 'autoTurn:requestTurnRoute', sessionId } });
		return unreachableAutoRoute(`The model router could not be asked: ${ipcErrorMessage(error)}`);
	} finally {
		clearTimeout(timer);
	}
}

/** A routing asked for a queued item, and the text it was asked about. */
interface PendingItemRoute {
	text: string;
	route: Promise<AutoRouteStamp>;
}

/** Routings in flight for queued items, by item id, so a drain inside the window waits instead of asking twice. */
const pendingItemRoutes = new Map<string, PendingItemRoute>();

function findSession(sessionId: string): Session | undefined {
	return useSessionStore.getState().sessions.find((s) => s.id === sessionId);
}

/** A tab by id, wherever it lives: a tab closed mid-turn keeps running as an orphan. */
function findTab(session: Session | undefined, tabId: string): AITab | undefined {
	return (
		session?.aiTabs?.find((tab) => tab.id === tabId) ??
		session?.orphanedThinkingTabs?.find((tab) => tab.id === tabId)
	);
}

/**
 * Route a message that was just queued on the Auto model, and write the answer
 * onto it. Call it right after the item is in the queue. A no-op for an item on
 * a named model, one that already carries its answer, and one with no text of
 * its own (a slash command's prompt is only known when it is dispatched, so the
 * dispatch routes it).
 *
 * The answer is written only if the item is still queued with the text that
 * was routed. An item that has drained by then is settled by its dispatch,
 * which waits on this same routing.
 */
export function routeQueuedAutoItem(sessionId: string, item: QueuedItem): void {
	const text = item.type === 'message' ? item.text?.trim() : undefined;
	if (!text || !isAutoModel(item.turnSettings?.model) || item.turnSettings?.route) return;
	if (pendingItemRoutes.has(item.id)) return;

	const tab = findTab(findSession(sessionId), item.tabId);
	const route = requestTurnRoute({ sessionId, ...(tab ? { tab } : {}), prompt: text }).then(
		(answer) => {
			updateSessionWith(sessionId, (s) => ({
				...s,
				executionQueue: s.executionQueue.map((queued) =>
					queued.id === item.id &&
					queued.text?.trim() === text &&
					queued.turnSettings &&
					isAutoModel(queued.turnSettings.model) &&
					!queued.turnSettings.route
						? { ...queued, turnSettings: { ...queued.turnSettings, route: answer } }
						: queued
				),
			}));
			return answer;
		}
	);
	const pending: PendingItemRoute = { text, route };
	pendingItemRoutes.set(item.id, pending);
	void route.finally(() => {
		if (pendingItemRoutes.get(item.id) === pending) pendingItemRoutes.delete(item.id);
	});
}

/** The launch a settled Auto turn uses, or a throw naming the tier target that cannot be used. */
function launchOrRefuse(tab: AITab): AutoTurnLaunch | null {
	// A target a tier names and that cannot run is refused by name. The turn is
	// never launched on some other model in its place.
	if (tab.turnAuto?.refusal) throw new Error(tab.turnAuto.refusal);
	return autoTurnLaunch(tab);
}

/**
 * Finish the Auto turn a tab is running and say what it launches with.
 *
 * Returns `null` when the tab's turn was not sent on Auto: the caller spawns
 * with its own model and effort. For a turn whose stamp is final already (a
 * queued message that carried its answer) nothing is asked. Otherwise the
 * router is asked about `prompt`, which is what was sent, without the notes
 * Maestro adds around it, and the tab's `pending` stamp becomes final.
 *
 * Throws when the tier the router chose names a target that cannot be used.
 * Call it inside the spawn's own `try`, so the turn fails the way a spawn that
 * was refused fails.
 */
export async function settleAutoTurn(args: {
	sessionId: string;
	tabId: string;
	prompt: string;
	/** The queue item the turn came from: a routing asked when it was queued is waited on. */
	itemId?: string;
}): Promise<AutoTurnLaunch | null> {
	const { sessionId, tabId, prompt, itemId } = args;
	const session = findSession(sessionId);
	const tab = findTab(session, tabId);
	if (!session || !tab?.turnAuto) return null;
	if (tab.turnAuto.status !== 'pending') return launchOrRefuse(tab);

	const queued = itemId ? pendingItemRoutes.get(itemId) : undefined;
	const route = await (queued && queued.text === prompt.trim()
		? queued.route
		: requestTurnRoute({ sessionId, tab, prompt }));

	// The answer took time. Settle the tab as it is NOW: `settleAutoTurnOnTab`
	// leaves a turn that was settled or replaced in the meantime alone.
	const settle = (candidate: AITab, owner: Session): AITab =>
		candidate.id === tabId ? settleAutoTurnOnTab(candidate, owner, route) : candidate;
	updateSessionWith(sessionId, (s) => ({
		...s,
		aiTabs: s.aiTabs.map((candidate) => settle(candidate, s)),
		...(s.orphanedThinkingTabs
			? { orphanedThinkingTabs: s.orphanedThinkingTabs.map((candidate) => settle(candidate, s)) }
			: {}),
	}));

	// A tab that is gone has nothing to write to, and its turn still launches:
	// settle the copy that was read instead.
	const settled =
		findTab(findSession(sessionId), tabId) ?? settleAutoTurnOnTab(tab, session, route);
	return launchOrRefuse(settled);
}

/** The model, effort and place of a spawn, as `window.maestro.process.spawn` takes them. */
export interface TurnSpawnSettings {
	sessionCustomModel?: string;
	sessionCustomEffort?: string;
	runOnOverride?: RunOnTarget;
}

/**
 * What a spawn passes for its model, effort and place: the settled Auto turn's
 * when the turn was sent on Auto, else the caller's own. `runOnOverride` is set
 * only when Auto decided the place, so every other turn keeps reading the
 * agent's own Run on target from the store.
 */
export function turnSpawnSettings(
	auto: AutoTurnLaunch | null,
	own: { model?: string; effort?: string }
): TurnSpawnSettings {
	if (!auto) return { sessionCustomModel: own.model, sessionCustomEffort: own.effort };
	return {
		sessionCustomModel: auto.model,
		sessionCustomEffort: auto.effort,
		...(auto.runOn ? { runOnOverride: auto.runOn } : {}),
	};
}

/** Forget routings in flight, so each test starts from a fresh module. */
export function resetAutoTurnForTests(): void {
	pendingItemRoutes.clear();
}
