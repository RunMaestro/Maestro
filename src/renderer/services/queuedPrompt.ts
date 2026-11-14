import { getAgentCommands } from '../utils/agentCommands';
import { flushSessionPersistenceNow } from './sessionPersistenceFlush';
/**
 * queuedPrompt - put a prompt into an agent's execution queue from outside the
 * composer.
 *
 * Everything that sends a message to an agent without a user typing it (the
 * CLI's `dispatch --queue`, a snooze's wake prompt) has the same two problems:
 * the item has to be byte-identical to one the composer would have built, or it
 * renders wrong and drains wrong; and it must not race whatever the agent is
 * already doing.
 *
 * The queue solves the second one for free. An item appended here is dispatched
 * by `useQueueProcessing`, which drains an idle agent on its next render and an
 * busy one when its turn finishes - so a caller never has to ask "is the agent
 * free?" and never has to reimplement the spawn. It also means the target tab
 * is re-resolved at DRAIN time (`resolveQueuedItemTarget`), which is what makes
 * this safe to call in the same tick as a store write that created the tab:
 * nothing here depends on React having re-rendered yet.
 *
 * Module functions rather than a hook, because the callers (a 15s sweep timer,
 * an IPC listener) run outside React.
 */

import type { AITab, QueuedItem, QueuedItemEditPatch, QueuedTurnSettings, Session } from '../types';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { useAgentStore } from '../stores/agentStore';
import { getDispatchDeps } from '../stores/retryStore';
import type { QueuedSlashCommand } from '../utils/executionQueue';
import { getActiveTab, getTabDisplayName } from '../utils/tabHelpers';
import {
	applyQueuedItemDispatch,
	getQueueBusyContext,
	mergeQueuedItemIntoPrevious,
} from '../utils/executionQueue';
import { captureQueuedTurnSettings } from '../utils/providerTabSessions';
import { planCrossAgentMentions, queuedMentionFields } from './crossAgentMentions';
import type { MentionRouting } from '../../shared/crossAgentContext';
import { routeQueuedAutoItem } from './autoTurn';
import { generateId } from '../utils/ids';
import type { ConsultChain } from '../../shared/consultBudget';
import { logger } from '../utils/logger';
import { canonicalJson } from '../../shared/canonicalJson';
import { resolveTabPermissionMode } from '../../shared/agentMetadata';
import { resumeSelectionKey, matchesNativeSessionBinding } from './resumableSession';
import { useSettingsStore } from '../stores/settingsStore';
import { getSessionSshRemoteId } from '../utils/sessionHelpers';
import {
	fingerprintGrokSpawnSelection,
	type GrokSpawnSelectionFingerprint,
} from '../../shared/grokSpawnSelection';

// Identity survives queue/retry object spreads, but not persistence or cloning.
// Sensitive selection keys and IPC snapshots never become part of the queue.
const commandScopes = new WeakMap<
	NonNullable<QueuedItem['commandScope']>,
	{
		itemId: string;
		selection: string;
		configuration: Promise<GrokSpawnSelectionFingerprint | null>;
	}
>();

function commandSelectionKey(session: Session, tab: AITab): string {
	return canonicalJson({
		selection: resumeSelectionKey(session),
		tabId: tab.id,
		nativeSessionId: tab.agentSessionId ?? null,
		binding: tab.nativeSessionBinding,
		permissionMode: resolveTabPermissionMode(tab),
		shellEnvVars: useSettingsStore.getState().shellEnvVars,
	});
}

