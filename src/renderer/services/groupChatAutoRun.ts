/**
 * Start the Auto Run a group chat moderator's `!autorun @Agent` asked for.
 *
 * Main emits `groupChat:autoRunTriggered` and then waits for
 * `groupChat:reportAutoRunComplete` before the synthesis round. This module is
 * the renderer half: it finds the participant's agent, lists its Auto Run
 * documents where the agent's files live, and starts the run through the same
 * `startBatchRun` every other launcher uses, so a local, an SSH and a hosted
 * agent all start the same way (a hosted agent's run goes to its host inside
 * `startBatchRun`).
 *
 * Completion goes back to the chat on one of two paths, picked by who drives
 * the run, never by the agent's mode:
 * - A run this window drives ends in the batch processor's `onComplete`, which
 *   consumes the registry entry and reports the summary (useBatchHandlers).
 * - A run another process drives (a hosted agent's run on its host) is only a
 *   mirror here, and its end is that mirror going away. `watchMirroredRunEnd`
 *   reports it from the last figures the mirror showed.
 *
 * A run that cannot start is reported to the chat at once, so the moderator
 * learns why instead of waiting for the participant timeout.
 */

import type { BatchRunConfig, BatchRunState, Session } from '../types';
import { findSessionForParticipantName } from '../../shared/group-chat-types';
import { groupChatAutoRunSummary } from '../../shared/maestro-lib/groupchat/autorun-summary';
import { useSessionStore } from '../stores/sessionStore';
import { useBatchStore } from '../stores/batchStore';
import { useSettingsStore } from '../stores/settingsStore';
import { hostedTargetOf } from './hostedTurns';
import { getSessionSshRemoteId } from '../utils/sessionHelpers';
import { resolveGroupChatAutoRunTarget } from '../utils/groupChatAutoRun';
import {
	consumeGroupChatAutoRun,
	hasGroupChatAutoRun,
	registerGroupChatAutoRun,
} from '../utils/groupChatAutoRunRegistry';
import { DEFAULT_BATCH_PROMPT } from '../hooks/batch/batchUtils';
import { generateId } from '../utils/ids';
import { ipcErrorMessage } from '../../shared/serializeError';
import { logger } from '../utils/logger';

export type GroupChatStartBatchRun = (
	sessionId: string,
	config: BatchRunConfig,
	folderPath: string
) => Promise<void> | void;

export interface GroupChatAutoRunTrigger {
	groupChatId: string;
	participantName: string;
	/** A single document the directive named (`!autorun @Agent:plan.md`). */
	targetFilename?: string;
	/** The participant's agent (`Session.id`), when main resolved it. */
	agentId?: string;
}

/** The reply a chat logs when the run never started. */
export function groupChatAutoRunFailure(participantName: string, reason: string): string {
	return `⚠️ Auto Run could not start for @${participantName}: ${reason}`;
}

function report(trigger: GroupChatAutoRunTrigger, summary: string): Promise<void> {
	return window.maestro.groupChat
		.reportAutoRunComplete(trigger.groupChatId, trigger.participantName, summary)
		.then(() => undefined)
		.catch((err: unknown) => {
			logger.error('[GroupChat:AutoRun] Failed to report to the group chat:', undefined, err);
		});
}

/**
 * The participant's agent: by id when main sent one, else by name as the router
 * matches it. An id that matches no agent is NOT retried by name: a linked
 * participant whose agent is gone must never resolve to another agent that
 * happens to carry the same name (`findParticipantSourceAgent`).
 */
function resolveParticipantAgent(trigger: GroupChatAutoRunTrigger): Session | undefined {
	const sessions = useSessionStore.getState().sessions;
	if (trigger.agentId) return sessions.find((session) => session.id === trigger.agentId);
	return findSessionForParticipantName(trigger.participantName, sessions);
}

/**
 * Report a mirrored run's end. Watches the batch store from before the launch,
 * so a run that ends at once is still seen. Stops watching when the entry is
 * consumed elsewhere (the batch processor's own completion, a failed start).
 */
