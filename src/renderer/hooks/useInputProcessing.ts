import { useCallback, useRef } from 'react';
import type { Session, SessionState, LogEntry, QueuedItem, AITab, CustomAICommand } from '../types';
import { getActiveTab } from '../utils/tabHelpers';
import { generateId } from '../utils/ids';
import { substituteTemplateVariables } from '../utils/templateVariables';
import { gitService } from '../services/git';

/**
 * Default prompt used when user sends only an image without text.
 */
export const DEFAULT_IMAGE_ONLY_PROMPT =
  'Examine the attached picture and best determine based on available and existing context, what the user wants done next.';

/**
 * Batch state information for a session.
 */
export interface BatchState {
  isRunning: boolean;
  isPaused?: boolean;
  currentFile?: string;
  totalFiles?: number;
  completedFiles?: number;
}

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
  processQueuedItemRef: React.MutableRefObject<((sessionId: string, item: QueuedItem) => Promise<void>) | null>;
}

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
    activeBatchRunState,
    processQueuedItemRef,
  } = deps;

  // Ref for the processInput function so external code can access the latest version
  const processInputRef = useRef<((overrideInputValue?: string) => Promise<void>) | null>(null);

  /**
   * Process user input - handles slash commands, queuing, and message sending.
   */
  const processInput = useCallback(async (overrideInputValue?: string) => {
    const effectiveInputValue = overrideInputValue ?? inputValue;
    console.log('[processInput] Called with:', {
      overrideInputValue,
      inputValue,
      effectiveInputValue,
      activeSessionId: activeSession?.id,
      inputMode: activeSession?.inputMode,
      stagedImagesCount: stagedImages.length,
    });
    if (!activeSession || (!effectiveInputValue.trim() && stagedImages.length === 0)) {
      console.log('[processInput] Early return - no session or empty input');
      return;
    }

    // Handle slash commands (custom AI commands only - built-in commands have been removed)
    // Note: slash commands are queued like regular messages when agent is busy
    if (effectiveInputValue.trim().startsWith('/')) {
      const commandText = effectiveInputValue.trim();
      const isTerminalMode = activeSession.inputMode === 'terminal';

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
            const substitutedPrompt = substituteTemplateVariables(matchingCustomCommand.prompt, {
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
                (activeTab?.claudeSessionId ? activeTab.claudeSessionId.split('-')[0].toUpperCase() : 'New'),
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
            (activeTab?.claudeSessionId ? activeTab.claudeSessionId.split('-')[0].toUpperCase() : 'New'),
          readOnlyMode: isReadOnlyMode,
        };

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

    // Check if we're in read-only mode for the log entry
    const activeTabForEntry = currentMode === 'ai' ? getActiveTab(activeSession) : null;
    const isReadOnlyEntry = activeTabForEntry?.readOnlyMode === true;

    const newEntry: LogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      source: 'user',
      text: effectiveInputValue,
      images: [...stagedImages],
      ...(isReadOnlyEntry && { readOnly: true }),
    };

    // Track shell CWD changes when in terminal mode
    let newShellCwd = activeSession.shellCwd;
    let cwdChanged = false;
    if (currentMode === 'terminal') {
      const trimmedInput = effectiveInputValue.trim();
      // Handle bare "cd" command - go to session's original directory
      if (trimmedInput === 'cd') {
        cwdChanged = true;
        newShellCwd = activeSession.cwd;
      }
      const cdMatch = trimmedInput.match(/^cd\s+(.+)$/);
      if (cdMatch) {
        const targetPath = cdMatch[1].trim().replace(/^['"]|['"]$/g, ''); // Remove quotes
        let candidatePath: string;
        if (targetPath === '~') {
          // Navigate to session's original directory
          candidatePath = activeSession.cwd;
        } else if (targetPath.startsWith('/')) {
          // Absolute path
          candidatePath = targetPath;
        } else if (targetPath === '..') {
          // Go up one directory
          const parts = newShellCwd.split('/').filter(Boolean);
          parts.pop();
          candidatePath = '/' + parts.join('/');
        } else if (targetPath.startsWith('../')) {
          // Relative path going up
          const parts = newShellCwd.split('/').filter(Boolean);
          const upCount = targetPath.split('/').filter((p) => p === '..').length;
          for (let i = 0; i < upCount; i++) parts.pop();
          const remainingPath = targetPath
            .split('/')
            .filter((p) => p !== '..')
            .join('/');
          candidatePath = '/' + [...parts, ...remainingPath.split('/').filter(Boolean)].join('/');
        } else {
          // Relative path going down
          candidatePath = newShellCwd + (newShellCwd.endsWith('/') ? '' : '/') + targetPath;
        }

        // Verify the directory exists before updating shellCwd
        try {
          await window.maestro.fs.readDir(candidatePath);
          // Directory exists, update shellCwd
          cwdChanged = true;
          newShellCwd = candidatePath;
        } catch {
          // Directory doesn't exist, keep the current shellCwd
          // The shell will show its own error message
          console.log(
            `[processInput] cd target "${candidatePath}" does not exist, keeping current cwd`
          );
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
          (newHistory.length === 0 || newHistory[newHistory.length - 1] !== effectiveInputValue.trim())
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
        // Also mark as awaitingSessionId if this is a new session (no claudeSessionId yet)
        // Set thinkingStartTime on the tab for accurate elapsed time tracking (especially for parallel tabs)
        const isNewSession = !activeTab.claudeSessionId;
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
          contextUsage: Math.min(s.contextUsage + 5, 100),
          shellCwd: newShellCwd,
          [historyKey]: newHistory,
          aiTabs: updatedAiTabs,
        };
      })
    );

    // If directory changed, check if new directory is a Git repository
    if (cwdChanged) {
      (async () => {
        const isGitRepo = await gitService.isRepo(newShellCwd);
        setSessions((prev) =>
          prev.map((s) => (s.id === activeSessionId ? { ...s, isGitRepo } : s))
        );
      })();
    }

    // Capture input value and images before clearing (needed for async batch mode spawn)
    const capturedInputValue = effectiveInputValue;
    const capturedImages = [...stagedImages];

    // Broadcast user input to web clients so they stay in sync
    window.maestro.web.broadcastUserInput(activeSession.id, capturedInputValue, currentMode);

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

    // Check if this is Claude Code in batch mode (AI mode with claude/claude-code tool)
    const isClaudeBatchMode =
      currentMode === 'ai' &&
      (activeSession.toolType === 'claude' || activeSession.toolType === 'claude-code');

    if (isClaudeBatchMode) {
      // Batch mode: Spawn new Claude process with prompt
      (async () => {
        try {
          // Get agent configuration
          const agent = await window.maestro.agents.get('claude-code');
          if (!agent) throw new Error('Claude Code agent not found');

          // IMPORTANT: Get fresh session state from ref to avoid stale closure bug
          // If user switches tabs quickly, activeSession from closure may have wrong activeTabId
          const freshSession = sessionsRef.current.find((s) => s.id === activeSessionId);
          if (!freshSession) throw new Error('Session not found');

          // Build spawn args with resume if we have a session ID
          // Use the ACTIVE TAB's claudeSessionId (not the deprecated session-level one)
          const freshActiveTab = getActiveTab(freshSession);
          const tabClaudeSessionId = freshActiveTab?.claudeSessionId;
          const isNewSession = !tabClaudeSessionId;
          const isReadOnly = activeBatchRunState.isRunning || freshActiveTab?.readOnlyMode;

          // Filter out --dangerously-skip-permissions when read-only mode is active
          // (it would override --permission-mode plan)
          const spawnArgs = isReadOnly
            ? agent.args.filter((arg) => arg !== '--dangerously-skip-permissions')
            : [...agent.args];

          if (tabClaudeSessionId) {
            spawnArgs.push('--resume', tabClaudeSessionId);
          }

          // Add read-only/plan mode when auto mode is active OR tab has readOnlyMode enabled
          if (isReadOnly) {
            spawnArgs.push('--permission-mode', 'plan');
          }

          // Spawn Claude with prompt as argument (use captured value)
          // If images are present, they will be passed via stream-json input format
          // Use agent.path (full path) if available, otherwise fall back to agent.command
          const commandToUse = agent.path || agent.command;

          // If user sends only an image without text, inject the default image-only prompt
          const hasImages = capturedImages.length > 0;
          const hasNoText = !capturedInputValue.trim();
          const effectivePrompt =
            hasImages && hasNoText ? DEFAULT_IMAGE_ONLY_PROMPT : capturedInputValue;

          await window.maestro.process.spawn({
            sessionId: targetSessionId,
            toolType: 'claude-code',
            cwd: freshSession.cwd,
            command: commandToUse,
            args: spawnArgs,
            prompt: effectivePrompt,
            images: hasImages ? capturedImages : undefined,
          });
        } catch (error) {
          console.error('Failed to spawn Claude batch process:', error);
          const errorLog: LogEntry = {
            id: generateId(),
            timestamp: Date.now(),
            source: 'system',
            text: `Error: Failed to spawn Claude process - ${(error as Error).message}`,
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
      // Terminal mode: Use runCommand for clean stdout/stderr capture (no PTY noise)
      // This spawns a fresh shell with -l -c to run the command, ensuring aliases work
      window.maestro.process
        .runCommand({
          sessionId: activeSession.id, // Plain session ID (not suffixed)
          command: capturedInputValue,
          cwd: activeSession.shellCwd || activeSession.cwd,
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
  }, [
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
    activeBatchRunState,
    processQueuedItemRef,
    setSessions,
  ]);

  // Update ref for external access
  processInputRef.current = processInput;

  return {
    processInput,
    processInputRef,
  };
}