/** Read configuration only, with a deadline for a disconnected desktop bridge. */
async function readCommandConfiguration(
	session: Session
): Promise<GrokSpawnSelectionFingerprint | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// Match the launch resolver: configured SSH selects the next turn;
		// sshRemoteId/remoteCwd describe a previous process or terminal.
		const remote = session.sessionSshRemoteConfig?.enabled === true;
		const remoteId = remote
			? getSessionSshRemoteId({ sessionSshRemoteConfig: session.sessionSshRemoteConfig })
			: undefined;
		if (remote && !remoteId) return null;
		return await Promise.race([
			Promise.all([
				window.maestro.agents.getConfig('grok'),
				window.maestro.settings.get('shellEnvVars'),
				remoteId ? window.maestro.sshRemote.getConfigs() : undefined,
			]).then(([config, shellEnvVars, remotes]) => {
				const remote = remotes?.configs?.find((entry) => entry.id === remoteId);
				if (!config || (remoteId && (!remotes?.success || !remote?.enabled))) return null;
				const globalEnv = shellEnvVars ?? {};
				if (
					typeof globalEnv !== 'object' ||
					Array.isArray(globalEnv) ||
					Object.values(globalEnv).some((value) => typeof value !== 'string')
				)
					return null;
				return fingerprintGrokSpawnSelection({
					providerConfig: config,
					shellEnvVars: globalEnv as Record<string, string>,
					sshRemote: remote ?? null,
				});
			}),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), 3_000);
			}),
		]);
	} catch {
		// Missing/failed IPC is unavailable ownership, never permission to send.
		return null;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** A command must keep its selected owner even if the provider has since changed. */
export function getQueuedCommandSelectionRefusal(
	sessionId: string,
	item: QueuedItem
): string | undefined {
	const session = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId);
	if (item.type !== 'command' || (session?.toolType !== 'grok' && !item.commandScope)) return;
	const scope = item.commandScope && commandScopes.get(item.commandScope);
	const tab =
		session?.aiTabs.find((entry) => entry.id === item.tabId) ??
		session?.orphanedThinkingTabs?.find((entry) => entry.id === item.tabId);
	const refusal =
		'Queued Grok command ownership is missing or changed. Requeue it from the intended tab, account and host.';
	if (
		!scope ||
		scope.itemId !== item.id ||
		!session ||
		!tab ||
		session.toolType !== 'grok' ||
		scope.selection !== commandSelectionKey(session, tab)
	)
		return refusal;
	if (
		tab.agentSessionId &&
		(!matchesNativeSessionBinding(tab.nativeSessionBinding, tab.nativeSessionBinding) ||
			tab.nativeSessionBinding?.state !== 'bound' ||
			tab.nativeSessionBinding.provider !== 'grok' ||
			tab.nativeSessionBinding.nativeSessionId !== tab.agentSessionId)
	)
		return refusal;
}

/** Recheck inherited configuration as well as the live renderer selection. */
export async function getQueuedCommandScopeRefusal(
	sessionId: string,
	item: QueuedItem
): Promise<string | undefined> {
	const refusal = getQueuedCommandSelectionRefusal(sessionId, item);
	if (refusal || item.type !== 'command' || !item.commandScope) return refusal;
	const scope = commandScopes.get(item.commandScope)!;
	const session = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId)!;
	const [captured, current] = await Promise.all([
		scope.configuration,
		readCommandConfiguration(session),
	]);
	if (captured === null || current === null || captured !== current) {
		return 'Queued Grok command configuration is unavailable or changed. Requeue it with the intended settings.';
	}
	return getQueuedCommandSelectionRefusal(sessionId, item);
}

/** Forward the original receipt to main, never a freshly read replacement. */
export async function getQueuedCommandSpawnSelection(
	sessionId: string,
	item: QueuedItem
): Promise<GrokSpawnSelectionFingerprint | null> {
	if (
		item.type !== 'command' ||
		!item.commandScope ||
		getQueuedCommandSelectionRefusal(sessionId, item)
	)
		return null;
	return commandScopes.get(item.commandScope)?.configuration ?? null;
}

/** What to queue, and where. */
export interface QueuedPromptOptions {
	session: Session;
	/** Tab the prompt is addressed to. */
	tab: AITab;
	text: string;
	/** Base64 data URLs, forwarded to the spawn. */
	images?: string[];
	/**
	 * The place in a consult chain the queued turn takes, when another agent's
	 * `maestro-cli dispatch` is what queued it. See `QueuedItem.consultChain`.
	 */
	consultChain?: ConsultChain;
	/** Resolve a slash command through the command queue when this item drains. */
	slashCommand?: boolean;
	/** Existing send snapshot, when queueing follows an asynchronous preflight. */
	turnSettings?: QueuedTurnSettings;
	/**
	 * A routing picked for the message's `@mentions` (`dispatch --routing`), the
	 * way the composer's routing strip picks one. Stamped on the item, because the
	 * drain re-plans from the text and the text alone would route it by wording.
	 */
	mentionRouting?: MentionRouting;
}

/**
 * Build the queue item a message or slash command becomes, as the composer does.
 *
 * Three of these fields are easy to omit and each has a visible cost:
 * `tabName` is the label a closed tab's queued item falls back to,
 * `readOnlyMode` is what lets the item bypass the parallel-execution guard, and
 * `turnSettings` freezes the model and effort at queue time so a queue that
 * drains after the user switches models still runs - and is labeled - with what
 * was selected when it was queued.
 *
 * The `@mention` flags are stamped but NOT fired: a consult must reach the
 * other agent when this item becomes the agent's turn, not when it was queued.
 * `agentStore.processQueuedItem` fires it at drain time.
 */
