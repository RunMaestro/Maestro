import { useCallback, useRef } from 'react';
import type {
	Session,
	SessionState,
	LogEntry,
	QueuedItem,
	CustomAICommand,
	BatchRunState,
} from '../../types';
import { getActiveTab } from '../../utils/tabHelpers';
import { generateId } from '../../utils/ids';
import { substituteTemplateVariables } from '../../utils/templateVariables';
import { gitService } from '../../services/git';
import { imageOnlyDefaultPrompt, maestroSystemPrompt } from '../../../prompts';

/**
 * Default prompt used when user sends only an image without text.
 */
export const DEFAULT_IMAGE_ONLY_PROMPT = imageOnlyDefaultPrompt;

/**
 * Dependencies for the useInputProcessing hook.
 */
export interface UseInputProcessingDeps {
	/** Current active session (null if none selected) */
	activeSession: Session | null;
	/** Active session ID (may be different from activeSession.id during transitions) */
	activeSessionId: string;
	/** Session state setter */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Current input value */
	inputValue: string;
	/** Input value setter */
	setInputValue: (value: string) => void;
	/** Staged images for the current message */
	stagedImages: string[];
	/** Staged images setter */
	setStagedImages: (images: string[] | ((prev: string[]) => string[])) => void;
	/** Reference to the input textarea element */
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	/** Custom AI commands configured by the user */
	customAICommands: CustomAICommand[];
	/** Slash command menu open state setter */
	setSlashCommandOpen: (open: boolean) => void;
	/** Sync AI input value to session state (for persistence) */
	syncAiInputToSession: (value: string) => void;
	/** Sync terminal input value to session state (for persistence) */
	syncTerminalInputToSession: (value: string) => void;
	/** Whether the active session is in AI mode */
	isAiMode: boolean;
	/** Reference to sessions array (for avoiding stale closures) */
	sessionsRef: React.MutableRefObject<Session[]>;
	/** Get batch state for a session */
	getBatchState: (sessionId: string) => BatchState;
	/** Active batch run state (may differ from session's batch state) */
	activeBatchRunState: BatchState;
	/** Ref to processQueuedItem function (defined later in component, accessed via ref to avoid stale closure) */
	processQueuedItemRef: React.MutableRefObject<
		((sessionId: string, item: QueuedItem) => Promise<void>) | null
	>;
	/** Flush any pending batched session updates (ensures AI output is flushed before user message appears) */
	flushBatchedUpdates?: () => void;
	/** Handler for the /history built-in command (requests synopsis and saves to history) */
	onHistoryCommand?: () => Promise<void>;
	/** Handler for the /wizard built-in command (starts the inline wizard for Auto Run documents) */
	onWizardCommand?: (args: string) => void;
	/** Handler for sending messages to the wizard (when wizard is active) */
	onWizardSendMessage?: (content: string) => Promise<void>;
	/** Whether the wizard is currently active for the active tab */
	isWizardActive?: boolean;
}

/**
 * @deprecated Use BatchRunState from '../types' directly. This alias is kept for backwards compatibility.
 */
export type BatchState = BatchRunState;

/**
 * Return type for useInputProcessing hook.
 */
export interface UseInputProcessingReturn {
	/** Process the current input (send message or execute command) */
	processInput: (overrideInputValue?: string) => Promise<void>;
	/** Ref to processInput for use in callbacks that need latest version */
	processInputRef: React.MutableRefObject<((overrideInputValue?: string) => Promise<void>) | null>;
}

/**
 * Hook for processing user input (messages and commands).
 *
 * Handles:
 * - Slash command detection and execution (custom AI commands)
 * - Message queuing when AI is busy
 * - Terminal mode cd command tracking
 * - Process spawning for batch mode (Claude Code)
 * - Broadcasting input to web clients
 *
 * @param deps - Hook dependencies
 * @returns Input processing function and ref
 */
