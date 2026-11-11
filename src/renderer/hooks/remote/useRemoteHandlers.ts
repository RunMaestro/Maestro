/**
 * useRemoteHandlers - extracted from App.tsx (Phase 2K)
 *
 * Handles remote command processing from the web interface:
 *   - handleRemoteCommand event listener (terminal + AI mode dispatching)
 *   - handleQuickActionsToggleRemoteControl (live mode toggle)
 *   - sessionSshRemoteNames (memoized map for group chat participant cards)
 *
 * Reads from: sessionStore, uiStore
 * Event: 'maestro:remoteCommand' custom DOM event
 */

import { useEffect, useMemo, useCallback } from 'react';
import type { Session, SessionState, LogEntry, CustomAICommand } from '../../types';
import {
	getCachedCapabilities,
	setCapabilitiesCache,
	DEFAULT_CAPABILITIES,
	type AgentCapabilities,
} from '../agent/useAgentCapabilities';
import { useSessionStore, updateAiTab } from '../../stores/sessionStore';
import { useUIStore } from '../../stores/uiStore';
import {
	getActiveTab,
	settleAgentStateFromTabs,
	settleTabThinkingState,
} from '../../utils/tabHelpers';
import { resolveTabPermissionMode } from '../../../shared/agentMetadata';
import { generateId } from '../../utils/ids';
import {
	captureQueuedTurnSettings,
	codifyQueuedTurnSettings,
	projectTabProvider,
} from '../../utils/providerTabSessions';
import { settleAutoTurn } from '../../services/autoTurn';
import { enqueuePromptForTab, sendQueuedItemNow } from '../../services/queuedPrompt';
import { getGrokCommandScope, getGrokSlashCommandRefusal } from '../../slashCommands';
import { canonicalJson } from '../../../shared/canonicalJson';
import { captureException } from '../../utils/sentry';
import { isAgentAlreadyRunningError } from '../../../shared/processErrors';
import { prependNewSessionMessageOnFirstTurn } from '../../../shared/newSessionMessage';
import { filterYoloArgs } from '../../utils/agentArgs';
import { prepareMaestroSystemPrompt } from '../../utils/spawnHelpers';
import { DEFAULT_IMAGE_ONLY_PROMPT } from '../input/useInputProcessing';
import {
	planCrossAgentMentions,
	dispatchCrossAgentMentions,
	previewMentionDispatch,
	withMentionTurnNotes,
} from '../../services/crossAgentMentions';
import type { MentionRouting } from '../../../shared/crossAgentContext';
import { noteDirectDispatch } from '../../stores/retryStore';
import { pendingTranslationSource } from '../../../shared/maestro-lib/translation/send';
import { migrationHoldsTurns } from '../../../shared/maestro-lib/translation/session';
import { requestTabAutoNameForMessage } from '../../services/tabAutoNaming';
import { logger } from '../../utils/logger';
import type { ConsultChain } from '../../../shared/consultBudget';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseRemoteHandlersDeps {
	/** Sessions ref for non-reactive access in event handlers */
	sessionsRef: React.MutableRefObject<Session[]>;
	/** Custom AI commands ref (updated on every render) */
	customAICommandsRef: React.MutableRefObject<CustomAICommand[]>;
	/** Spec-Kit commands ref */
	speckitCommandsRef: React.MutableRefObject<CustomAICommand[]>;
	/** OpenSpec commands ref */
	openspecCommandsRef: React.MutableRefObject<CustomAICommand[]>;
	/** BMAD commands ref */
	bmadCommandsRef?: React.MutableRefObject<CustomAICommand[]>;
	/** Toggle global live mode (web interface) */
	toggleGlobalLive: () => Promise<void>;
	/** Whether live/remote mode is active */
	isLiveMode: boolean;
	/** SSH remote configs from app initialization */
	sshRemoteConfigs: Array<{ id: string; name: string }>;
}

/**
 * How long the remote AI spawn may run before delivery is acked anyway.
 *
 * Kept comfortably inside the main side's `REMOTE_COMMAND_RECEIPT_TIMEOUT_MS`
 * (3000ms, `src/main/web-server/callbacks/commandCallbacks.ts`) so a slow spawn
 * is acked as handover rather than timing the caller out, while a spawn that
 * rejects quickly - a missing or misconfigured agent binary, typically inside a
 * few milliseconds - still reports the failure honestly.
 */
const REMOTE_SPAWN_ACK_GRACE_MS = 1500;

// ============================================================================
// Return type
// ============================================================================

