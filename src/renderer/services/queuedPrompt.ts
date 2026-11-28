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

import type { AITab, ModalSaveOutcome, QueuedItem, QueuedItemEditPatch, Session } from '../types';
import { selectSessionById, useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { hostedTargetOf } from './hostedTurns';
import { notifyToast } from '../stores/notificationStore';
import { handQueuedItemToHost } from './hostedQueuedTurn';
import {
	type HostMergeAnswer,
	type HostQueueAnswer,
	HOST_NO_ANSWER_REASON,
	actOnMirroredAgentQuietly,
	editMirrorQueuedItem,
	mergeMirrorQueuedItem,
	moveMirrorQueuedItem,
	removeMirrorQueuedItem,
	sendMirrorQueuedItemNow,
	setMirrorQueuedItemPaused,
} from './peerMirror';
import { useAgentStore } from '../stores/agentStore';
import { getDispatchDeps } from '../stores/retryStore';
import type { QueuedSlashCommand } from '../utils/executionQueue';
import { getActiveTab, getTabDisplayName } from '../utils/tabHelpers';
import {
	applyQueuedItemDispatch,
	applyQueuedItemEdit,
	findQueuedMergeTarget,
	getForceSendEligibility,
	getQueueBusyContext,
	mergeQueuedItemIntoPrevious,
	reorderQueueItem,
} from '../utils/executionQueue';
import { captureQueuedTurnSettings } from '../utils/providerTabSessions';
import { planCrossAgentMentions, queuedMentionFields } from './crossAgentMentions';
import type { QueuedTurnEdit } from '../../shared/maestro-lib/client/types';
import type { MentionRouting } from '../../shared/crossAgentContext';
import { withoutDesignPickPageText } from '../utils/designModePicker';
import { generateId } from '../utils/ids';
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
	/** Resolve a slash command through the command queue when this item drains. */
	slashCommand?: boolean;
	/**
	 * A routing picked for the message's `@mentions` (`dispatch --routing`), the
	 * way the composer's routing strip picks one. Stamped on the item, because the
	 * drain re-plans from the text and the text alone would route it by wording.
	 */
	mentionRouting?: MentionRouting;
	/**
	 * Whether to read `text` for `@mentions`. Default true. Pass false when the
	 * text is not the user's own words (a Design Mode pick holds the page's text
	 * and HTML): the drain fires a stamped mention as a real consult, so a page
	 * that said `@Backend` would otherwise pull that agent in.
	 */
	planMentions?: boolean;
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
 * `agentStore.processQueuedItem` fires it at drain time, and only for an item
 * that carries the flag, so `planMentions: false` leaves a message unable to
 * consult anyone.
 */
export function buildQueuedMessageItem({
	session,
	tab,
	text,
	images,
	slashCommand,
	mentionRouting,
	planMentions = true,
}: QueuedPromptOptions): QueuedItem {
	const commandText = slashCommand ? text.trim() : undefined;
	const firstWhitespace = commandText?.search(/\s/) ?? -1;
	const mentionPlan =
		slashCommand || !planMentions ? null : planCrossAgentMentions(text, session.id, mentionRouting);
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
		turnSettings: captureQueuedTurnSettings(tab, session),
		...queuedMentionFields(mentionPlan),
		...(mentionPlan && { crossAgentOnly: mentionPlan.suppressLocal }),
		// Kept on the item so an edit cannot re-plan what this opted out of.
		...(!planMentions && { mentionsDisabled: true }),
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
	text: string
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
			? session.agentCommands?.find((cmd) => cmd.command === commandText && cmd.prompt)
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
 * A hosted agent's item goes to its host at once (`handQueuedItemToHost()`): its host queues or
 * runs it, and a refusal brings it back here held.
 *
 * @returns The queued item, or null when the agent is gone or has no AI tab.
 */
export function enqueuePromptForTab(
	options: Pick<
		QueuedPromptOptions,
		'text' | 'images' | 'slashCommand' | 'mentionRouting' | 'planMentions'
	> & {
		sessionId: string;
		tabId: string;
		expandCommands?: boolean;
	}
): QueuedItem | null {
	const {
		sessionId,
		tabId,
		text,
		images,
		slashCommand,
		expandCommands,
		mentionRouting,
		planMentions,
	} = options;
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session) return null;

	const tab =
		session.aiTabs?.find((t) => t.id === tabId) ??
		(session.toolType === 'grok' ? undefined : getActiveTab(session));
	if (!tab) return null;

	const command = expandCommands && !slashCommand ? matchSlashCommand(session, text) : null;
	const message = buildQueuedMessageItem({
		session,
		tab,
		text,
		images,
		slashCommand: slashCommand || !!command,
		mentionRouting,
		planMentions,
	});
	const item: QueuedItem = command
		? { ...message, commandDescription: command.description }
		: message;
	updateSessionWith(sessionId, (s) => ({
		...s,
		executionQueue: [...(s.executionQueue || []), item],
	}));
	// A hosted agent's host runs its turns: the item leaves this queue at once and goes there, as
	// the composer's send does. Nothing waits here for a drain that would spawn on this machine.
	handQueuedItemToHost(sessionId, item.id);
	return item;
}

/** The host a queued item waits on, when it is a hosted agent's host queue item (`hostQueued`). */
function hostQueuedItemTarget(
	sessionId: string,
	itemId: string
): { peerId: string; agentId: string; item: QueuedItem; hostQueue: QueuedItem[] } | undefined {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const item = session?.executionQueue?.find((candidate) => candidate.id === itemId);
	if (!item?.hostQueued) return undefined;
	const target = hostedTargetOf(session);
	if (!target) return undefined;
	// The host's own items, in its order: a message can only merge into one the host holds.
	const hostQueue = (session?.executionQueue ?? []).filter((candidate) => candidate.hostQueued);
	return { peerId: target.peerId, agentId: target.agentId, item, hostQueue };
}

type HostQueueTarget = NonNullable<ReturnType<typeof hostQueuedItemTarget>>;

/**
 * A host's answer as a caller that reports the outcome needs it (`maestro-cli queue`, a client's
 * hosted card reaching this desktop). The queued card's own click answers at once and lets the
 * host's queue update redraw it; a script must not be told "done" before the host has spoken. A
 * host that did not answer is an error, not a miss, so the caller gets the reason.
 */
async function settledHostAnswer<T extends HostQueueAnswer | HostMergeAnswer>(
	answer: Promise<T>
): Promise<Exclude<T, null>> {
	const result = await answer;
	if (result === null) throw new Error(HOST_NO_ANSWER_REASON);
	return result as Exclude<T, null>;
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
	// A hosted agent's host queue: the host removes it, and its update takes the card away.
	const hosted = hostQueuedItemTarget(sessionId, itemId);
	if (hosted) {
		void removeMirrorQueuedItem(hosted.peerId, hosted.agentId, itemId);
		return true;
	}
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
 * `removeQueuedItem` for a caller that reports the outcome: a hosted agent's host item resolves
 * with the host's answer instead of at once.
 */
export async function removeQueuedItemSettled(sessionId: string, itemId: string): Promise<boolean> {
	const hosted = hostQueuedItemTarget(sessionId, itemId);
	if (hosted) {
		return settledHostAnswer(removeMirrorQueuedItem(hosted.peerId, hosted.agentId, itemId));
	}
	return removeQueuedItem(sessionId, itemId);
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

/**
 * `setQueuedItemPaused` for a caller that reports the outcome: a hosted agent's host item
 * resolves with the host's answer instead of at once.
 */
export async function setQueuedItemPausedSettled(
	sessionId: string,
	itemId: string,
	paused: boolean
): Promise<boolean> {
	const hosted = hostQueuedItemTarget(sessionId, itemId);
	if (hosted) return settledHostAnswer(pauseOnHost(hosted, itemId, () => paused));
	return setQueuedItemPaused(sessionId, itemId, paused);
}

function pauseOnHost(
	hosted: HostQueueTarget,
	itemId: string,
	next: (current: boolean) => boolean
): Promise<HostQueueAnswer> {
	return setMirrorQueuedItemPaused(
		hosted.peerId,
		hosted.agentId,
		itemId,
		next(hosted.item.paused === true)
	);
}

function writeQueuedItemPaused(
	sessionId: string,
	itemId: string,
	next: (current: boolean) => boolean
): boolean {
	const hosted = hostQueuedItemTarget(sessionId, itemId);
	if (hosted) {
		void pauseOnHost(hosted, itemId, next);
		return true;
	}
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
	// A hosted agent's host queue: the host merges by the same rule, and its update redraws both.
	const hosted = hostQueuedItemTarget(sessionId, itemId);
	if (hosted) {
		const merge = mergeOnHost(hosted, itemId);
		if (!merge) return null;
		void merge.answer;
		return merge.targetId;
	}
	let targetId: string | null = null;
	updateSessionWith(sessionId, (s) => {
		const result = mergeQueuedItemIntoPrevious(s.executionQueue ?? [], itemId);
		if (!result) return s;
		targetId = result.targetId;
		return { ...s, executionQueue: result.queue };
	});
	return targetId;
}

/**
 * `mergeQueuedItemIntoAbove` for a caller that reports the outcome: a hosted agent's host item
 * resolves with the host's answer instead of at once.
 */
export async function mergeQueuedItemIntoAboveSettled(
	sessionId: string,
	itemId: string
): Promise<string | null> {
	const hosted = hostQueuedItemTarget(sessionId, itemId);
	if (!hosted) return mergeQueuedItemIntoAbove(sessionId, itemId);
	const merge = mergeOnHost(hosted, itemId);
	if (!merge) return null;
	// The host names the message it merged into; the one this machine saw above is the fallback.
	const answer = await settledHostAnswer(merge.answer);
	if (typeof answer === 'string') return answer;
	return answer ? merge.targetId : null;
}

/** The host merges by the same rule, so the message it folds into is the one above in its order. */
function mergeOnHost(
	hosted: HostQueueTarget,
	itemId: string
): { targetId: string; answer: Promise<HostMergeAnswer> } | null {
	const above = findQueuedMergeTarget(hosted.hostQueue, itemId);
	if (!above) return null;
	return {
		targetId: above.id,
		answer: mergeMirrorQueuedItem(hosted.peerId, hosted.agentId, itemId),
	};
}

/**
 * Rewrite one queued message in place: the queued card's Edit, the Execution Queue's Edit, and
 * `maestro-cli queue edit`. The mention flags and the slash command are re-derived from the
 * EDITED text (`resolveQueuedItemEdit`): a stale flag consults the wrong agent, and `/commit`
 * left as a message is sent to the provider as literal text.
 *
 * `images` or `turnSettings` absent keeps the item's own (a script that only rewrites the text).
 *
 * @returns Whether the item was in the queue to change. A hosted agent's host item answers
 * `true` at once: the host edits it by the same rule, and its queue update redraws the card.
 */
export function editQueuedItem(sessionId: string, itemId: string, edit: QueuedTurnEdit): boolean {
	const hosted = hostQueuedItemTarget(sessionId, itemId);
	if (hosted) {
		void editOnHost(hosted, itemId, edit);
		return true;
	}
	let found = false;
	updateSessionWith(sessionId, (s) => {
		const item = s.executionQueue?.find((queued) => queued.id === itemId);
		if (!item || item.pendingAdmissionId) return s;
		found = true;
		const patch: QueuedItemEditPatch = {
			text: edit.text,
			images: edit.images ?? item.images ?? [],
			turnSettings: edit.turnSettings ?? item.turnSettings ?? {},
		};
		const { crossAgent, slashCommand } = resolveQueuedItemEdit(s, itemId, patch);
		return {
			...s,
			executionQueue: applyQueuedItemEdit(
				s.executionQueue,
				itemId,
				patch,
				crossAgent,
				slashCommand
			),
		};
	});
	return found;
}

/**
 * `editQueuedItem` for a caller that reports the outcome: a hosted agent's host item resolves
 * with the host's answer instead of at once.
 */
export async function editQueuedItemSettled(
	sessionId: string,
	itemId: string,
	edit: QueuedTurnEdit
): Promise<boolean> {
	const hosted = hostQueuedItemTarget(sessionId, itemId);
	if (hosted) return settledHostAnswer(editOnHost(hosted, itemId, edit));
	return editQueuedItem(sessionId, itemId, edit);
}

function editOnHost(
	hosted: HostQueueTarget,
	itemId: string,
	edit: QueuedTurnEdit
): Promise<HostQueueAnswer> {
	return editMirrorQueuedItem(hosted.peerId, hosted.agentId, itemId, hostQueuedEdit(edit));
}

/**
 * An edit as a host takes it. The mirror holds the host item's images, so the edit's list is the
 * whole list, as it is for a local item: an empty one clears them, and an absent one keeps the
 * host's own.
 */
function hostQueuedEdit(edit: QueuedTurnEdit): QueuedTurnEdit {
	return {
		text: edit.text,
		...(edit.turnSettings ? { turnSettings: edit.turnSettings } : {}),
		...(edit.images ? { images: edit.images } : {}),
	};
}

/** Why an edit that adds images waits: the host's own images for the message are not here yet. */
export const QUEUED_EDIT_IMAGES_PENDING_REASON =
	"This message's images are still loading from its host. Try again in a moment.";

/** An edit that keeps the host's images: it names none. */
function withoutEditImages({ images: _images, ...edit }: QueuedTurnEdit): QueuedTurnEdit {
	return edit;
}

/** Why an edit did not land: the message left the queue (it started, or was removed). */
export const QUEUED_EDIT_GONE_REASON =
	'It no longer waits in the queue: it may have started already.';

/**
 * `editQueuedItem` for the Edit Queued Message modal (the queued card's Edit and the Execution
 * Queue's Edit): it waits for a hosted agent's host and answers with the reason a save did not
 * land, instead of a toast, so the modal can stay open with what the person typed. A local item
 * that left the queue gets the same reason a host gives.
 */
export async function saveQueuedItemEdit(
	sessionId: string,
	itemId: string,
	edit: QueuedTurnEdit
): Promise<ModalSaveOutcome> {
	const hosted = hostQueuedItemTarget(sessionId, itemId);
	if (!hosted) {
		return editQueuedItem(sessionId, itemId, edit)
			? { saved: true }
			: { saved: false, reason: QUEUED_EDIT_GONE_REASON };
	}
	// Its images are on the host but not here yet (M28): the card drew none, so an edit that names
	// none keeps the host's, and one that adds images waits until the host's are here to keep.
	const imagesPending = hosted.item.hostImagesPending === true;
	if (imagesPending && edit.images?.length) {
		return { saved: false, reason: QUEUED_EDIT_IMAGES_PENDING_REASON };
	}
	const hostEdit = hostQueuedEdit(edit);
	const answer = await actOnMirroredAgentQuietly(hosted.peerId, hosted.agentId, {
		kind: 'edit-queued',
		itemId,
		edit: imagesPending ? withoutEditImages(hostEdit) : hostEdit,
	});
	if ('error' in answer) return { saved: false, reason: answer.error };
	if (answer.result.kind !== 'edit-queued') return { saved: false, reason: HOST_NO_ANSWER_REASON };
	return answer.result.found ? { saved: true } : { saved: false, reason: QUEUED_EDIT_GONE_REASON };
}

/**
 * Move one queued item to another place: the queued card's drag, the Execution Queue's drag, and
 * `maestro-cli queue move`. Indices follow `reorderQueueItem`: with `tabId` they address that
 * tab's items as its inline list draws them, without it the agent's whole queue.
 *
 * A hosted agent's host item moves on its host, by the same rule: the target place is read as the
 * host item drawn there, and its queue update redraws the list. Since a hosted agent's turns go
 * to its host as they are queued (`handQueuedItemToHost()`), the only cards this machine holds for
 * one are a send the host refused (held here until Resume sends it again, to the end of the
 * host's line) and a managed admission. Those move among themselves here. A move that crosses
 * between the two lines is refused with a toast, never silently: the host cannot place a message
 * it does not hold, and a held card's place among the host's means nothing once Resume sends it.
 *
 * @returns Whether the move was made (or handed to the host).
 */
export function reorderQueuedItems(
	sessionId: string,
	fromIndex: number,
	toIndex: number,
	tabId?: string
): boolean {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!session) return false;
	const scoped = (session.executionQueue ?? []).filter((item) => !tabId || item.tabId === tabId);
	const moved = scoped[fromIndex];
	const target = scoped[toIndex];
	if (!moved || !target || moved === target) return false;
	const hostMove = moveOnHost(sessionId, moved, target, tabId);
	if (hostMove !== undefined) {
		if (!hostMove) return refuseCrossingMove(session);
		void hostMove;
		return true;
	}
	if (target.hostQueued) return refuseCrossingMove(session);
	let changed = false;
	updateSessionWith(sessionId, (s) => {
		const executionQueue = reorderQueueItem(s.executionQueue, fromIndex, toIndex, tabId);
		if (executionQueue === s.executionQueue) return s;
		changed = true;
		return { ...s, executionQueue };
	});
	return changed;
}

/** Say why a card cannot cross between this machine's held cards and its host's line. */
function refuseCrossingMove(session: Pick<Session, 'liftedTo'>): false {
	const host = hostedTargetOf(session)?.peerId ?? 'its host';
	notifyToast({
		flashWhenToastsOff: true,
		color: 'theme',
		title: 'Cannot move it there',
		message: `A message held on this machine and the messages waiting on ${host} are two lines. Resume a held message to send it to the end of the host's line.`,
	});
	return false;
}

/**
 * Move one queued item, named by id, to `toIndex`: the form `maestro-cli queue move` and a
 * client's hosted card reach this desktop with. Same rule as the drag (`reorderQueuedItems`).
 */
export function moveQueuedItem(
	sessionId: string,
	itemId: string,
	toIndex: number,
	tabId?: string
): boolean {
	const fromIndex = queuedItemIndex(sessionId, itemId, tabId);
	if (fromIndex === -1) return false;
	// Already there: nothing to do, and nothing failed.
	if (fromIndex === toIndex) return true;
	return reorderQueuedItems(sessionId, fromIndex, toIndex, tabId);
}

/**
 * `moveQueuedItem` for a caller that reports the outcome: a hosted agent's host item resolves
 * with the host's answer instead of at once.
 */
export async function moveQueuedItemSettled(
	sessionId: string,
	itemId: string,
	toIndex: number,
	tabId?: string
): Promise<boolean> {
	const fromIndex = queuedItemIndex(sessionId, itemId, tabId);
	if (fromIndex === -1) return false;
	if (fromIndex === toIndex) return true;
	const scoped = scopedQueue(sessionId, tabId);
	const hostMove = moveOnHost(sessionId, scoped[fromIndex], scoped[toIndex], tabId);
	if (hostMove === undefined) return reorderQueuedItems(sessionId, fromIndex, toIndex, tabId);
	return hostMove ? settledHostAnswer(hostMove) : false;
}

/** The agent's queue as `reorderQueuedItems` indexes it: that tab's items with `tabId`. */
function scopedQueue(sessionId: string, tabId?: string): QueuedItem[] {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	return (session?.executionQueue ?? []).filter((item) => !tabId || item.tabId === tabId);
}

function queuedItemIndex(sessionId: string, itemId: string, tabId?: string): number {
	return scopedQueue(sessionId, tabId).findIndex((item) => item.id === itemId);
}

/**
 * Move a hosted agent's host item on its host. Undefined when `moved` is not a host item (the
 * move is local); false when the host cannot place it there (the target is not one the host
 * holds); otherwise the host's answer. The target place is read as the host item drawn there.
 */
function moveOnHost(
	sessionId: string,
	moved: QueuedItem | undefined,
	target: QueuedItem | undefined,
	tabId?: string
): Promise<HostQueueAnswer> | false | undefined {
	if (!moved) return undefined;
	const hosted = hostQueuedItemTarget(sessionId, moved.id);
	if (!hosted) return undefined;
	if (!target?.hostQueued) return false;
	const hostScoped = hosted.hostQueue.filter((item) => !tabId || item.tabId === tabId);
	const hostToIndex = hostScoped.findIndex((item) => item.id === target.id);
	if (hostToIndex === -1) return false;
	return moveMirrorQueuedItem(hosted.peerId, hosted.agentId, moved.id, hostToIndex, tabId);
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
	// A hosted agent's host item runs on its host, which applies this same rule to its own tabs.
	const hosted = hostQueuedItemTarget(sessionId, itemId);
	if (hosted) {
		void sendMirrorQueuedItemNow(hosted.peerId, hosted.agentId, itemId);
		return true;
	}
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
 * `sendQueuedItemNow` for a caller with no Force Send button (`maestro-cli queue send-now`, a
 * client's hosted card reaching this desktop). It applies the rule the button does: beside
 * another tab's turn it runs only when Forced Parallel Execution is on, which `sendQueuedItemNow`
 * leaves to its callers (the button is not offered, and Quick Chat only sends to a free agent).
 * A hosted agent's host item resolves with the host's answer instead of at once; the host applies
 * the same rule with its own setting.
 */
export async function sendQueuedItemNowSettled(
	sessionId: string,
	itemId: string
): Promise<boolean> {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const item = session?.executionQueue?.find((i) => i.id === itemId);
	if (!session || !item) return false;
	const eligibility = getForceSendEligibility(session, item, {
		forcedParallelEnabled: useSettingsStore.getState().forcedParallelExecution,
	});
	if (!eligibility.canForce) return false;
	const hosted = hostQueuedItemTarget(sessionId, itemId);
	if (hosted) {
		return settledHostAnswer(sendMirrorQueuedItemNow(hosted.peerId, hosted.agentId, itemId));
	}
	return sendQueuedItemNow(sessionId, itemId);
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
	// Split at the first whitespace of any kind, as `buildQueuedMessageItem` does.
	const firstWhitespace = commandText.search(/\s/);
	const command = firstWhitespace === -1 ? commandText : commandText.slice(0, firstWhitespace);
	const commandArgs = firstWhitespace === -1 ? '' : commandText.slice(firstWhitespace + 1).trim();
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
 *
 * The mentions are resolved without the page text of the Design Mode chips the
 * item's send expanded in (`QueuedItem.designPickPageText`), as the drain resolves
 * them, and an item queued with `planMentions: false` (`mentionsDisabled`)
 * gets none at all, so an edit cannot turn page content into a consult.
 */
export function resolveQueuedItemEdit(
	session: Session,
	itemId: string,
	patch: QueuedItemEditPatch
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
	const item = session.executionQueue?.find((queued) => queued.id === itemId);
	if (item?.mentionsDisabled) {
		return {
			crossAgent: { crossAgentMention: false, crossAgentOnly: false, mentionRouting: undefined },
		};
	}
	// A routing the user PICKED when queuing it survives the edit; the plan
	// drops it only when the edit removes every mention.
	const mentionPlan = planCrossAgentMentions(
		withoutDesignPickPageText(patch.text, item?.designPickPageText),
		session.id,
		item?.mentionRouting
	);
	return {
		crossAgent: {
			crossAgentMention: !!mentionPlan,
			crossAgentOnly: mentionPlan?.suppressLocal ?? false,
			mentionRouting: mentionPlan?.routingSource === 'explicit' ? mentionPlan.routing : undefined,
		},
	};
}