function watchMirroredRunEnd(sessionId: string, trigger: GroupChatAutoRunTrigger): () => void {
	let lastMirror: BatchRunState | undefined;
	const unsubscribe = useBatchStore.subscribe((state) => {
		if (!hasGroupChatAutoRun(sessionId)) {
			unsubscribe();
			return;
		}
		const current = state.batchRunStates[sessionId];
		if (current?.mirrored === true && current.isRunning) {
			lastMirror = current;
			return;
		}
		if (!lastMirror) return; // the mirror has not appeared yet
		unsubscribe();
		if (!consumeGroupChatAutoRun(sessionId)) return;
		void report(
			trigger,
			groupChatAutoRunSummary({
				wasStopped: lastMirror.isStopping === true,
				completedTasks: lastMirror.completedTasksAcrossAllDocs || lastMirror.completedTasks,
				totalTasks: lastMirror.totalTasksAcrossAllDocs || lastMirror.totalTasks,
				documentsProcessed: lastMirror.documents?.length ?? 0,
			})
		);
	});
	return unsubscribe;
}

/**
 * Start the participant's Auto Run, or tell the chat why it could not start.
 * Resolves once the run has been handed to `startBatchRun` (or refused).
 */
export async function startGroupChatAutoRun(
	trigger: GroupChatAutoRunTrigger,
	startBatchRun: GroupChatStartBatchRun
): Promise<void> {
	const fail = (reason: string) => {
		logger.warn(`[GroupChat:AutoRun] ${reason}`);
		return report(trigger, groupChatAutoRunFailure(trigger.participantName, reason));
	};

	const session = resolveParticipantAgent(trigger);
	if (!session) {
		await fail(
			`No Maestro agent named "${trigger.participantName}" found. Make sure the agent exists and is open.`
		);
		return;
	}
	// Refusals `startBatchRun` would make, made here so the chat hears the reason.
	// One registry entry per agent: a second request must not take over the
	// completion the first one is waiting for.
	if (
		hasGroupChatAutoRun(session.id) ||
		useBatchStore.getState().batchRunStates[session.id]?.isRunning
	) {
		await fail(
			`Agent "${session.name}" is already running an Auto Run. Ask again when that run ends.`
		);
		return;
	}
	if (useSettingsStore.getState().autoRunDisabled) {
		await fail('Auto Run is turned off in this Maestro (Settings).');
		return;
	}
	const folderPath = session.autoRunFolderPath;
	if (!folderPath) {
		await fail(
			`Agent "${session.name}" has no Auto Run folder configured. Open the agent, go to the Auto Run tab, and configure a folder first.`
		);
		return;
	}

	let allFiles: string[];
	try {
		// The folder is listed where the agent's files are, as the Auto Run panel lists it.
		const listing = await window.maestro.autorun.listDocs(
			folderPath,
			getSessionSshRemoteId(session)
		);
		if (!listing.success) {
			await fail(`Failed to read the Auto Run folder: ${listing.error || 'unknown error'}`);
			return;
		}
		allFiles = listing.files || [];
	} catch (err) {
		await fail(`Failed to read the Auto Run folder: ${ipcErrorMessage(err)}`);
		return;
	}
	if (allFiles.length === 0) {
		await fail(
			`No Auto Run documents found in "${folderPath}". Create a document in the Auto Run tab first.`
		);
		return;
	}
	const target = resolveGroupChatAutoRunTarget(allFiles, trigger.targetFilename);
	if ('error' in target) {
		await fail(`${target.error} in "${folderPath}" for "${session.name}".`);
		return;
	}

	const config: BatchRunConfig = {
		documents: target.files.map((filename) => ({
			id: generateId(),
			filename,
			resetOnCompletion: false,
			isDuplicate: false,
		})),
		prompt: DEFAULT_BATCH_PROMPT,
		loopEnabled: false,
		maxLoops: null,
	};

	// Register before the launch: a run can end before startBatchRun returns.
	registerGroupChatAutoRun(session.id, trigger.groupChatId, trigger.participantName);
	const stopWatching = watchMirroredRunEnd(session.id, trigger);
	try {
		await startBatchRun(session.id, config, folderPath);
	} catch (err) {
		stopWatching();
		if (consumeGroupChatAutoRun(session.id)) {
			await fail(ipcErrorMessage(err));
		}
		return;
	}
	// A run this window drives is awaited to its end, so its completion has
	// already consumed the entry. One still waiting, with no run on screen, was
	// declined by `startBatchRun` (which showed the reason in a notice). A run a
	// host drives resolves when the host takes it, and its mirror ends it later.
	if (
		hasGroupChatAutoRun(session.id) &&
		!useBatchStore.getState().batchRunStates[session.id]?.isRunning &&
		!hostedTargetOf(session)
	) {
		stopWatching();
		consumeGroupChatAutoRun(session.id);
		await fail('Maestro declined to start the run. Its notice says why.');
	}
}