export function buildQueuedMessageItem({
	session,
	tab,
	text,
	images,
	consultChain,
	slashCommand,
	turnSettings,
	mentionRouting,
}: QueuedPromptOptions): QueuedItem {
	const commandText = slashCommand ? text.trim() : undefined;
	const firstWhitespace = commandText?.search(/\s/) ?? -1;
	const mentionPlan = slashCommand
		? null
		: planCrossAgentMentions(text, session.id, mentionRouting);
	const item: QueuedItem = {
		id: generateId(),
		timestamp: Date.now(),
		tabId: tab.id,
		...(commandText !== undefined
			? {
					type: 'command' as const,
					command: firstWhitespace === -1 ? commandText : commandText.slice(0, firstWhitespace),
					commandArgs: firstWhitespace === -1 ? '' : commandText.slice(firstWhitespace + 1).trim(),
				}
			: { type: 'message' as const, text }),
		...(images && images.length > 0 ? { images: [...images] } : {}),
		tabName: getTabDisplayName(tab, session.agentSessionId),
		readOnlyMode: tab.readOnlyMode === true || tab.permissionMode === 'readonly',
		turnSettings: turnSettings ?? captureQueuedTurnSettings(tab, session),
		...queuedMentionFields(mentionPlan),
		...(mentionPlan && { crossAgentOnly: mentionPlan.suppressLocal }),
		...(consultChain ? { consultChain } : {}),
	};
	if (item.type === 'command' && session.toolType === 'grok') {
		item.commandScope = { provider: 'grok' };
		commandScopes.set(item.commandScope, {
			itemId: item.id,
			selection: commandSelectionKey(session, tab),
			configuration: readCommandConfiguration(session),
		});
	}
	return item;
}

/**
 * The slash command a message IS, when the whole message is exactly one of the
 * user's commands (`/commit`). Searches the same sets, in the same order, that
 * `agentStore.processQueuedItem` resolves a command item against, so an item
 * built from a match here always finds its definition there.
 */
function matchSlashCommand(
	session: Session,
	text: string,
	tab: AITab
): { command: string; description?: string } | null {
	const commandText = text.trim();
	if (!commandText.startsWith('/')) return null;
	const deps = getDispatchDeps();
	return (
		deps?.customAICommands.find((cmd) => cmd.command === commandText) ??
		deps?.speckitCommands.find((cmd) => cmd.command === commandText) ??
		deps?.openspecCommands.find((cmd) => cmd.command === commandText) ??
		deps?.bmadCommands?.find((cmd) => cmd.command === commandText) ??
		(session.toolType !== 'grok'
			? getAgentCommands(session, tab)?.find((cmd) => cmd.command === commandText && cmd.prompt)
			: undefined) ??
		null
	);
}

/**
 * Queue a prompt for one tab of one agent, reading both from the store.
 *
 * `tabId` names the tab the prompt belongs to. An id that no longer resolves
 * falls back to the agent's active tab for reference providers. Grok refuses
 * a missing tab rather than changing the selected owner. For other providers the
 * caller has already decided this agent should be asked something, and losing
 * that because a tab moved is worse than answering it in the tab next door.
 *
 * `expandCommands` is for text a person typed (Quick Chat): a message that is
 * exactly one of their slash commands is queued as that COMMAND, the way the
 * composer queues it, instead of as the literal text `/commit`. Callers whose
 * text was written by a program leave it off.
 *
 * @returns The queued item, or null when the agent is gone or has no AI tab.
 */
export function enqueuePromptForTab(options: {
	sessionId: string;
	tabId: string;
	text: string;
	images?: string[];
	consultChain?: ConsultChain;
	slashCommand?: boolean;
	/** Existing send snapshot, when queueing follows an asynchronous preflight. */
	turnSettings?: QueuedTurnSettings;
	expandCommands?: boolean;
	mentionRouting?: MentionRouting;
}): QueuedItem | null {
	const {
		sessionId,
		tabId,
		text,
		images,
		consultChain,
		slashCommand,
		expandCommands,
		mentionRouting,
	} = options;
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session) return null;

	const tab =
		session.aiTabs?.find((t) => t.id === tabId) ??
		(session.toolType === 'grok' ? undefined : getActiveTab(session));
	if (!tab) return null;

	const command = expandCommands && !slashCommand ? matchSlashCommand(session, text, tab) : null;
	const message = buildQueuedMessageItem({
		session,
		tab,
		text,
		images,
		consultChain,
		slashCommand: slashCommand || !!command,
		mentionRouting,
		turnSettings: options.turnSettings,
	});
	const item: QueuedItem = command
		? { ...message, commandDescription: command.description }
		: message;
	updateSessionWith(sessionId, (s) => ({
		...s,
		executionQueue: [...(s.executionQueue || []), item],
	}));
	// On an agent set to the Auto model the prompt is routed as it is queued,
	// like one the composer queues. A no-op on a named model.
	routeQueuedAutoItem(sessionId, item);
	return item;
}