export interface UseRemoteHandlersReturn {
	/** Toggle remote control live mode */
	handleQuickActionsToggleRemoteControl: () => Promise<void>;
	/** Map of session names to SSH remote config names */
	sessionSshRemoteNames: Map<string, string>;
}

// ============================================================================
// Hook
// ============================================================================

export function useRemoteHandlers(deps: UseRemoteHandlersDeps): UseRemoteHandlersReturn {
	const {
		sessionsRef,
		customAICommandsRef,
		speckitCommandsRef,
		openspecCommandsRef,
		bmadCommandsRef,
		toggleGlobalLive,
		isLiveMode,
		sshRemoteConfigs,
	} = deps;

	// PERF: SSH remote signature only - streaming must not wake App via sessions[].
	// Remote command handler already reads via sessionsRef / getState().
	const sessionSshRemoteKey = useSessionStore((s) =>
		s.sessions
			.filter(
				(sess) => sess.sessionSshRemoteConfig?.enabled && sess.sessionSshRemoteConfig.remoteId
			)
			.map((sess) => `${sess.name}|${sess.sessionSshRemoteConfig!.remoteId}`)
			.join('\n')
	);
	const setSessions = useMemo(() => useSessionStore.getState().setSessions, []);
	const addLogToTab = useMemo(() => useSessionStore.getState().addLogToTab, []);
	const setSuccessFlashNotification = useMemo(
		() => useUIStore.getState().setSuccessFlashNotification,
		[]
	);

	// ====================================================================
	// sessionSshRemoteNames - memoized map for group chat participant cards
	// ====================================================================

	const sessionSshRemoteNames = useMemo(() => {
		const map = new Map<string, string>();
		for (const session of useSessionStore.getState().sessions) {
			if (session.sessionSshRemoteConfig?.enabled && session.sessionSshRemoteConfig.remoteId) {
				const sshConfig = sshRemoteConfigs.find(
					(c) => c.id === session.sessionSshRemoteConfig?.remoteId
				);
				if (sshConfig) {
					map.set(session.name, sshConfig.name);
				}
			}
		}
		return map;
		// sessionSshRemoteKey encodes name+remoteId pairs without a full sessions[] sub.
	}, [sessionSshRemoteKey, sshRemoteConfigs]);

	// ====================================================================
	// handleRemoteCommand - processes commands from web interface
	// ====================================================================

	useEffect(() => {
		const handleRemoteCommand = async (event: Event) => {
			const customEvent = event as CustomEvent<{
				sessionId: string;
				command: string;
				inputMode?: 'ai' | 'terminal';
				/** Optional explicit tab target (from `maestro-cli dispatch --session
				 *  <tabId>`). When unset, falls back to the active tab. When set
				 *  but unknown, the command is dropped (we never silently re-route
				 *  to the active tab - callers chaining `--session <tabId>` would
				 *  otherwise believe the command landed in the requested tab). */
				tabId?: string;
				/** When true, the prompt may land in a tab that is itself mid-turn
				 *  (`dispatch --force` behind `allowConcurrentSend`, a Cadenza
				 *  decision answered mid-turn). An idle tab needs no force. */
				force?: boolean;
				/** Optional base64 data URLs pasted from a web/mobile client.
				 *  Forwarded to the agent spawn so AI tabs can render and send
				 *  them in the prompt, mirroring desktop staged-images. */
				images?: string[];
				/** New-tab provider commands that have no Maestro prompt expansion. */
				literalPrompt?: boolean;
				/** `dispatch --routing`: the `@mention` routing the composer strip
				 *  would set. Absent leaves the wording in charge. */
				mentionRouting?: MentionRouting;
				/** Reply channel for the web server's delivery receipt. Set when the
				 *  command arrived over `remote:executeCommand`; absent for
				 *  in-renderer synthetic dispatches. */
				receiptChannel?: string;
				/** The place in a consult chain this command's turn takes, set when
				 *  another agent's `maestro-cli dispatch` sent it. Handed to the
				 *  spawn so the delegated turn's own consults spend the chain it
				 *  descends from (shared/consultBudget.ts). */
				consultChain?: ConsultChain;
				pianolaDispatchId?: string;
			}>;
			const {
				sessionId,
				command,
				inputMode: webInputMode,
				tabId: requestedTabId,
				force,
				images,
				literalPrompt,
				mentionRouting,
				receiptChannel,
				consultChain,
				pianolaDispatchId,
			} = customEvent.detail;

			// The CLI's `dispatch` success flag is this ack, not the fact that an
			// IPC send happened. `accepted: true` means the command reached the
			// spawn/queue logic - delivery, not execution - so it is sent as the
			// prompt is handed over, never after the agent replies. Every drop
			// branch below answers `false` with the reason it dropped.
			let receiptSent = false;
			const reportDelivery = (accepted: boolean, reason?: string) => {
				if (!receiptChannel || receiptSent) return;
				receiptSent = true;
				window.maestro.process.sendRemoteCommandReceipt(receiptChannel, accepted, reason);
			};

			logger.info('[Remote] Processing remote command via event:', undefined, {
				sessionId,
				command: command.substring(0, 50),
				webInputMode,
				requestedTabId,
			});

			// Find the session directly from sessionsRef (not from React state which may be stale)
			let session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) {
				logger.info('[Remote] ERROR: Session not found in sessionsRef:', undefined, sessionId);
				reportDelivery(false, 'session-not-found');
				return;
			}

			// Use web's inputMode if provided, otherwise fall back to session state
			const effectiveInputMode = webInputMode || session.inputMode;

			logger.info('[Remote] Found session:', undefined, {
				id: session.id,
				agentSessionId: session.agentSessionId || 'none',
				state: session.state,
				sessionInputMode: session.inputMode,
				effectiveInputMode,
				toolType: session.toolType,
			});

			if (
				pianolaDispatchId &&
				(effectiveInputMode !== 'ai' ||
					!requestedTabId ||
					session.state === 'busy' ||
					session.agentErrorPaused ||
					!session.aiTabs.some(
						(t) => t.id === requestedTabId && t.state !== 'busy' && !t.agentError
					))
			) {
				reportDelivery(false, 'DispatchTargetUnavailable');
				return;
			}
			// Handle terminal mode commands
			if (effectiveInputMode === 'terminal') {
				logger.info('[Remote] Terminal mode - using runCommand for clean output');

				// Add user message to shell logs and set state to busy
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						return {
							...s,
							state: 'busy' as SessionState,
							busySource: 'terminal',
							// TODO: Remove shellLogs once terminal tabs migration is complete
							...(!s.terminalTabs?.length && {
								shellLogs: [
									...s.shellLogs,
									{
										id: generateId(),
										timestamp: Date.now(),
										source: 'user',
										text: command,
									},
								],
							}),
						};
					})
				);

				// The command is committed to the shell path from here on, so ack
				// delivery before awaiting the run - the receipt reports handover,
				// not the command's exit status.
				reportDelivery(true);

				// Use runCommand for clean stdout/stderr capture (same as desktop)
				// When SSH is enabled for the session, the command runs on the remote host
				const isRemote = !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled;
				const commandCwd = isRemote
					? session.remoteCwd || session.sessionSshRemoteConfig?.workingDirOverride || session.cwd
					: session.shellCwd || session.cwd;
				try {
					await window.maestro.process.runCommand({
						sessionId: sessionId,
						command: command,
						cwd: commandCwd,
						sessionSshRemoteConfig: session.sessionSshRemoteConfig,
					});
					logger.info('[Remote] Terminal command completed successfully');
				} catch (error: unknown) {
					captureException(error, {
						extra: {
							sessionId,
							toolType: session.toolType,
							mode: 'terminal',
							operation: 'remote-command',
						},
					});
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							return {
								...settleAgentStateFromTabs(s),
								// TODO: Remove shellLogs once terminal tabs migration is complete
								...(!s.terminalTabs?.length && {
									shellLogs: [
										...s.shellLogs,
										{
											id: generateId(),
											timestamp: Date.now(),
											source: 'system',
											text: `Error: Failed to run command - ${errorMessage}`,
										},
									],
								}),
							};
						})
					);
				}
				return;
			}

			// Pin the target BEFORE capability lookup can yield so unknown-
			// command error logs land on the targeted tab instead of whichever
			// tab happens to be active. This also lets us short-circuit early
			// when `--session <tabId>` names a tab that no longer exists, rather
			// than silently re-routing to the active tab (which would mislead
			// callers chaining `command_result.tabId` back as `--session`).
			const requestedTab = requestedTabId
				? session.aiTabs?.find((t) => t.id === requestedTabId)
				: undefined;
			if (requestedTabId && !requestedTab) {
				logger.warn(
					`[Remote] Requested tabId "${requestedTabId}" not found in session ${sessionId} - dropping command (avoiding silent re-route to active tab)`
				);
				reportDelivery(false, `tab-not-found:${requestedTabId}`);
				return;
			}
			const targetTab = requestedTab ?? getActiveTab(session);
			const writeTabId = targetTab?.id;
			// Everything below (capabilities, commands, the spawn) is the target
			// tab's provider, not the agent default.
			session = projectTabProvider(session, targetTab).agent;

			const grokCommandScope = canonicalJson({
				...getGrokCommandScope({ ...session, activeTabId: writeTabId ?? session.activeTabId }),
				pid: undefined,
				state: undefined,
				remoteCwd: session.remoteCwd,
				permissionMode: resolveTabPermissionMode(targetTab),
			});

			// Handle AI mode for batch-mode agents.
			//
			// A cache MISS is not an answer. `hasCapabilityCached` reports one as
			// the conservative default (`supportsBatchMode: false`), which is how
			// dispatches to agent types the user had not opened this renderer
			// session were silently dropped. Startup priming normally fills the
			// cache, but resolve on demand here too so this path is structurally
			// incapable of acting on a miss if priming races or fails. A cached
			// `false` still drops - that is correct for `terminal`/`web`.
			let supportsBatchMode = getCachedCapabilities(session.toolType)?.supportsBatchMode;
			if (supportsBatchMode === undefined) {
				try {
					const resolved = await window.maestro.agents.getCapabilities(session.toolType);
					const full: AgentCapabilities = { ...DEFAULT_CAPABILITIES, ...resolved };
					setCapabilitiesCache(session.toolType, full);
					supportsBatchMode = full.supportsBatchMode;
				} catch (error: unknown) {
					logger.warn(
						`[Remote] Failed to resolve capabilities for toolType "${session.toolType}" - dropping command`,
						undefined,
						error
					);
					reportDelivery(false, `capability-lookup-failed:${session.toolType}`);
					return;
				}
			}
			if (!supportsBatchMode) {
				logger.info('[Remote] Not a batch-mode agent, skipping', undefined, {
					toolType: session.toolType,
					supportsBatchMode,
				});
				reportDelivery(false, `not-a-batch-mode-agent:${session.toolType}`);
				return;
			}

			const submittedSettings = captureQueuedTurnSettings(targetTab, session);

			// Busy guard, decided per TAB. A busy agent only means some tab of it is
			// working; an idle tab beside it runs its own turn in parallel, the same
			// as a desktop tab. Only a tab that is itself mid-turn is refused,
			// because a second turn there interleaves two answers in one
			// conversation. `force` (`dispatch --force` behind allowConcurrentSend,
			// a Cadenza decision) lifts even that.
			if (targetTab?.state === 'busy' && !force) {
				logger.info('[Remote] Target tab is mid-turn, cannot process command');
				reportDelivery(false, 'tab-busy');
				return;
			}

			// Maestro prompt commands share the ordinary queue's argument/template
			// expansion and admitted spawn. A native advertisement is never a prompt.
			const commandText = command.trim();
			if (commandText.startsWith('/') && (!literalPrompt || session.toolType === 'grok')) {
				const baseCommand = commandText.split(/\s/, 1)[0];
				const matchingCommand =
					!literalPrompt &&
					[
						...customAICommandsRef.current,
						...speckitCommandsRef.current,
						...openspecCommandsRef.current,
						...(bmadCommandsRef?.current ?? []),
					].find((candidate) => candidate.command === baseCommand);

				if (matchingCommand) {
					// enqueuePromptForTab intentionally falls back to the active tab.
					// This dispatch has a pinned recipient: refuse a missing target
					// before the synchronous enqueue instead of accepting that fallback.
					const liveSession = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
					const liveTab = liveSession?.aiTabs.find((tab) => tab.id === writeTabId);
					if (!liveSession || !liveTab || !writeTabId) {
						reportDelivery(false, 'command-target-unavailable');
						return;
					}
					const liveAgent = projectTabProvider(liveSession, liveTab).agent;
					if (
						liveAgent.toolType !== session.toolType ||
						(session.toolType === 'grok' &&
							canonicalJson({
								...getGrokCommandScope({ ...liveAgent, activeTabId: writeTabId }),
								pid: undefined,
								state: undefined,
								remoteCwd: liveAgent.remoteCwd,
								permissionMode: resolveTabPermissionMode(liveTab),
							}) !== grokCommandScope)
					) {
						addLogToTab(
							sessionId,
							{
								source: 'error',
								text: 'The command target changed during preparation. Retry with the intended account, host and tab.',
							},
							writeTabId
						);
						reportDelivery(false, 'command-target-changed');
						return;
					}
					if (liveTab.state === 'busy' && !force) {
						reportDelivery(false, 'tab-busy');
						return;
					}
					// The command queue does not yet forward attachments at its spawn
					// boundary. Refuse before accepting a prompt whose images it would drop.
					if (images?.length) {
						addLogToTab(
							sessionId,
							{
								source: 'error',
								text: 'Attachments are not supported for queued AI commands yet.',
							},
							writeTabId
						);
						reportDelivery(false, 'command-images-unsupported');
						return;
					}
					const queued = enqueuePromptForTab({
						sessionId,
						tabId: writeTabId,
						text: command,
						images,
						slashCommand: true,
					});
					if (!queued) {
						reportDelivery(false, 'command-target-unavailable');
						return;
					}
					setSessions((prev) =>
						prev.map((s) =>
							s.id === sessionId
								? {
										...s,
										aiCommandHistory: Array.from(
											new Set([...(s.aiCommandHistory || []), commandText])
										).slice(-50),
									}
								: s
						)
					);
					// Delivery is accepted by the queue, not proof of provider execution.
					reportDelivery(true);
					if (force) sendQueuedItemNow(sessionId, queued.id);
					return;
				}

				if (session.toolType === 'grok') {
					// Discovery may wait three seconds; refuse the receipt immediately
					// so the sender does not time out while the explanation is loading.
					reportDelivery(false, 'unsupported-grok-command');
					const refusal = await getGrokSlashCommandRefusal(session, targetTab, commandText);
					if (writeTabId) addLogToTab(sessionId, { source: 'error', text: refusal }, writeTabId);
					return;
				}
				addLogToTab(
					sessionId,
					{ source: 'error', text: `Unknown command: ${commandText}` },
					writeTabId
				);
				// No command arguments enter the receipt's main-process log.
				reportDelivery(false, 'unknown-command');
				return;
			}

			// Cross-agent @mentions, resolved the way the composer does it
			// (useInputProcessing): a remote prompt is the same message a user would
			// have typed, so a mention in it must consult the target agent too.
			// The target tab is idle here (the busy guard above), so the consult
			// fires now; a prompt that should wait goes through `dispatch --queue`,
			// which stamps the intent on the queued item instead. A routing the
			// caller picked (`dispatch --routing`) wins over the wording, as the
			// strip's does.
			const mentionPlan = planCrossAgentMentions(command, sessionId, mentionRouting);
			if (pianolaDispatchId && mentionPlan) {
				reportDelivery(false, 'DispatchMentionRoutingUnavailable');
				return;
			}
			if (mentionPlan?.suppressLocal) {
				// Leading mention: addressed only at the consulted agent(s). This
				// agent does not answer, so record the user's bubble and skip the spawn.
				//
				// Without a tab there is nowhere to anchor the consult's streamed
				// reply, so DROP the dispatch rather than letting it fall through:
				// falling through would send a message the user addressed to someone
				// else straight to this agent, which is the one thing `suppressLocal`
				// exists to prevent.
				if (!writeTabId) {
					logger.warn(
						`[Remote] Leading @mention for session ${sessionId} has no AI tab to anchor the consult - dropping`
					);
					reportDelivery(false, 'no-target-tab-for-mention');
					return;
				}
				// `consultChain` is set when another agent's `maestro-cli dispatch` sent
				// this prompt: its mentions are then that agent's consults, and spend
				// the chain the prompt arrived in.
				dispatchCrossAgentMentions(mentionPlan, command, session, writeTabId, images, consultChain);
				// The bubble below lands in this tab, so name it from the message just as
				// the composer does for a leading mention (it names before planning).
				requestTabAutoNameForMessage(session, writeTabId, command, 'remote');
				const mentionOnlyEntry: LogEntry = {
					id: generateId(),
					timestamp: Date.now(),
					source: 'user',
					text: command,
					...(images && images.length > 0 && { images }),
				};
				updateAiTab(sessionId, writeTabId, (tab) => ({
					...tab,
					logs: [...tab.logs, mentionOnlyEntry],
				}));
				reportDelivery(true);
				return;
			}

			let promptToSend = command;

			// Image-only sends (web/mobile composer paste with no text) arrive
			// with an empty command. Inject the user-customizable image-only
			// default prompt so the agent CLI doesn't crash on an empty --print
			// arg, mirroring the desktop input path in useInputProcessing.
			if (!promptToSend.trim() && images && images.length > 0) {
				promptToSend = DEFAULT_IMAGE_ONLY_PROMPT;
			}

			// Pending native context uses the queue's shared send gate. A warning
			// can then hold the original message and its captured settings safely.
			if (
				targetTab &&
				(pendingTranslationSource(session, targetTab.id, session.toolType) ||
					migrationHoldsTurns(session.providerMigration))
			) {
				const queued = enqueuePromptForTab({
					sessionId,
					tabId: targetTab.id,
					text: promptToSend,
					turnSettings: submittedSettings,
					images,
					consultChain,
				});
				reportDelivery(!!queued, queued ? undefined : 'translation-queue-unavailable');
				return;
			}

			try {
				// Get agent configuration for this session's tool type
				const agent = await window.maestro.agents.get(session.toolType);
				if (!agent) {
					logger.info(`[Remote] ERROR: Agent not found for toolType: ${session.toolType}`);
					reportDelivery(false, `agent-not-configured:${session.toolType}`);
					return;
				}

				// The agent-config await above is a real microtask gap. Re-check
				// that the tab we resolved still exists; if it was closed in the
				// interim, abort before spawning so the agent doesn't start with
				// a `${sessionId}-ai-${tabId}` route that nothing reads from.
				if (writeTabId) {
					const liveSession = sessionsRef.current.find((s) => s.id === sessionId);
					const tabStillExists = liveSession?.aiTabs?.some((t) => t.id === writeTabId);
					if (!tabStillExists) {
						logger.warn(
							`[Remote] Target tab "${writeTabId}" was closed before spawn - dropping command`
						);
						reportDelivery(false, `tab-closed-before-spawn:${writeTabId}`);
						return;
					}
				}

				const tabAgentSessionId = targetTab?.agentSessionId;
				const isReadOnly =
					targetTab?.readOnlyMode === true || targetTab?.permissionMode === 'readonly';
				const effectivePermissionMode = isReadOnly
					? 'readonly'
					: resolveTabPermissionMode(targetTab);

				// Filter out YOLO/skip-permissions flags when read-only mode is active
				const agentArgs = agent.args ?? [];
				const spawnArgs = isReadOnly ? filterYoloArgs(agentArgs, agent) : [...agentArgs];

				// Include tab ID in targetSessionId for proper output routing
				const targetSessionId = `${sessionId}-ai-${targetTab?.id || 'default'}`;
				const commandToUse = agent.path ?? agent.command ?? '';

				const appendSystemPrompt = await prepareMaestroSystemPrompt({
					session,
					activeTabId: targetTab?.id,
					consultChain,
				});

				const remoteImages = images && images.length > 0 ? images : undefined;

				// A dispatch that opens the tab's first turn starts a new provider
				// session, so it carries the New Session Message like a typed message
				// does. Agent-only: the user bubble below keeps the plain `promptToSend`.
				const agentPrompt = prependNewSessionMessageOnFirstTurn(
					promptToSend,
					session.newSessionMessage,
					tabAgentSessionId
				);

				logger.info('[Remote] Spawning agent:', undefined, {
					maestroSessionId: sessionId,
					targetSessionId,
					targetTabId: targetTab?.id,
					tabAgentSessionId: tabAgentSessionId || 'NEW SESSION',
					isResume: !!tabAgentSessionId,
					hasAppendSystemPrompt: !!appendSystemPrompt,
					command: commandToUse,
					args: spawnArgs,
					prompt: promptToSend.substring(0, 100),
					imageCount: remoteImages?.length ?? 0,
				});

				// Name the tab from what was dispatched, exactly as the composer does for a
				// typed message. `maestro-cli dispatch`, `send --live`, an idle `dispatch
				// --new-tab`, and the web/mobile composer all land here without passing
				// through the desktop composer, so this is the only chance such a tab
				// gets to be named. A matched slash command is skipped, as it is in the
				// composer (which returns before naming) and in the queue drain (which
				// skips `command` items): its text is a command name, not a request.
				// Runs after the awaits above, and the helper reads the live tab, so a
				// tab closed or named in the meantime is left alone.
				if (targetTab) {
					requestTabAutoNameForMessage(session, targetTab.id, command, 'remote');
				}

				// Add user message to target tab's logs and set state to busy
				const userLogEntry: LogEntry = {
					id: generateId(),
					timestamp: Date.now(),
					source: 'user',
					text: promptToSend,
					...(remoteImages && { images: remoteImages }),
				};

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						// Pin the target tab id so we don't accidentally write into a
						// different active tab if the user switched while we awaited
						// the agent config above.
						const resolvedWriteTabId = writeTabId ?? s.activeTabId;
						const updatedAiTabs =
							s.aiTabs?.length > 0
								? s.aiTabs.map((tab) =>
										tab.id === resolvedWriteTabId
											? {
													...tab,
													state: 'busy' as const,
													// Per-tab, like a composer send: a tab's elapsed timer (Quick
													// Chat's "Working for", parallel tabs) reads the tab's own start.
													thinkingStartTime: Date.now(),
													logs: [...tab.logs, userLogEntry],
													...codifyQueuedTurnSettings({ turnSettings: submittedSettings }, tab, s),
												}
											: tab
									)
								: s.aiTabs;

						if (!s.aiTabs?.some((t) => t.id === resolvedWriteTabId)) {
							logger.error('[runAICommand] Target tab not found in session - dropping user log');
							return s;
						}

						return {
							...s,
							state: 'busy' as SessionState,
							busySource: 'ai',
							thinkingStartTime: Date.now(),
							currentCycleTokens: 0,
							currentCycleBytes: 0,
							aiTabs: updatedAiTabs,
						};
					})
				);

				// Agent Resilience: snapshot the prompt BEFORE spawning so a
				// transient failure can auto-resend it.
				//
				// This path spawns directly rather than going through
				// `agentStore.processQueuedItem`, so it snapshots for itself - every
				// prompt that arrives from `maestro-cli dispatch`, a Cue pipeline, or
				// the web/mobile composer would otherwise fail with "No prompt
				// snapshot to resend" and fall back to the error modal. Those are the
				// UNATTENDED paths, where nobody is watching to press retry.
				//
				// The item mirrors what the composer queues: a plain message pinned to
				// the resolved target tab, so a replay lands on the same tab this
				// spawn is writing to. Skip when no real tab resolved: the spawn falls
				// back to a `-ai-default` route, and a replay keyed on that would land
				// nowhere.
				if (targetTab?.id) {
					noteDirectDispatch(sessionId, {
						id: generateId(),
						timestamp: Date.now(),
						tabId: targetTab.id,
						type: 'message',
						text: promptToSend,
						// A resend of a delegated turn stays in the chain it was
						// admitted to, rather than rooting a fresh one.
						...(consultChain ? { consultChain } : {}),
					});
				}

				// A command that lands on an agent set to the Auto model took the tab
				// with a pending stamp just above. Settle it before the spawn: the
				// router's answer decides the model, effort and place. Null on a named
				// model, which keeps what this path has always passed. A tier target
				// that cannot be used throws, into the catch below.
				const autoLaunch = targetTab?.id
					? await settleAutoTurn({ sessionId, tabId: targetTab.id, prompt: promptToSend })
					: null;

				// Ack delivery on whichever comes first: the spawn settling, or a
				// timer set inside the main-side receipt timeout.
				//
				// Acking unconditionally before the await (the first cut of this
				// fix) made the catch below dead code - `receiptSent` was already
				// true - so a spawn that rejected immediately, the usual shape of a
				// missing or misconfigured agent binary, still reported
				// `accepted: true`. That is the very "accepted but never runs"
				// failure this PR exists to remove, reintroduced one layer down
				// (review of PR #1357).
				//
				// Awaiting the spawn outright is not the answer either: the caller
				// gives up after REMOTE_COMMAND_RECEIPT_TIMEOUT_MS and would turn a
				// merely slow dispatch into a reported failure. So the timer keeps
				// the handover contract for slow spawns while fast failures - which
				// settle in milliseconds, far inside the window - report honestly.
				const ackTimer = setTimeout(() => reportDelivery(true), REMOTE_SPAWN_ACK_GRACE_MS);

				try {
					// Spawn agent with the prompt
					await window.maestro.process.spawn({
						sessionId: targetSessionId,
						transcriptBoundaryId: userLogEntry.id,
						pianolaDispatchId,
						toolType: session.toolType,
						cwd: session.cwd,
						command: commandToUse,
						args: spawnArgs,
						// A trailing mention is answered by the consulted agent in parallel,
						// or handed this turn's answer when it ends (dispatched below); tell
						// this turn which, so it waits for the reply or writes an answer
						// that stands alone. Agent-only: the user bubble above keeps the
						// plain `promptToSend`.
						prompt:
							mentionPlan && writeTabId
								? withMentionTurnNotes(agentPrompt, previewMentionDispatch(mentionPlan))
								: agentPrompt,
						images: remoteImages,
						appendSystemPrompt,
						agentSessionId: tabAgentSessionId ?? undefined,
						readOnlyMode: isReadOnly,
						permissionMode: effectivePermissionMode,
						sessionCustomPath: session.customPath,
						sessionCustomArgs: session.customArgs,
						sessionAdditionalDirectories: session.additionalDirectories,
						sessionCustomEnvVars: session.customEnvVars,
						...(autoLaunch
							? {
									sessionCustomModel: autoLaunch.model,
									sessionCustomEffort: autoLaunch.effort,
									...(autoLaunch.runOn ? { runOnOverride: autoLaunch.runOn } : {}),
								}
							: {
									sessionCustomModel: submittedSettings.model,
									sessionCustomEffort: submittedSettings.effort,
									runOnOverride: submittedSettings.runOn,
								}),
						sessionCustomContextWindow: session.customContextWindow,
						sessionSshRemoteConfig: session.sessionSshRemoteConfig,
						...(consultChain ? { consultChain } : {}),
					});
				} finally {
					clearTimeout(ackTimer);
				}

				// Reached only when the spawn resolved, so this is a real accept.
				// A no-op if the grace timer already acked.
				reportDelivery(true);
				logger.info(`[Remote] ${session.toolType} spawn initiated successfully`);
				// Trailing mention: this agent answers AND the mentioned agent is
				// consulted alongside it, or handed the answer when it ends.
				if (mentionPlan && writeTabId) {
					dispatchCrossAgentMentions(
						mentionPlan,
						command,
						session,
						writeTabId,
						images,
						consultChain
					);
				}
			} catch (error: unknown) {
				// A remote command that lands while the agent is mid-turn is refused
				// by ProcessManager, on purpose - the session already owns a live
				// process. That is an ordinary race, not a fault: the caller gets an
				// honest `accepted: false` receipt below and the tab gets the error
				// log, so the user is told either way. Reporting it paged Sentry for
				// nothing (MAESTRO-ZS). Every other spawn failure still reports.
				const isSpawnCollision = isAgentAlreadyRunningError(error);
				if (!isSpawnCollision) {
					captureException(error, {
						extra: {
							sessionId,
							toolType: session.toolType,
							mode: 'ai',
							operation: 'remote-spawn',
						},
					});
				}
				const errorMessage = error instanceof Error ? error.message : String(error);
				// Reports the failure honestly for everything that fails before the
				// grace timer fires - the pre-handover failures (agent config
				// lookup, prompt preparation) and now also a spawn that rejects
				// fast, which is the common missing-binary case. Still a no-op if a
				// slow spawn already acked; nothing can un-say a sent receipt.
				reportDelivery(false, `remote-spawn-error:${errorMessage}`);
				const errorLogEntry: LogEntry = {
					id: generateId(),
					timestamp: Date.now(),
					source: 'system',
					text: `Error: Failed to process remote command - ${errorMessage}`,
				};
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						// Mirror the success path: route the error log to the same tab
						// we tried to write into, falling back to active when unset.
						const resolvedWriteTabId = writeTabId ?? s.activeTabId;
						if (!s.aiTabs?.some((t) => t.id === resolvedWriteTabId)) {
							logger.error(
								'[runAICommand error] Target tab not found in session - dropping error log'
							);
							return s;
						}

						const withLog = {
							...s,
							aiTabs: s.aiTabs.map((tab) =>
								tab.id === resolvedWriteTabId ? { ...tab, logs: [...tab.logs, errorLogEntry] } : tab
							),
						};
						// A collision means another turn is live on this tab: leave its
						// busy state exactly as it is, the same rule the composer and the
						// queue follow - its exit settles it. Any other failure started
						// nothing, so settle only this tab; another tab mid-turn keeps the
						// agent busy.
						return isSpawnCollision ? withLog : settleTabThinkingState(withLog, resolvedWriteTabId);
					})
				);
			}
		};
		window.addEventListener('maestro:remoteCommand', handleRemoteCommand);
		return () => window.removeEventListener('maestro:remoteCommand', handleRemoteCommand);
	}, []);

	// ====================================================================
	// handleQuickActionsToggleRemoteControl
	// ====================================================================

	const handleQuickActionsToggleRemoteControl = useCallback(async () => {
		await toggleGlobalLive();
		if (isLiveMode) {
			setSuccessFlashNotification('Remote Control: OFFLINE - See indicator at top of left panel');
		} else {
			setSuccessFlashNotification(
				'Remote Control: LIVE - See LIVE indicator at top of left panel for QR code'
			);
		}
		setTimeout(() => setSuccessFlashNotification(null), 4000);
	}, [toggleGlobalLive, isLiveMode, setSuccessFlashNotification]);

	// ====================================================================
	// Return
	// ====================================================================

	return {
		handleQuickActionsToggleRemoteControl,
		sessionSshRemoteNames,
	};
}
