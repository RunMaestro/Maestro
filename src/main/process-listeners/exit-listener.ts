/**
 * Process exit listener.
 * Handles process exit events, including group chat moderator/participant exits.
 * This is the largest and most complex listener with routing, recovery, and synthesis logic.
 */

import type { ProcessManager } from '../process-manager';
import type { ProcessManagerEvents } from '../process-manager/types';
import { cueStatusForTurn } from '../cue/cue-turn-status';
import { captureException } from '../utils/sentry';
import { GROUP_CHAT_PREFIX, type ProcessListenerDependencies } from './types';
import { extractCopilotUsageFromDisk } from '../group-chat/copilot-usage-extractor';

type ExitEventArgs = Parameters<ProcessManagerEvents['exit']>;

// The predicate moved into the library with the progression that uses it; re-exported
// so this module keeps its public surface.
export { isDeletedGroupChatFailure } from '../../shared/maestro-lib/groupchat/router';

/**
 * Sets up the exit listener for process termination.
 * Handles:
 * - Power management cleanup
 * - Group chat moderator and participant exits: read the buffered output and report the
 *   finished turn to the group chat engine, which routes it, recovers a lost session,
 *   and starts the synthesis
 * - Regular process exit forwarding
 * - Web broadcast of exit events
 */
export function setupExitListener(
	processManager: ProcessManager,
	deps: Pick<
		ProcessListenerDependencies,
		| 'safeSend'
		| 'getProcessManager'
		| 'getAgentDetector'
		| 'getWebServer'
		| 'powerManager'
		| 'outputBuffer'
		| 'outputParser'
		| 'groupChatEmitters'
		| 'groupChatEngine'
		| 'groupChatLauncherFor'
		| 'groupChatStorage'
		| 'debugLog'
		| 'logger'
		| 'patterns'
		| 'getCueEngine'
		| 'isCueEnabled'
		| 'getSshRemoteByName'
		| 'getAgentContextWindow'
	>
): void {
	const {
		safeSend,
		getProcessManager,
		getAgentDetector,
		getWebServer,
		powerManager,
		outputBuffer,
		outputParser,
		groupChatEmitters,
		groupChatEngine,
		groupChatLauncherFor,
		groupChatStorage,
		debugLog,
		logger,
		patterns,
		getCueEngine,
		isCueEnabled,
		getSshRemoteByName,
		getAgentContextWindow,
	} = deps;
	const { REGEX_MODERATOR_SESSION } = patterns;

	async function refreshCopilotUsageAfterExit(
		groupChatId: string,
		participantName: string
	): Promise<void> {
		try {
			const chat = await groupChatStorage.loadGroupChat(groupChatId);
			const participant = chat?.participants.find((p) => p.name === participantName);
			if (!participant || participant.agentId !== 'copilot-cli') return;
			if (!participant.agentSessionId) return;

			const sshRemote = participant.sshRemoteName
				? (getSshRemoteByName?.(participant.sshRemoteName) ?? null)
				: null;
			const contextWindow = getAgentContextWindow?.(participant.agentId) ?? 0;
			if (!contextWindow) return;

			const usage = await extractCopilotUsageFromDisk(
				participant.agentSessionId,
				contextWindow,
				sshRemote
			);
			if (!usage) return;

			const updated = await groupChatStorage.updateParticipant(groupChatId, participantName, {
				contextUsage: usage.contextUsage,
				tokenCount: usage.tokenCount,
			});
			groupChatEmitters.emitParticipantsChanged?.(groupChatId, updated.participants);
		} catch (err) {
			logger.warn('[GroupChat] Failed to refresh copilot usage from disk', 'ProcessListener', {
				error: String(err),
				groupChatId,
				participantName,
			});
		}
	}

	/**
	 * Reports a finished group chat turn to the engine.
	 *
	 * The desktop's half of the turn is reading the process's buffered output; what the
	 * output means, and what happens next, is the engine's. The text is read lazily
	 * because which parser applies depends on the agent, which only the engine's chat
	 * load knows. The exit code travels for logs only: a turn that returned text has
	 * responded whatever the code was.
	 *
	 * The buffer is released once the engine has finished with the turn, never before:
	 * recovery and routing both read what it holds.
	 */
	function reportGroupChatTurn(sessionId: string, code: number): void {
		const bufferedOutput = outputBuffer.getGroupChatBufferedOutput(sessionId) ?? '';
		debugLog('GroupChat:Debug', ` Buffered output length: ${bufferedOutput.length}`);

		groupChatEngine
			.turnEnded(
				{
					processId: sessionId,
					rawOutput: bufferedOutput,
					readText: (agentType) =>
						bufferedOutput ? outputParser.extractTextFromStreamJson(bufferedOutput, agentType) : '',
					exitCode: code,
				},
				groupChatLauncherFor(getProcessManager(), getAgentDetector())
			)
			.catch((err: unknown) => {
				// The engine handles its own failures; this is the last line of defense
				// against an unhandled rejection from the report itself.
				debugLog('GroupChat:Debug', ` ERROR reporting group chat turn:`, err);
				logger.error('[GroupChat] Failed to report group chat turn', 'ProcessListener', {
					error: String(err),
					sessionId,
				});
				void captureException(err, { operation: 'groupChat:turnEnded', sessionId });
			})
			.finally(() => {
				outputBuffer.clearGroupChatBuffer(sessionId);
				debugLog('GroupChat:Debug', ` Cleared output buffer for session`);
			});
	}

	processManager.on('exit', (...[sessionId, code, signal, settlement]: ExitEventArgs) => {
		// Remove power block reason for this session
		// This allows system sleep when no AI sessions are active
		powerManager.removeBlockReason(`session:${sessionId}`);

		// Fast path: skip regex for non-group-chat sessions (performance optimization)
		// Most sessions don't start with 'group-chat-', so this avoids expensive regex matching
		const isGroupChatSession = sessionId.startsWith(GROUP_CHAT_PREFIX);

		// Handle group chat moderator exit.
		// Session ID format: group-chat-{groupChatId}-moderator-{uuid}
		// This handles BOTH initial moderator responses AND synthesis responses; the
		// engine decides what the text means (@mentions route to agents, no @mentions is
		// the final answer).
		const moderatorMatch = isGroupChatSession ? sessionId.match(REGEX_MODERATOR_SESSION) : null;
		if (moderatorMatch) {
			const groupChatId = moderatorMatch[1];
			debugLog('GroupChat:Debug', ` ========== MODERATOR PROCESS EXIT ==========`);
			debugLog('GroupChat:Debug', ` Group Chat ID: ${groupChatId}`);
			debugLog('GroupChat:Debug', ` Session ID: ${sessionId}`);
			debugLog('GroupChat:Debug', ` Exit code: ${code}`);

			reportGroupChatTurn(sessionId, code);
			debugLog('GroupChat:Debug', ` =============================================`);
			// Don't send to regular exit handler
			return;
		}

		// Handle group chat participant exit.
		// Session ID format: group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
		// Only parse if it's a group chat session (performance optimization)
		const participantExitInfo = isGroupChatSession
			? outputParser.parseParticipantSessionId(sessionId)
			: null;
		if (participantExitInfo) {
			const { groupChatId, participantName } = participantExitInfo;
			debugLog('GroupChat:Debug', ` ========== PARTICIPANT PROCESS EXIT ==========`);
			debugLog('GroupChat:Debug', ` Group Chat ID: ${groupChatId}`);
			debugLog('GroupChat:Debug', ` Participant: ${participantName}`);
			debugLog('GroupChat:Debug', ` Session ID: ${sessionId}`);
			debugLog('GroupChat:Debug', ` Exit code: ${code}`);

			// Refresh on-disk usage for copilot-cli participants. Copilot in batch
			// mode only writes the session.shutdown event (the sole carrier of
			// per-turn token counts) to events.jsonl on disk - it never appears
			// on stdout, so the streaming usage path can't see it. Without this,
			// the participant's context gauge stays at 0% forever.
			void refreshCopilotUsageAfterExit(groupChatId, participantName);

			reportGroupChatTurn(sessionId, code);
			debugLog('GroupChat:Debug', ` ===============================================`);
			// Don't send to regular exit handler
			return;
		}

		// CRITICAL: group-chat domain containment. If we got here with a sessionId
		// that starts with GROUP_CHAT_PREFIX, it means neither the moderator
		// branch nor the participant branch recognized it (they both `return`
		// after handling). Dropping here prevents group-chat exits from leaking
		// into:
		//   - the regular renderer channel via process:exit
		//   - the web broadcast path (which would misroute to session clients)
		//   - Cue's agent.completed subscriptions (which would fire spuriously
		//     on every group-chat turn, since group-chat agents are driven by
		//     the router, not the user's pipeline)
		// We do not rely on early-return ordering of the branches above - this
		// guard is load-bearing and must stay here.
		if (isGroupChatSession) {
			logger.warn(
				'[GroupChat] Dropping unrecognized group-chat session exit (containment guard)',
				'ProcessListener',
				{ sessionId, exitCode: code }
			);
			return;
		}

		// Diagnostic: log terminal PTY exits at the source (the ground truth for the
		// "terminal tabs vanish" reports). A non-zero code on a remote terminal that
		// the user didn't `exit` is the signature of a dropped SSH transport; a set
		// `signal` means the shell was killed rather than exited. Pairs with the
		// renderer-side 'Terminal PTY exited' / 'Closing terminal tab' logs.
		if (sessionId.includes('-terminal-')) {
			logger.info('Terminal PTY process exited', 'ProcessListener', {
				sessionId,
				exitCode: code,
				signal,
			});
		}

		safeSend('process:exit', sessionId, code, signal);

		// Broadcast exit to web clients
		const webServer = getWebServer();
		if (webServer) {
			// Extract base session ID from formats: {id}-ai-{tabId}, {id}-terminal, {id}-batch-{timestamp}, {id}-synopsis-{timestamp}
			const baseSessionId = sessionId.replace(/-ai-.+$|-terminal$|-batch-\d+$|-synopsis-\d+$/, '');
			webServer.broadcastToSessionClients(baseSessionId, {
				type: 'session_exit',
				sessionId: baseSessionId,
				exitCode: code,
				timestamp: Date.now(),
			});
		}

		// Notify Cue engine that this agent session has completed.
		// This triggers agent.completed subscriptions for completion chains.
		// Desktop completions use the same rule as Cue's own runs, and the
		// exit-code test is only a fallback for exits that carry no settlement.
		if (isCueEnabled?.() && getCueEngine) {
			const cueEngine = getCueEngine();
			if (cueEngine?.hasCompletionSubscribers(sessionId)) {
				cueEngine.notifyAgentCompleted(sessionId, {
					status: settlement
						? cueStatusForTurn({
								outcome: settlement.outcome,
								exitCode: code,
								answerCaptured: settlement.answerCaptured,
								killedBySignal: signal != null,
							})
						: code === 0
							? 'completed'
							: 'failed',
					exitCode: code,
				});
			}
		}
	});
}