/**
 * Take one item out of an agent's queue before it runs.
 *
 * @returns Whether it was still there to take. The check and the removal are one
 * store update, so a caller that means to send the prompt somewhere else can
 * trust `true`: the queue did not also start it. On `false` the item already
 * ran (or someone else removed it), and sending it again would send it twice.
 */
export function removeQueuedItem(sessionId: string, itemId: string): boolean {
	let removed = false;
	let managed = false;
	updateSessionWith(sessionId, (s) => {
		if (!s.executionQueue?.some((i) => i.id === itemId)) return s;
		managed = !!s.executionQueue.find((i) => i.id === itemId)?.pendingAdmissionId;
		removed = true;
		return { ...s, executionQueue: s.executionQueue.filter((i) => i.id !== itemId) };
	});
	if (managed)
		void flushSessionPersistenceNow(useSessionStore.getState().sessions).catch((error) =>
			logger.error('[Queue] Failed to persist managed cancellation', undefined, error)
		);
	return removed;
}

/**
 * Hold or resume one queued item: the queued card's Hold / Resume, and
 * `maestro-cli queue hold|resume`. A held item keeps its place but nothing
 * dispatches it until it is resumed.
 *
 * @returns Whether the item was in the queue to change.
 */
export function setQueuedItemPaused(sessionId: string, itemId: string, paused: boolean): boolean {
	return writeQueuedItemPaused(sessionId, itemId, () => paused);
}

/**
 * Flip one queued item between held and live: the queued card's Hold / Resume
 * button. Reads the current state inside the same store update that writes it.
 *
 * @returns Whether the item was in the queue to change.
 */
export function toggleQueuedItemPaused(sessionId: string, itemId: string): boolean {
	return writeQueuedItemPaused(sessionId, itemId, (current) => !current);
}

function writeQueuedItemPaused(
	sessionId: string,
	itemId: string,
	next: (current: boolean) => boolean
): boolean {
	let found = false;
	let managed = false;
	updateSessionWith(sessionId, (s) => {
		if (!s.executionQueue?.some((i) => i.id === itemId)) return s;
		managed = !!s.executionQueue.find((i) => i.id === itemId)?.pendingAdmissionId;
		found = true;
		return {
			...s,
			executionQueue: s.executionQueue.map((i) =>
				i.id === itemId ? { ...i, paused: next(!!i.paused) || undefined } : i
			),
		};
	});
	if (managed)
		void flushSessionPersistenceNow(useSessionStore.getState().sessions).catch((error) =>
			logger.error('[Queue] Failed to persist managed pause', undefined, error)
		);
	return found;
}

/**
 * Fold one queued message into the message above it on the same tab: the queued
 * card's Merge button, and `maestro-cli queue merge`. The rules for what merges
 * and what the result keeps live in `mergeQueuedItemIntoPrevious`.
 *
 * @returns The id of the item it was merged into, or null when the item is gone
 * or cannot be merged (no message above it, or either side is not a plain
 * message). The lookup and the write are one store update, so the item cannot
 * dispatch in between.
 */
export function mergeQueuedItemIntoAbove(sessionId: string, itemId: string): string | null {
	let targetId: string | null = null;
	updateSessionWith(sessionId, (s) => {
		const result = mergeQueuedItemIntoPrevious(s.executionQueue ?? [], itemId);
		if (!result) return s;
		targetId = result.targetId;
		return { ...s, executionQueue: result.queue };
	});
	return targetId;
}

/** Runs one dequeued item. The default goes through `agentStore.processQueuedItem`. */
export type QueuedItemDispatcher = (sessionId: string, item: QueuedItem) => Promise<unknown>;

const dispatchThroughStore: QueuedItemDispatcher = (sessionId, item) => {
	const deps = getDispatchDeps();
	if (!deps) return Promise.reject(new Error('Queue dispatch is not ready yet'));
	return useAgentStore.getState().processQueuedItem(sessionId, item, deps);
};

