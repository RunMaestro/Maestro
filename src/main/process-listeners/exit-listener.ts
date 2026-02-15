/**
 * Process exit listener.
 * Handles process exit events, including group chat moderator/participant exits.
 * This is the largest and most complex listener with routing, recovery, and synthesis logic.
 */

import type { ProcessManager } from '../process-manager';
import { GROUP_CHAT_PREFIX, type ProcessListenerDependencies } from './types';

/**
 * Sets up the exit listener for process termination.
 * Handles:
 * - Power management cleanup
 * - Group chat moderator exit (routing buffered output)
 * - Group chat participant exit (routing, recovery, synthesis triggering)
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
		| 'groupChatRouter'
		| 'groupChatStorage'
		| 'sessionRecovery'
		| 'debugLog'
		| 'logger'
		| 'patterns'
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
		groupChatRouter,
		groupChatStorage,
		sessionRecovery,
		debugLog,
		logger,
		patterns,
	} = deps;
	const { REGEX_MODERATOR_SESSION } = patterns;

	processManager.on('exit', (sessionId: string, code: number) => {
		// Remove power block reason for this session
		// This allows system sleep when no AI sessions are active
		powerManager.removeBlockReason(`session:${sessionId}`);

		// Fast path: skip regex for non-group-chat sessions (performance optimization)
		// Most sessions don't start with 'group-chat-', so this avoids expensive regex matching
		const isGroupChatSession = sessionId.startsWith(GROUP_CHAT_PREFIX);

		// Handle group chat moderator exit - route buffered output and set state back to idle
		// Session ID format: group-chat-{groupChatId}-moderator-{uuid}
		// This handles BOTH initial moderator responses AND synthesis responses.
		// The routeModeratorResponse function will check for @mentions:
		// - If @mentions present: route to agents (continue conversation)
		// - If no @mentions: final response to user (conversation complete for this turn)
		const moderatorMatch = isGroupChatSession ? sessionId.match(REGEX_MODERATOR_SESSION) : null;
		if (moderatorMatch) {
			const groupChatId = moderatorMatch[1];
			debugLog('GroupChat:Debug', ` ========== MODERATOR PROCESS EXIT ==========`);
			debugLog('GroupChat:Debug', ` Group Chat ID: ${groupChatId}`);
			debugLog('GroupChat:Debug', ` Session ID: ${sessionId}`);
			debugLog('GroupChat:Debug', ` Exit code: ${code}`);
			logger.debug(`[GroupChat] Moderator exit: groupChatId=${groupChatId}`, 'ProcessListener', {
				sessionId,
			});
			// Route the buffered output now that process is complete
			const bufferedOutput = outputBuffer.getGroupChatBufferedOutput(sessionId);
			debugLog('GroupChat:Debug', ` Buffered output length: ${bufferedOutput?.length ?? 0}`);
			if (bufferedOutput) {
				debugLog(
					'GroupChat:Debug',
					` Raw buffered output preview: "${bufferedOutput.substring(0, 300)}${bufferedOutput.length > 300 ? '...' : ''}"`
				);
				logger.debug(
					`[GroupChat] Moderator has buffered output (${bufferedOutput.length} chars)`,
					'ProcessListener',
					{ groupChatId }
				);
				void (async () => {
					// Helper to load chat with retry for transient failures
					const loadChatWithRetry = async () => {
						try {
							return await groupChatStorage.loadGroupChat(groupChatId);
						} catch (firstErr) {
							debugLog('GroupChat:Debug', ` First chat load failed, retrying after 100ms...`);
							logger.warn(
								'[GroupChat] Chat load failed, retrying once',
								'ProcessListener',
								{ error: String(firstErr), groupChatId }
							);
							// Wait 100ms and retry once for transient I/O issues
							await new Promise((resolve) => setTimeout(resolve, 100));
							return await groupChatStorage.loadGroupChat(groupChatId);
						}
					};

					try {
						const chat = await loadChatWithRetry();
						debugLog('GroupChat:Debug', ` Chat loaded for parsing: ${chat?.name || 'null'}`);
						const agentType = chat?.moderatorAgentId;
						debugLog('GroupChat:Debug', ` Agent type for parsing: ${agentType}`);
						const parsedText = outputParser.extractTextFromStreamJson(bufferedOutput, agentType);
						debugLog('GroupChat:Debug', ` Parsed text length: ${parsedText.length}`);
						debugLog(
							'GroupChat:Debug',
							` Parsed text preview: "${parsedText.substring(0, 300)}${parsedText.length > 300 ? '...' : ''}"`
						);
						if (parsedText.trim()) {
							debugLog('GroupChat:Debug', ` Routing moderator response...`);
							logger.info(
								`[GroupChat] Routing moderator response (${parsedText.length} chars)`,
								'ProcessListener',
								{ groupChatId }
							);
							const readOnly = groupChatRouter.getGroupChatReadOnlyState(groupChatId);
							debugLog('GroupChat:Debug', ` Read-only state: ${readOnly}`);
							const pm = getProcessManager();
							const ad = getAgentDetector();
							groupChatRouter
								.routeModeratorResponse(
									groupChatId,
									parsedText,
									pm ?? undefined,
									ad ?? undefined,
									readOnly
								)
								.catch((err) => {
									debugLog('GroupChat:Debug', ` ERROR routing moderator response:`, err);
									logger.error(
										'[GroupChat] Failed to route moderator response',
										'ProcessListener',
										{ error: String(err) }
									);
								});
						} else {
							debugLog('GroupChat:Debug', ` WARNING: Parsed text is empty!`);
							logger.warn(
								'[GroupChat] Moderator output parsed to empty string',
								'ProcessListener',
								{ groupChatId, bufferedLength: bufferedOutput.length }
							);
						}
					} catch (err) {
						debugLog('GroupChat:Debug', ` ERROR loading chat after retry:`, err);
						// Log what we would have tried to route for debugging
						const parsedTextForLog = outputParser.extractTextFromStreamJson(bufferedOutput);
						logger.error(
							'[GroupChat] Failed to load chat for moderator output parsing after retry',
							'ProcessListener',
							{
								error: String(err),
								groupChatId,
								bufferedLength: bufferedOutput.length,
								parsedTextPreview: parsedTextForLog.substring(0, 500),
								parsedTextLength: parsedTextForLog.length,
							}
						);
						// Do NOT attempt to route the response if chat load still fails after retry
						// The failure indicates a persistent issue that should be investigated.
					}
				})().finally(() => {
					outputBuffer.clearGroupChatBuffer(sessionId);
					debugLog('GroupChat:Debug', ` Cleared output buffer for session`);
				});
			} else {
				debugLog('GroupChat:Debug', ` WARNING: No buffered output!`);
				logger.warn('[GroupChat] Moderator exit with no buffered output', 'ProcessListener', {
					groupChatId,
					sessionId,
				});
			}
			groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
			debugLog('GroupChat:Debug', ` Emitted state change: idle`);
			debugLog('GroupChat:Debug', ` =============================================`);
			// Don't send to regular exit handler
			return;
		}

		// Handle group chat participant exit - route buffered output and update participant state
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
			logger.debug(
				`[GroupChat] Participant exit: ${participantName} (groupChatId=${groupChatId})`,
				'ProcessListener',
				{ sessionId }
			);

			// Emit participant state change to show this participant is done working
			groupChatEmitters.emitParticipantState?.(groupChatId, participantName, 'idle');
			debugLog('GroupChat:Debug', ` Emitted participant state: idle`);

			// Route the buffered output now that process is complete
			// IMPORTANT: We must wait for the response to be logged before triggering synthesis
			// to avoid a race condition where synthesis reads the log before the response is written
			const bufferedOutput = outputBuffer.getGroupChatBufferedOutput(sessionId);
			debugLog('GroupChat:Debug', ` Buffered output length: ${bufferedOutput?.length ?? 0}`);

			// Helper function to mark participant and potentially trigger synthesis
			const markAndMaybeSynthesize = () => {
				const isLastParticipant = groupChatRouter.markParticipantResponded(
					groupChatId,
					participantName
				);
				debugLog('GroupChat:Debug', ` Is last participant to respond: ${isLastParticipant}`);
				const pm = getProcessManager();
				const ad = getAgentDetector();
				if (isLastParticipant && pm && ad) {
					// All participants have responded - spawn moderator synthesis round
					debugLog('GroupChat:Debug', ` All participants responded - spawning synthesis round...`);
					logger.info(
						'[GroupChat] All participants responded, spawning moderator synthesis',
						'ProcessListener',
						{ groupChatId }
					);
					groupChatRouter.spawnModeratorSynthesis(groupChatId, pm, ad).catch((err) => {
						debugLog('GroupChat:Debug', ` ERROR spawning synthesis:`, err);
						logger.error('[GroupChat] Failed to spawn moderator synthesis', 'ProcessListener', {
							error: String(err),
							groupChatId,
						});
					});
				} else if (!isLastParticipant) {
					// More participants pending
					debugLog('GroupChat:Debug', ` Waiting for more participants to respond...`);
				}
			};

			if (bufferedOutput) {
				debugLog(
					'GroupChat:Debug',
					` Raw buffered output preview: "${bufferedOutput.substring(0, 300)}${bufferedOutput.length > 300 ? '...' : ''}"`
				);

				// Handle session recovery and normal processing in an async IIFE
				void (async () => {
					// Check if this is a session_not_found error - if so, recover and retry
					// But don't attempt recovery if this IS already a recovery session (prevent infinite loops)
					const isRecoverySession = sessionId.includes('-recovery-');
					const chat = await groupChatStorage.loadGroupChat(groupChatId);
					const agentType = chat?.participants.find((p) => p.name === participantName)?.agentId;

					if (
						!isRecoverySession &&
						sessionRecovery.needsSessionRecovery(bufferedOutput, agentType)
					) {
						debugLog(
							'GroupChat:Debug',
							` Session not found error detected for ${participantName} - initiating recovery`
						);
						logger.info('[GroupChat] Session recovery needed', 'ProcessListener', {
							groupChatId,
							participantName,
						});

						// Clear the buffer first
						outputBuffer.clearGroupChatBuffer(sessionId);

						// Initiate recovery (clears agentSessionId)
						await sessionRecovery.initiateSessionRecovery(groupChatId, participantName);

						// Re-spawn the participant with recovery context
						const pm = getProcessManager();
						const ad = getAgentDetector();
						if (pm && ad) {
							debugLog(
								'GroupChat:Debug',
								` Re-spawning ${participantName} with recovery context...`
							);
							// Notify UI that recovery is in progress
							groupChatEmitters.emitMessage?.(groupChatId, {
								timestamp: new Date().toISOString(),
								from: 'system',
								content: `Session expired for ${participantName}. Creating a new session...`,
							});
							try {
								await groupChatRouter.respawnParticipantWithRecovery(
									groupChatId,
									participantName,
									pm,
									ad
								);
								debugLog(
									'GroupChat:Debug',
									` Successfully re-spawned ${participantName} for recovery`
								);
								// Don't mark as responded yet - the recovery spawn will complete and trigger this
							} catch (respawnErr) {
								debugLog('GroupChat:Debug', ` Failed to respawn ${participantName}:`, respawnErr);
								logger.error(
									'[GroupChat] Failed to respawn participant for recovery',
									'ProcessListener',
									{
										error: String(respawnErr),
										participant: participantName,
									}
								);
								// Notify UI that recovery failed
								groupChatEmitters.emitMessage?.(groupChatId, {
									timestamp: new Date().toISOString(),
									from: 'system',
									content: `⚠️ Failed to create new session for ${participantName}: ${String(respawnErr)}`,
								});
								// Mark as responded since recovery failed
								markAndMaybeSynthesize();
							}
						} else {
							debugLog(
								'GroupChat:Debug',
								` Cannot respawn - processManager or agentDetector not available`
							);
							markAndMaybeSynthesize();
						}
						debugLog('GroupChat:Debug', ` ===============================================`);
						return;
					}

					// Normal processing - parse and route the response
					try {
						debugLog(
							'GroupChat:Debug',
							` Chat loaded for participant parsing: ${chat?.name || 'null'}`
						);
						debugLog('GroupChat:Debug', ` Agent type for parsing: ${agentType}`);
						const parsedText = outputParser.extractTextFromStreamJson(bufferedOutput, agentType);
						debugLog('GroupChat:Debug', ` Parsed text length: ${parsedText.length}`);
						debugLog(
							'GroupChat:Debug',
							` Parsed text preview: "${parsedText.substring(0, 200)}${parsedText.length > 200 ? '...' : ''}"`
						);
						if (parsedText.trim()) {
							debugLog('GroupChat:Debug', ` Routing agent response from ${participantName}...`);
							// Await the response logging before marking participant as responded
							const pm = getProcessManager();
							await groupChatRouter.routeAgentResponse(
								groupChatId,
								participantName,
								parsedText,
								pm ?? undefined
							);
							debugLog(
								'GroupChat:Debug',
								` Successfully routed agent response from ${participantName}`
							);
							// Mark participant AFTER routing completes successfully
							markAndMaybeSynthesize();
						} else {
							debugLog('GroupChat:Debug', ` WARNING: Parsed text is empty for ${participantName}!`);
							// No response to route, mark participant as done
							markAndMaybeSynthesize();
						}
					} catch (err) {
						debugLog('GroupChat:Debug', ` ERROR loading chat for participant:`, err);
						logger.error(
							'[GroupChat] Failed to load chat for participant output parsing',
							'ProcessListener',
							{ error: String(err), participant: participantName }
						);
						try {
							const parsedText = outputParser.extractTextFromStreamJson(bufferedOutput);
							if (parsedText.trim()) {
								const pm = getProcessManager();
								await groupChatRouter.routeAgentResponse(
									groupChatId,
									participantName,
									parsedText,
									pm ?? undefined
								);
								// Mark participant AFTER routing completes successfully
								markAndMaybeSynthesize();
							} else {
								// No response to route, mark participant as done
								markAndMaybeSynthesize();
							}
						} catch (routeErr) {
							debugLog('GroupChat:Debug', ` ERROR routing agent response (fallback):`, routeErr);
							logger.error('[GroupChat] Failed to route agent response', 'ProcessListener', {
								error: String(routeErr),
								participant: participantName,
							});
							// Mark participant as done even after error (can't retry)
							markAndMaybeSynthesize();
						}
					}
				})().finally(() => {
					outputBuffer.clearGroupChatBuffer(sessionId);
					debugLog('GroupChat:Debug', ` Cleared output buffer for participant session`);
					// Note: markAndMaybeSynthesize() is called explicitly in each code path above
					// to ensure proper sequencing - NOT in finally() which would cause race conditions
					// with session recovery (where we DON'T want to mark until recovery completes)
				});
			} else {
				debugLog(
					'GroupChat:Debug',
					` WARNING: No buffered output for participant ${participantName}!`
				);
				// No output to log, so mark participant as responded immediately
				markAndMaybeSynthesize();
			}
			debugLog('GroupChat:Debug', ` ===============================================`);
			// Don't send to regular exit handler
			return;
		}

		safeSend('process:exit', sessionId, code);

		// Broadcast exit to web clients
		const webServer = getWebServer();
		if (webServer) {
			// Extract base session ID from formats: {id}-ai-{tabId}, {id}-terminal, {id}-batch-{timestamp}, {id}-synopsis-{timestamp}
			const baseSessionId = sessionId.replace(
				/-ai-.+$|-terminal$|-batch-\d+$|-synopsis-\d+$/,
				''
			);
			webServer.broadcastToSessionClients(baseSessionId, {
				type: 'session_exit',
				sessionId: baseSessionId,
				exitCode: code,
				timestamp: Date.now(),
			});
		}
	});
}