export function useInputProcessing(deps: UseInputProcessingDeps): UseInputProcessingReturn {
	const {
		activeSession,
		activeSessionId,
		setSessions,
		inputValue,
		setInputValue,
		stagedImages,
		setStagedImages,
		inputRef,
		customAICommands,
		setSlashCommandOpen,
		syncAiInputToSession,
		syncTerminalInputToSession,
		isAiMode,
		sessionsRef,
		getBatchState,
		// Note: activeBatchRunState is in deps interface but not used - kept for API compatibility
		processQueuedItemRef,
		flushBatchedUpdates,
		onHistoryCommand,
		onWizardCommand,
		onWizardSendMessage,
		isWizardActive,
	} = deps;

	// Ref for the processInput function so external code can access the latest version
	const processInputRef = useRef<((overrideInputValue?: string) => Promise<void>) | null>(null);

	/**
	 * Process user input - handles slash commands, queuing, and message sending.
	 */
	const processInput = useCallback(
		async (overrideInputValue?: string) => {
			// Flush any pending batched updates before processing user input
			// This ensures AI output appears before the user's new message
			flushBatchedUpdates?.();

			const effectiveInputValue = overrideInputValue ?? inputValue;
			if (!activeSession || (!effectiveInputValue.trim() && stagedImages.length === 0)) {
				return;
			}

			// Handle slash commands
			// Note: slash commands are queued like regular messages when agent is busy
			if (effectiveInputValue.trim().startsWith('/')) {
				const commandText = effectiveInputValue.trim();
				const isTerminalMode = activeSession.inputMode === 'terminal';

				// Handle built-in /history command (only in AI mode)
				// This is intercepted here because it requires Maestro to handle the synopsis generation
				// rather than passing through to the agent (which may not support it or require special permissions)
				if (!isTerminalMode && commandText === '/history' && onHistoryCommand) {
					setInputValue('');
					setSlashCommandOpen(false);
					syncAiInputToSession('');
					if (inputRef.current) inputRef.current.style.height = 'auto';

					// Execute the history command handler asynchronously
					onHistoryCommand().catch((error) => {
						console.error('[processInput] /history command failed:', error);
					});
					return;
				}

				// Handle built-in /wizard command (only in AI mode)
				// This starts the inline planning wizard for Auto Run documents
				// The command can have optional arguments: /wizard <natural language input>
				// Match exactly "/wizard" or "/wizard " followed by arguments (not "/wizardry" etc.)
				const isWizardCommand = commandText === '/wizard' || commandText.startsWith('/wizard ');
				if (!isTerminalMode && isWizardCommand && onWizardCommand) {
					// Extract arguments after '/wizard ' (everything after the command)
					const args = commandText.slice('/wizard'.length).trim();

					setInputValue('');
					setSlashCommandOpen(false);
					syncAiInputToSession('');
					if (inputRef.current) inputRef.current.style.height = 'auto';

					// Execute the wizard command handler with the argument text
					onWizardCommand(args);
					return;
				}

				// Check for custom AI commands (only in AI mode)
				if (!isTerminalMode) {
					const matchingCustomCommand = customAICommands.find((cmd) => cmd.command === commandText);
					if (matchingCustomCommand) {
						// Execute the custom AI command by sending its prompt
						setInputValue('');
						setSlashCommandOpen(false);
						syncAiInputToSession(''); // We're in AI mode here (isTerminalMode === false)
						if (inputRef.current) inputRef.current.style.height = 'auto';

						// Substitute template variables and send to the AI agent
						(async () => {
							let gitBranch: string | undefined;
							if (activeSession.isGitRepo) {
								try {
									const status = await gitService.getStatus(activeSession.cwd);
									gitBranch = status.branch;
								} catch {
									// Ignore git errors
								}
							}
							substituteTemplateVariables(matchingCustomCommand.prompt, {
								session: activeSession,
								gitBranch,
							});

							// ALWAYS queue slash commands - they execute in order like write messages
							// This ensures commands are processed sequentially through the queue
							const activeTab = getActiveTab(activeSession);
							const isReadOnlyMode = activeTab?.readOnlyMode === true;
							// Check both session busy state AND AutoRun state
							// AutoRun runs in isolation and doesn't set session to busy, so we check it explicitly
							const isAutoRunActive = getBatchState(activeSession.id).isRunning;
							const sessionIsIdle = activeSession.state !== 'busy' && !isAutoRunActive;

							const queuedItem: QueuedItem = {
								id: generateId(),
								timestamp: Date.now(),
								tabId: activeTab?.id || activeSession.activeTabId,
								type: 'command',
								command: matchingCustomCommand.command,
								commandDescription: matchingCustomCommand.description,
								tabName:
									activeTab?.name ||
									(activeTab?.agentSessionId
										? activeTab.agentSessionId.split('-')[0].toUpperCase()
										: 'New'),
								readOnlyMode: isReadOnlyMode,
							};

							// If session is idle, we need to set up state and process immediately
							// If session is busy, just add to queue - it will be processed when current item finishes
							if (sessionIsIdle) {
								// Set up session and tab state for immediate processing
								// NOTE: Don't add to executionQueue when processing immediately - it's not actually queued,
								// and adding it would cause duplicate display (once as sent message, once in queue section)
								setSessions((prev) =>
									prev.map((s) => {
										if (s.id !== activeSessionId) return s;

										// Set the target tab to busy
										const updatedAiTabs = s.aiTabs.map((tab) =>
											tab.id === queuedItem.tabId
												? { ...tab, state: 'busy' as const, thinkingStartTime: Date.now() }
												: tab
										);

										return {
											...s,
											state: 'busy' as SessionState,
											busySource: 'ai',
											thinkingStartTime: Date.now(),
											currentCycleTokens: 0,
											currentCycleBytes: 0,
											aiTabs: updatedAiTabs,
											// Don't add to queue - we're processing immediately, not queuing
											aiCommandHistory: Array.from(
												new Set([...(s.aiCommandHistory || []), commandText])
											).slice(-50),
										};
									})
								);

								// Process immediately after state is set up
								// 50ms delay allows React to flush the setState above, ensuring the session
								// is marked 'busy' before processQueuedItem runs (prevents duplicate processing)
								setTimeout(() => {
									processQueuedItemRef.current?.(activeSessionId, queuedItem);
								}, 50);
							} else {
								// Session is busy - just add to queue
								setSessions((prev) =>
									prev.map((s) => {
										if (s.id !== activeSessionId) return s;
										return {
											...s,
											executionQueue: [...s.executionQueue, queuedItem],
											aiCommandHistory: Array.from(
												new Set([...(s.aiCommandHistory || []), commandText])
											).slice(-50),
										};
									})
								);
							}
							// Note: Input already cleared synchronously before this async block
						})();
						return;
					}
				}
			}

			const currentMode = activeSession.inputMode;

			// Handle wizard mode - route messages to wizard sendMessage instead of normal AI processing
			// This allows the wizard to have its own conversation without affecting the regular AI queue
			if (currentMode === 'ai' && isWizardActive && onWizardSendMessage) {
				// Don't allow slash commands in wizard mode (except /wizard which ends/restarts it)
				if (
					effectiveInputValue.trim().startsWith('/') &&
					!effectiveInputValue.trim().startsWith('/wizard')
				) {
					// Ignore slash commands in wizard mode
					console.log(
						'[processInput] Ignoring slash command in wizard mode:',
						effectiveInputValue.trim()
					);
					return;
				}

				// Clear input
				setInputValue('');
				setStagedImages([]);
				syncAiInputToSession('');
				if (inputRef.current) inputRef.current.style.height = 'auto';

				// Send to wizard
				onWizardSendMessage(effectiveInputValue).catch((error) => {
					console.error('[processInput] Wizard message failed:', error);
				});
				return;
			}

			// Queue messages when AI is busy (only in AI mode)
			// For read-only mode tabs: only queue if THIS TAB is busy (allows parallel execution)
			// For write mode tabs: queue if ANY tab in session is busy (prevents conflicts)
			// EXCEPTION: Write commands can bypass the queue and run in parallel if ALL busy tabs
			// and ALL queued items are read-only
			if (currentMode === 'ai') {
				const activeTab = getActiveTab(activeSession);
				const isReadOnlyMode = activeTab?.readOnlyMode === true;

				// Check if write command can bypass queue (all running/queued items are read-only)
				const canWriteBypassQueue = (): boolean => {
					if (isReadOnlyMode) return false; // Only applies to write commands
					if (activeSession.state !== 'busy') return false; // Nothing to bypass

					// Check all busy tabs are in read-only mode
					const busyTabs = activeSession.aiTabs.filter((tab) => tab.state === 'busy');
					const allBusyTabsReadOnly = busyTabs.every((tab) => tab.readOnlyMode === true);
					if (!allBusyTabsReadOnly) return false;

					// Check all queued items are from read-only tabs
					const allQueuedReadOnly = activeSession.executionQueue.every(
						(item) => item.readOnlyMode === true
					);
					if (!allQueuedReadOnly) return false;

					return true;
				};

				// Check if AutoRun is active for this session
				// AutoRun runs batch operations in isolation (doesn't set session to busy),
				// so we need to explicitly check the batch state to prevent write conflicts
				const isAutoRunActive = getBatchState(activeSession.id).isRunning;

				// Determine if we should queue this message
				// Read-only tabs can run in parallel - only queue if this specific tab is busy
				// Write mode tabs must wait for any busy tab to finish
				// EXCEPTION: Write commands bypass queue when all running/queued items are read-only
				// ALSO: Always queue write commands when AutoRun is active (to prevent file conflicts)
				const shouldQueue = isReadOnlyMode
					? activeTab?.state === 'busy' // Read-only: only queue if THIS tab is busy
					: (activeSession.state === 'busy' && !canWriteBypassQueue()) || isAutoRunActive; // Write mode: queue if busy OR AutoRun active

				// Debug logging to diagnose queue issues
				console.log('[processInput] Queue decision:', {
					sessionId: activeSession.id.substring(0, 8),
					sessionState: activeSession.state,
					tabState: activeTab?.state,
					isReadOnlyMode,
					isAutoRunActive,
					shouldQueue,
					queueLength: activeSession.executionQueue.length,
				});

				if (shouldQueue) {
					const queuedItem: QueuedItem = {
						id: generateId(),
						timestamp: Date.now(),
						tabId: activeTab?.id || activeSession.activeTabId,
						type: 'message',
						text: effectiveInputValue,
						images: [...stagedImages],
						tabName:
							activeTab?.name ||
							(activeTab?.agentSessionId
								? activeTab.agentSessionId.split('-')[0].toUpperCase()
								: 'New'),
						readOnlyMode: isReadOnlyMode,
					};

					// Add to queue - will be processed when:
					// - Auto Run completes (via onProcessQueueAfterCompletion callback)
					// - Current agent task completes (via onExit handler)
					// Note: We intentionally do NOT process immediately even if session is idle,
					// because when Auto Run is active, write-mode messages should wait for Auto Run
					// to complete to prevent file conflicts.
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== activeSessionId) return s;
							return {
								...s,
								executionQueue: [...s.executionQueue, queuedItem],
							};
						})
					);

					// Clear input
					setInputValue('');
					setStagedImages([]);
					syncAiInputToSession(''); // Sync empty value to session state
					if (inputRef.current) inputRef.current.style.height = 'auto';
					return;
				}
			}

			// Check if we're in read-only mode for the log entry (tab setting OR Auto Run without worktree)
			const activeTabForEntry = currentMode === 'ai' ? getActiveTab(activeSession) : null;
			const currentBatchState = getBatchState(activeSession.id);
			const isAutoRunReadOnly = currentBatchState.isRunning && !currentBatchState.worktreeActive;
			const isReadOnlyEntry = activeTabForEntry?.readOnlyMode === true || isAutoRunReadOnly;

			const newEntry: LogEntry = {
				id: generateId(),
				timestamp: Date.now(),
				source: 'user',
				text: effectiveInputValue,
				images: [...stagedImages],
				...(isReadOnlyEntry && { readOnly: true }),
			};

			// Track shell CWD changes when in terminal mode
			// For SSH sessions, use remoteCwd; for local sessions, use shellCwd
			// Check both sshRemoteId (set after spawn) and sessionSshRemoteConfig.enabled (set before spawn)
			const isRemoteSession =
				!!activeSession.sshRemoteId || !!activeSession.sessionSshRemoteConfig?.enabled;
			let newShellCwd = activeSession.shellCwd || activeSession.cwd;
			let newRemoteCwd = activeSession.remoteCwd;
			let cwdChanged = false;
			let remoteCwdChanged = false;
			if (currentMode === 'terminal') {
				const trimmedInput = effectiveInputValue.trim();
				// Get the current CWD based on whether this is a remote or local session
				const currentCwd = isRemoteSession
					? activeSession.remoteCwd ||
						activeSession.sessionSshRemoteConfig?.workingDirOverride ||
						activeSession.cwd
					: activeSession.shellCwd || activeSession.cwd;

				// Handle bare "cd" command - go to session's original directory (or remote working dir for SSH)
				if (trimmedInput === 'cd') {
					if (isRemoteSession) {
						// For remote sessions, bare cd goes to the session's configured working directory
						remoteCwdChanged = true;
						newRemoteCwd =
							activeSession.sessionSshRemoteConfig?.workingDirOverride || activeSession.cwd;
					} else {
						cwdChanged = true;
						newShellCwd = activeSession.cwd;
					}
				}
				const cdMatch = trimmedInput.match(/^cd\s+(.+)$/);
				if (cdMatch) {
					const targetPath = cdMatch[1].trim().replace(/^['"]|['"]$/g, ''); // Remove quotes
					let candidatePath: string;
					if (targetPath === '~' || targetPath.startsWith('~/')) {
						// For remote sessions, ~ should expand to session's base directory
						if (isRemoteSession) {
							const basePath =
								activeSession.sessionSshRemoteConfig?.workingDirOverride || activeSession.cwd;
							if (targetPath === '~') {
								candidatePath = basePath;
							} else {
								// ~/subpath
								const subPath = targetPath.slice(2); // Remove ~/
								candidatePath = basePath + (basePath.endsWith('/') ? '' : '/') + subPath;
							}
						} else {
							// Local: navigate to session's original directory
							if (targetPath === '~') {
								candidatePath = activeSession.cwd;
							} else {
								candidatePath =
									activeSession.cwd +
									(activeSession.cwd.endsWith('/') ? '' : '/') +
									targetPath.slice(2);
							}
						}
					} else if (targetPath.startsWith('/')) {
						// Absolute path
						candidatePath = targetPath;
					} else if (targetPath === '..') {
						// Go up one directory
						const parts = currentCwd.split('/').filter(Boolean);
						parts.pop();
						candidatePath = '/' + parts.join('/');
					} else if (targetPath.startsWith('../')) {
						// Relative path going up
						const parts = currentCwd.split('/').filter(Boolean);
						const upCount = targetPath.split('/').filter((p) => p === '..').length;
						for (let i = 0; i < upCount; i++) parts.pop();
						const remainingPath = targetPath
							.split('/')
							.filter((p) => p !== '..')
							.join('/');
						candidatePath = '/' + [...parts, ...remainingPath.split('/').filter(Boolean)].join('/');
					} else {
						// Relative path going down
						candidatePath = currentCwd + (currentCwd.endsWith('/') ? '' : '/') + targetPath;
					}

					// Verify the directory exists before updating CWD
					// Pass SSH remote ID for remote sessions - use sessionSshRemoteConfig.remoteId as fallback
					// because sshRemoteId is only set after AI agent spawns, not for terminal-only SSH sessions
					const sshIdForVerify =
						activeSession.sshRemoteId ||
						activeSession.sessionSshRemoteConfig?.remoteId ||
						undefined;
					try {
						await window.maestro.fs.readDir(candidatePath, sshIdForVerify);
						// Directory exists, update the appropriate CWD
						if (isRemoteSession) {
							remoteCwdChanged = true;
							newRemoteCwd = candidatePath;
						} else {
							cwdChanged = true;
							newShellCwd = candidatePath;
						}
					} catch {
						// Directory doesn't exist, keep the current CWD
						// The shell will show its own error message
					}
				}
			}

			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSessionId) return s;

					// Add command to history (separate histories for AI and terminal modes)
					const historyKey = currentMode === 'ai' ? 'aiCommandHistory' : 'shellCommandHistory';
					const currentHistory =
						currentMode === 'ai' ? s.aiCommandHistory || [] : s.shellCommandHistory || [];
					const newHistory = [...currentHistory];
					if (
						effectiveInputValue.trim() &&
						(newHistory.length === 0 ||
							newHistory[newHistory.length - 1] !== effectiveInputValue.trim())
					) {
						newHistory.push(effectiveInputValue.trim());
					}

					// For terminal mode, add to shellLogs
					if (currentMode !== 'ai') {
						return {
							...s,
							shellLogs: [...s.shellLogs, newEntry],
							state: 'busy',
							busySource: currentMode,
							shellCwd: newShellCwd,
							// Update remoteCwd for SSH sessions when cd command changes directory
							...(remoteCwdChanged && newRemoteCwd && { remoteCwd: newRemoteCwd }),
							[historyKey]: newHistory,
						};
					}

					// For AI mode, add to ACTIVE TAB's logs
					const activeTab = getActiveTab(s);
					if (!activeTab) {
						// No tabs exist - this is a bug, sessions must have aiTabs
						console.error(
							'[processInput] No active tab found - session has no aiTabs, this should not happen'
						);
						return s;
					}

					// Update the active tab's logs and state to 'busy' for write-mode tracking
					// Also mark as awaitingSessionId if this is a new session (no agentSessionId yet)
					// Set thinkingStartTime on the tab for accurate elapsed time tracking (especially for parallel tabs)
					const isNewSession = !activeTab.agentSessionId;
					const updatedAiTabs = s.aiTabs.map((tab) =>
						tab.id === activeTab.id
							? {
									...tab,
									logs: [...tab.logs, newEntry],
									state: 'busy' as const,
									thinkingStartTime: Date.now(),
									// Mark this tab as awaiting session ID so we can assign it correctly
									// when the session ID comes back (prevents cross-tab assignment)
									awaitingSessionId: isNewSession ? true : tab.awaitingSessionId,
								}
							: tab
					);

					return {
						...s,
						state: 'busy',
						busySource: currentMode,
						thinkingStartTime: Date.now(),
						currentCycleTokens: 0,
						// Context usage is now exclusively updated from agent-reported usage stats
						// Remove artificial +5 increment that was causing erroneous 100% detection
						shellCwd: newShellCwd,
						[historyKey]: newHistory,
						aiTabs: updatedAiTabs,
					};
				})
			);

			// If directory changed, check if new directory is a Git repository
			// For remote sessions, check remoteCwd; for local sessions, check shellCwd
			if (cwdChanged || remoteCwdChanged) {
				(async () => {
					const cwdToCheck = remoteCwdChanged && newRemoteCwd ? newRemoteCwd : newShellCwd;
					// Use sessionSshRemoteConfig.remoteId as fallback for terminal-only SSH sessions
					const sshIdForGit =
						activeSession.sshRemoteId ||
						activeSession.sessionSshRemoteConfig?.remoteId ||
						undefined;
					const isGitRepo = await gitService.isRepo(cwdToCheck, sshIdForGit);
					setSessions((prev) =>
						prev.map((s) => (s.id === activeSessionId ? { ...s, isGitRepo } : s))
					);
				})();
			}

			// Capture input value and images before clearing (needed for async batch mode spawn)
			// Append nudge message if present (only for interactive AI messages, not Auto Run)
			// The nudge is invisible in the UI - only sent to the agent
			const nudgeMessage = activeSession.nudgeMessage;
			const capturedInputValue =
				nudgeMessage && currentMode === 'ai'
					? `${effectiveInputValue}\n\n---\n\n${nudgeMessage}`
					: effectiveInputValue;
			const capturedImages = [...stagedImages];

			// Broadcast user input to web clients so they stay in sync
			// Use effectiveInputValue (without nudge) since nudge should be hidden from UI
			window.maestro.web.broadcastUserInput(activeSession.id, effectiveInputValue, currentMode);

			setInputValue('');
			setStagedImages([]);

			// Sync empty value to session state (prevents stale input restoration on blur)
			if (isAiMode) {
				syncAiInputToSession('');
			} else {
				syncTerminalInputToSession('');
			}

			// Reset height
			if (inputRef.current) inputRef.current.style.height = 'auto';

			// Write to the appropriate process based on inputMode
			// Each session has TWO processes: AI agent and terminal
			const targetPid = currentMode === 'ai' ? activeSession.aiPid : activeSession.terminalPid;
			// For batch mode (Claude), include tab ID in session ID to prevent process collision
			// This ensures each tab's process has a unique identifier
			const activeTabForSpawn = getActiveTab(activeSession);
			const targetSessionId =
				currentMode === 'ai'
					? `${activeSession.id}-ai-${activeTabForSpawn?.id || 'default'}`
					: `${activeSession.id}-terminal`;

			// Check if this is an AI agent in batch mode (e.g., Claude Code, OpenCode, Codex, Factory Droid)
			// Batch mode agents spawn a new process per message rather than writing to stdin
			const isBatchModeAgent =
				currentMode === 'ai' &&
				(activeSession.toolType === 'claude' ||
					activeSession.toolType === 'claude-code' ||
					activeSession.toolType === 'opencode' ||
					activeSession.toolType === 'codex' ||
					activeSession.toolType === 'factory-droid');

			if (isBatchModeAgent) {
				// Batch mode: Spawn new agent process with prompt
				(async () => {
					try {
						// Get agent configuration
						const agent = await window.maestro.agents.get(activeSession.toolType);
						if (!agent) throw new Error(`${activeSession.toolType} agent not found`);

						// IMPORTANT: Get fresh session state from ref to avoid stale closure bug
						// If user switches tabs quickly, activeSession from closure may have wrong activeTabId
						const freshSession = sessionsRef.current.find((s) => s.id === activeSessionId);
						if (!freshSession) throw new Error('Session not found');

						// Use the ACTIVE TAB's agentSessionId (not the deprecated session-level one)
						const freshActiveTab = getActiveTab(freshSession);
						const tabAgentSessionId = freshActiveTab?.agentSessionId;
						// Check CURRENT session's Auto Run state (not any session's) and respect worktree bypass
						const currentSessionBatchState = getBatchState(activeSessionId);
						const isAutoRunReadOnly =
							currentSessionBatchState.isRunning && !currentSessionBatchState.worktreeActive;
						const isReadOnly = isAutoRunReadOnly || freshActiveTab?.readOnlyMode;

						// For read-only mode, filter out any YOLO/skip-permissions flags from base args
						// (they would override the read-only mode we're requesting)
						// - Claude Code: --dangerously-skip-permissions
						// - Codex: --dangerously-bypass-approvals-and-sandbox
						const baseArgs = agent.args ?? [];
						const spawnArgs = isReadOnly
							? baseArgs.filter(
									(arg) =>
										arg !== '--dangerously-skip-permissions' &&
										arg !== '--dangerously-bypass-approvals-and-sandbox'
								)
							: [...baseArgs];

						// Use agent.path (full path) if available, otherwise fall back to agent.command
						const commandToUse = agent.path || agent.command;

						// If user sends only an image without text, inject the default image-only prompt
						const hasImages = capturedImages.length > 0;
						const hasNoText = !capturedInputValue.trim();
						let effectivePrompt =
							hasImages && hasNoText ? DEFAULT_IMAGE_ONLY_PROMPT : capturedInputValue;

						// For read-only mode, append instruction to return plan in response instead of writing files
						if (isReadOnly) {
							effectivePrompt +=
								'\n\n---\n\nIMPORTANT: You are in read-only/plan mode. Do NOT write a plan file. Instead, return your plan directly to the user in beautiful markdown formatting.';
						}

						// Check for pending merged context that needs to be injected
						// This happens when a user merged context from another tab/session
						const pendingMergedContext = freshActiveTab?.pendingMergedContext;
						if (pendingMergedContext) {
							// Prepend the merged context to the user's message
							effectivePrompt = `${pendingMergedContext}\n\n---\n\n${effectivePrompt}`;

							// Clear the pending merged context from the tab
							setSessions((prev) =>
								prev.map((s) => {
									if (s.id !== activeSessionId) return s;
									return {
										...s,
										aiTabs: s.aiTabs.map((tab) =>
											tab.id === freshActiveTab.id
												? { ...tab, pendingMergedContext: undefined }
												: tab
										),
									};
								})
							);

							console.log('[InputProcessing] Injected merged context into message:', {
								contextLength: pendingMergedContext.length,
								promptLength: effectivePrompt.length,
							});
						}

						// For NEW sessions (no agentSessionId), prepend Maestro system prompt
						// This introduces Maestro and sets directory restrictions for the agent
						const isNewSession = !tabAgentSessionId;
						if (isNewSession && maestroSystemPrompt) {
							// Get git branch for template substitution
							let gitBranch: string | undefined;
							if (freshSession.isGitRepo) {
								try {
									const status = await gitService.getStatus(freshSession.cwd);
									gitBranch = status.branch;
								} catch {
									// Ignore git errors
								}
							}

							// Get history file path for task recall
							let historyFilePath: string | undefined;
							try {
								historyFilePath =
									(await window.maestro.history.getFilePath(freshSession.id)) || undefined;
							} catch {
								// Ignore history errors
							}

							// Substitute template variables in the system prompt
							console.log('[useInputProcessing] Template substitution context:', {
								sessionId: freshSession.id,
								sessionName: freshSession.name,
								autoRunFolderPath: freshSession.autoRunFolderPath,
								fullPath: freshSession.fullPath,
								cwd: freshSession.cwd,
								parentSessionId: freshSession.parentSessionId,
								historyFilePath,
							});
							const substitutedSystemPrompt = substituteTemplateVariables(maestroSystemPrompt, {
								session: freshSession,
								gitBranch,
								historyFilePath,
							});

							// Prepend system prompt to user's message
							effectivePrompt = `${substitutedSystemPrompt}\n\n---\n\n# User Request\n\n${effectivePrompt}`;
						}

						// Spawn agent with generic config - the main process will use agent-specific
						// argument builders (resumeArgs, readOnlyArgs, etc.) to construct the final args
						await window.maestro.process.spawn({
							sessionId: targetSessionId,
							toolType: freshSession.toolType,
							cwd: freshSession.cwd,
							command: commandToUse,
							args: spawnArgs,
							prompt: effectivePrompt,
							images: hasImages ? capturedImages : undefined,
							// Generic spawn options - main process builds agent-specific args
							agentSessionId: tabAgentSessionId ?? undefined,
							readOnlyMode: isReadOnly,
							// Per-session config overrides (if set)
							sessionCustomPath: freshSession.customPath,
							sessionCustomArgs: freshSession.customArgs,
							sessionCustomEnvVars: freshSession.customEnvVars,
							sessionCustomModel: freshSession.customModel,
							sessionCustomContextWindow: freshSession.customContextWindow,
							// Per-session SSH remote config (takes precedence over agent-level SSH config)
							sessionSshRemoteConfig: freshSession.sessionSshRemoteConfig,
						});
					} catch (error) {
						console.error('Failed to spawn agent batch process:', error);
						const errorLog: LogEntry = {
							id: generateId(),
							timestamp: Date.now(),
							source: 'system',
							text: `Error: Failed to spawn agent process - ${(error as Error).message}`,
						};
						setSessions((prev) =>
							prev.map((s) => {
								if (s.id !== activeSessionId) return s;
								// Reset active tab's state to 'idle' and add error log
								const updatedAiTabs =
									s.aiTabs?.length > 0
										? s.aiTabs.map((tab) =>
												tab.id === s.activeTabId
													? {
															...tab,
															state: 'idle' as const,
															thinkingStartTime: undefined,
															logs: [...tab.logs, errorLog],
														}
													: tab
											)
										: s.aiTabs;
								return {
									...s,
									state: 'idle',
									busySource: undefined,
									thinkingStartTime: undefined,
									aiTabs: updatedAiTabs,
								};
							})
						);
					}
				})();
			} else if (currentMode === 'terminal') {
				// Intercept "clear" command to clear shell logs instead of sending to shell
				const trimmedCommand = capturedInputValue.trim();
				if (trimmedCommand === 'clear') {
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== activeSessionId) return s;
							return {
								...s,
								state: 'idle',
								busySource: undefined,
								thinkingStartTime: undefined,
								shellLogs: [],
							};
						})
					);
					return;
				}

				// Terminal mode: Use runCommand for clean stdout/stderr capture (no PTY noise)
				// This spawns a fresh shell with -l -c to run the command, ensuring aliases work
				// When SSH is enabled for the session, the command runs on the remote host
				// For SSH sessions, use remoteCwd (updated by cd commands); for local, use shellCwd
				const isRemote =
					!!activeSession.sshRemoteId || !!activeSession.sessionSshRemoteConfig?.enabled;
				const commandCwd = isRemote
					? activeSession.remoteCwd ||
						activeSession.sessionSshRemoteConfig?.workingDirOverride ||
						activeSession.cwd
					: activeSession.shellCwd || activeSession.cwd;
				window.maestro.process
					.runCommand({
						sessionId: activeSession.id, // Plain session ID (not suffixed)
						command: capturedInputValue,
						cwd: commandCwd,
						// Pass SSH config if the session has SSH enabled
						sessionSshRemoteConfig: activeSession.sessionSshRemoteConfig,
					})
					.catch((error) => {
						console.error('Failed to run command:', error);
						setSessions((prev) =>
							prev.map((s) => {
								if (s.id !== activeSessionId) return s;
								return {
									...s,
									state: 'idle',
									busySource: undefined,
									thinkingStartTime: undefined,
									shellLogs: [
										...s.shellLogs,
										{
											id: generateId(),
											timestamp: Date.now(),
											source: 'system',
											text: `Error: Failed to run command - ${(error as Error).message}`,
										},
									],
								};
							})
						);
					});
			} else if (targetPid > 0) {
				// AI mode: Write to stdin
				window.maestro.process.write(targetSessionId, capturedInputValue).catch((error) => {
					console.error('Failed to write to process:', error);
					const errorLog: LogEntry = {
						id: generateId(),
						timestamp: Date.now(),
						source: 'system',
						text: `Error: Failed to write to process - ${(error as Error).message}`,
					};
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== activeSessionId) return s;
							// Reset active tab's state to 'idle' and add error log
							const updatedAiTabs =
								s.aiTabs?.length > 0
									? s.aiTabs.map((tab) =>
											tab.id === s.activeTabId
												? {
														...tab,
														state: 'idle' as const,
														thinkingStartTime: undefined,
														logs: [...tab.logs, errorLog],
													}
												: tab
										)
									: s.aiTabs;
							return {
								...s,
								state: 'idle',
								busySource: undefined,
								thinkingStartTime: undefined,
								aiTabs: updatedAiTabs,
							};
						})
					);
				});
			}
		},
		[
			activeSession,
			activeSessionId,
			inputValue,
			stagedImages,
			customAICommands,
			setInputValue,
			setStagedImages,
			setSlashCommandOpen,
			syncAiInputToSession,
			syncTerminalInputToSession,
			isAiMode,
			inputRef,
			sessionsRef,
			getBatchState,
			processQueuedItemRef,
			setSessions,
			flushBatchedUpdates,
			onHistoryCommand,
			onWizardCommand,
		]
	);

	// Update ref for external access
	processInputRef.current = processInput;

	return {
		processInput,
		processInputRef,
	};
}