/**
 * Run one queued item NOW instead of waiting for its turn: the Force Send
 * action. The Execution Queue's Force Send buttons and any service that queues a
 * prompt for a tab it knows is free (Quick Chat) share this, so "safe to send
 * right now" cannot mean two things.
 *
 * A tab runs one turn at a time, so an item whose own tab is mid-turn is left
 * queued. When ANOTHER tab of the agent is mid-turn the item runs alongside it
 * and is stamped `forceParallel`: that badges its chat entry and tells the
 * on-exit dequeue guard this was a deliberate override, not a sequential send.
 *
 * Recovery from a failed dispatch (release the tab, take the card back, re-queue
 * the prompt) is owned by `agentStore.processQueuedItem`, the only place that
 * knows WHY it failed. The rejection is logged here so it has an owner.
 *
 * @returns Whether the item was dispatched. False leaves it in the queue.
 */
export function sendQueuedItemNow(
	sessionId: string,
	itemId: string,
	dispatch: QueuedItemDispatcher = dispatchThroughStore
): boolean {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const item = session?.executionQueue?.find((i) => i.id === itemId);
	if (!session || !item || item.pendingAdmissionId) return false;

	const { targetTabBusy, otherBusyTabs } = getQueueBusyContext(session, item);
	if (targetTabBusy) return false;
	// Without the dispatch deps nothing could run it: leave it for the queue.
	if (dispatch === dispatchThroughStore && !getDispatchDeps()) return false;

	const dispatchItem: QueuedItem =
		otherBusyTabs.length > 0 ? { ...item, forceParallel: true } : item;
	updateSessionWith(sessionId, (s) => applyQueuedItemDispatch(s, dispatchItem));
	dispatch(sessionId, dispatchItem).catch((err) => {
		logger.error('[ForceSend] Dispatch failed, item returned to queue', undefined, err);
	});
	return true;
}

/**
 * The slash command a message IS, when it starts with one of the user's commands
 * (`/commit`, or `/speckit.plan the auth flow` with its arguments). Parsed the
 * way the composer parses a typed command, and searched in the same sets and
 * order `agentStore.processQueuedItem` resolves a command item against, so an
 * item built from a match here always finds its definition at drain time.
 *
 * Null for ordinary text, for a slash word that is none of the user's commands
 * (a provider's own `/compact` stays a message, as typed), and before App has
 * wired the command lists.
 */
export function matchQueuedSlashCommand(session: Session, text: string): QueuedSlashCommand | null {
	const commandText = text.trim();
	if (!commandText.startsWith('/')) return null;
	const deps = getDispatchDeps();
	if (!deps) return null;
	const firstSpace = commandText.indexOf(' ');
	const command = firstSpace === -1 ? commandText : commandText.slice(0, firstSpace);
	const commandArgs = firstSpace === -1 ? '' : commandText.slice(firstSpace + 1).trim();
	const match =
		deps.customAICommands.find((cmd) => cmd.command === command) ??
		deps.speckitCommands.find((cmd) => cmd.command === command) ??
		deps.openspecCommands.find((cmd) => cmd.command === command) ??
		deps.bmadCommands?.find((cmd) => cmd.command === command) ??
		session.agentCommands?.find((cmd) => cmd.command === command && cmd.prompt);
	return match ? { command, commandArgs, description: match.description } : null;
}

/**
 * Everything an edit to a queued message re-derives from its EDITED text, for
 * `applyQueuedItemEdit`. Both edit surfaces (the inline chat list and the
 * Execution Queue browser) call this, so they cannot drift on what an edit does.
 *
 * Both `@mention` flags are re-derived, not just `crossAgentMention`: the edit
 * can add, remove, or move a mention, and where it sits decides whether this
 * agent answers at all. A message edited into one of the user's slash commands
 * becomes that command, with no mention to consult.
 */
export function resolveQueuedItemEdit(
	session: Session,
	patch: QueuedItemEditPatch,
	itemId?: string
): {
	crossAgent: Pick<QueuedItem, 'crossAgentOnly' | 'mentionRouting'> & {
		crossAgentMention: boolean;
	};
	slashCommand?: QueuedSlashCommand;
} {
	const slashCommand = matchQueuedSlashCommand(session, patch.text);
	if (slashCommand) {
		return {
			crossAgent: { crossAgentMention: false, crossAgentOnly: false, mentionRouting: undefined },
			slashCommand,
		};
	}
	// A routing the user PICKED when queuing it survives the edit; the plan
	// drops it only when the edit removes every mention.
	const pickedRouting = itemId
		? session.executionQueue?.find((item) => item.id === itemId)?.mentionRouting
		: undefined;
	const mentionPlan = planCrossAgentMentions(patch.text, session.id, pickedRouting);
	return {
		crossAgent: {
			crossAgentMention: !!mentionPlan,
			crossAgentOnly: mentionPlan?.suppressLocal ?? false,
			mentionRouting: mentionPlan?.routingSource === 'explicit' ? mentionPlan.routing : undefined,
		},
	};
}
