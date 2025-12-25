import { useState, useCallback, useRef, useReducer } from 'react';
import type { BatchRunState, BatchRunConfig, Session, HistoryEntry, UsageStats, Group, AutoRunStats, AgentError, ToolType } from '../types';
import { getBadgeForTime, getNextBadge, formatTimeRemaining } from '../constants/conductorBadges';
import { formatElapsedTime } from '../../shared/formatters';
import { gitService } from '../services/git';
// Extracted batch processing modules
import {
  countUnfinishedTasks,
  uncheckAllTasks,
  useSessionDebounce,
  batchReducer,
  DEFAULT_BATCH_STATE,
  useTimeTracking,
  useWorktreeManager,
  useDocumentProcessor,
} from './batch';

// Debounce delay for batch state updates (Quick Win 1)
const BATCH_STATE_DEBOUNCE_MS = 200;

// Regex to match checked markdown checkboxes for reset-on-completion
// Matches both [x] and [X] with various checkbox formats (standard and GitHub-style)
// Note: countUnfinishedTasks, countCheckedTasks, uncheckAllTasks are now imported from ./batch/batchUtils

interface BatchCompleteInfo {
  sessionId: string;
  sessionName: string;
  completedTasks: number;
  totalTasks: number;
  wasStopped: boolean;
  elapsedTimeMs: number;
}

interface PRResultInfo {
  sessionId: string;
  sessionName: string;
  success: boolean;
  prUrl?: string;
  error?: string;
}

interface UseBatchProcessorProps {
  sessions: Session[];
  groups: Group[];
  onUpdateSession: (sessionId: string, updates: Partial<Session>) => void;
  onSpawnAgent: (sessionId: string, prompt: string, cwdOverride?: string) => Promise<{ success: boolean; response?: string; agentSessionId?: string; usageStats?: UsageStats }>;
  onSpawnSynopsis: (sessionId: string, cwd: string, agentSessionId: string, prompt: string, toolType?: ToolType) => Promise<{ success: boolean; response?: string }>;
  onAddHistoryEntry: (entry: Omit<HistoryEntry, 'id'>) => void | Promise<void>;
  onComplete?: (info: BatchCompleteInfo) => void;
  // Callback for PR creation results (success or failure)
  onPRResult?: (info: PRResultInfo) => void;
  // TTS settings for speaking synopsis after each task
  audioFeedbackEnabled?: boolean;
  audioFeedbackCommand?: string;
  // Auto Run stats for achievement progress in final summary
  autoRunStats?: AutoRunStats;
}

interface UseBatchProcessorReturn {
  // Map of session ID to batch state
  batchRunStates: Record<string, BatchRunState>;
  // Get batch state for a specific session
  getBatchState: (sessionId: string) => BatchRunState;
  // Check if any session has an active batch
  hasAnyActiveBatch: boolean;
  // Get list of session IDs with active batches
  activeBatchSessionIds: string[];
  // Start batch run for a specific session with multi-document support
  startBatchRun: (sessionId: string, config: BatchRunConfig, folderPath: string) => Promise<void>;
  // Stop batch run for a specific session
  stopBatchRun: (sessionId: string) => void;
  // Custom prompts per session
  customPrompts: Record<string, string>;
  setCustomPrompt: (sessionId: string, prompt: string) => void;
  // Error handling (Phase 5.10)
  pauseBatchOnError: (sessionId: string, error: AgentError, documentIndex: number, taskDescription?: string) => void;
  skipCurrentDocument: (sessionId: string) => void;
  resumeAfterError: (sessionId: string) => void;
  abortBatchOnError: (sessionId: string) => void;
}

type ErrorResolutionAction = 'resume' | 'skip-document' | 'abort';

interface ErrorResolutionEntry {
  promise: Promise<ErrorResolutionAction>;
  resolve: (action: ErrorResolutionAction) => void;
}


/**
 * Create a loop summary history entry
 */
interface LoopSummaryParams {
  loopIteration: number;
  loopTasksCompleted: number;
  loopStartTime: number;
  loopTotalInputTokens: number;
  loopTotalOutputTokens: number;
  loopTotalCost: number;
  sessionCwd: string;
  sessionId: string;
  isFinal: boolean;
  exitReason?: string;
}

function createLoopSummaryEntry(params: LoopSummaryParams): Omit<HistoryEntry, 'id'> {
  const {
    loopIteration,
    loopTasksCompleted,
    loopStartTime,
    loopTotalInputTokens,
    loopTotalOutputTokens,
    loopTotalCost,
    sessionCwd,
    sessionId,
    isFinal,
    exitReason
  } = params;

  const loopElapsedMs = Date.now() - loopStartTime;
  const loopNumber = loopIteration + 1;
  const summaryPrefix = isFinal ? `Loop ${loopNumber} (final)` : `Loop ${loopNumber}`;
  const loopSummary = `${summaryPrefix} completed: ${loopTasksCompleted} task${loopTasksCompleted !== 1 ? 's' : ''} accomplished`;

  const loopDetails = [
    `**${summaryPrefix} Summary**`,
    '',
    `- **Tasks Accomplished:** ${loopTasksCompleted}`,
    `- **Duration:** ${formatElapsedTime(loopElapsedMs)}`,
    loopTotalInputTokens > 0 || loopTotalOutputTokens > 0
      ? `- **Tokens:** ${(loopTotalInputTokens + loopTotalOutputTokens).toLocaleString()} (${loopTotalInputTokens.toLocaleString()} in / ${loopTotalOutputTokens.toLocaleString()} out)`
      : '',
    loopTotalCost > 0 ? `- **Cost:** $${loopTotalCost.toFixed(4)}` : '',
    exitReason ? `- **Exit Reason:** ${exitReason}` : '',
  ].filter(line => line !== '').join('\n');

  return {
    type: 'AUTO',
    timestamp: Date.now(),
    summary: loopSummary,
    fullResponse: loopDetails,
    projectPath: sessionCwd,
    sessionId: sessionId,
    success: true,
    elapsedTimeMs: loopElapsedMs,
    usageStats: loopTotalInputTokens > 0 || loopTotalOutputTokens > 0 ? {
      inputTokens: loopTotalInputTokens,
      outputTokens: loopTotalOutputTokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: loopTotalCost,
      contextWindow: 0
    } : undefined
  };
}

// Re-export utility functions for backwards compatibility
// (countUnfinishedTasks and uncheckAllTasks are imported from ./batch/batchUtils)
export { countUnfinishedTasks, uncheckAllTasks };

/**
 * Hook for managing batch processing of scratchpad tasks across multiple sessions
 */
export function useBatchProcessor({
  sessions,
  groups,
  onUpdateSession,
  onSpawnAgent,
  onSpawnSynopsis,
  onAddHistoryEntry,
  onComplete,
  onPRResult,
  audioFeedbackEnabled,
  audioFeedbackCommand,
  autoRunStats
}: UseBatchProcessorProps): UseBatchProcessorReturn {
  // Batch states per session using reducer pattern for predictable state transitions
  const [batchRunStates, dispatch] = useReducer(batchReducer, {});

  // Custom prompts per session
  const [customPrompts, setCustomPrompts] = useState<Record<string, string>>({});

  // Refs for tracking stop requests per session
  const stopRequestedRefs = useRef<Record<string, boolean>>({});

  // Ref to always have access to latest sessions (fixes stale closure in startBatchRun)
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Ref to track latest batchRunStates for time tracking callback
  const batchRunStatesRef = useRef(batchRunStates);
  batchRunStatesRef.current = batchRunStates;

  // Error resolution promises to pause batch processing until user action (per session)
  const errorResolutionRefs = useRef<Record<string, ErrorResolutionEntry>>({});

  /**
   * Broadcast Auto Run state to web interface immediately (synchronously).
   * This replaces the previous useEffect-based approach to ensure mobile clients
   * receive state updates without waiting for React's render cycle.
   */
  const broadcastAutoRunState = useCallback((sessionId: string, state: BatchRunState | null) => {
    if (state && (state.isRunning || state.completedTasks > 0)) {
      window.maestro.web.broadcastAutoRunState(sessionId, {
        isRunning: state.isRunning,
        totalTasks: state.totalTasks,
        completedTasks: state.completedTasks,
        currentTaskIndex: state.currentTaskIndex,
        isStopping: state.isStopping,
      });
    } else {
      // When not running and no completed tasks, broadcast null to clear the state
      window.maestro.web.broadcastAutoRunState(sessionId, null);
    }
  }, []);

  // Use extracted debounce hook for batch state updates (replaces manual debounce logic)
  const { scheduleUpdate: scheduleDebouncedUpdate } = useSessionDebounce<Record<string, BatchRunState>>({
    delayMs: BATCH_STATE_DEBOUNCE_MS,
    onUpdate: useCallback((sessionId: string, updater: (prev: Record<string, BatchRunState>) => Record<string, BatchRunState>) => {
      // Apply the updater and get the new state for broadcasting
      // Note: We use a ref to capture the new state since dispatch doesn't return it
      let newStateForSession: BatchRunState | null = null;

      // For reducer, we need to convert the updater to an action
      // Since the updater pattern doesn't map directly to actions, we wrap it
      // by reading current state and computing the new state
      const currentState = batchRunStatesRef.current;
      const newState = updater(currentState);
      newStateForSession = newState[sessionId] || null;

      // Dispatch UPDATE_PROGRESS with the computed changes
      // For complex state changes, we extract the session's new state and dispatch appropriately
      if (newStateForSession) {
        const prevSessionState = currentState[sessionId] || DEFAULT_BATCH_STATE;

        // Dispatch UPDATE_PROGRESS with any changed fields
        dispatch({
          type: 'UPDATE_PROGRESS',
          sessionId,
          payload: {
            currentDocumentIndex: newStateForSession.currentDocumentIndex !== prevSessionState.currentDocumentIndex ? newStateForSession.currentDocumentIndex : undefined,
            currentDocTasksTotal: newStateForSession.currentDocTasksTotal !== prevSessionState.currentDocTasksTotal ? newStateForSession.currentDocTasksTotal : undefined,
            currentDocTasksCompleted: newStateForSession.currentDocTasksCompleted !== prevSessionState.currentDocTasksCompleted ? newStateForSession.currentDocTasksCompleted : undefined,
            totalTasksAcrossAllDocs: newStateForSession.totalTasksAcrossAllDocs !== prevSessionState.totalTasksAcrossAllDocs ? newStateForSession.totalTasksAcrossAllDocs : undefined,
            completedTasksAcrossAllDocs: newStateForSession.completedTasksAcrossAllDocs !== prevSessionState.completedTasksAcrossAllDocs ? newStateForSession.completedTasksAcrossAllDocs : undefined,
            totalTasks: newStateForSession.totalTasks !== prevSessionState.totalTasks ? newStateForSession.totalTasks : undefined,
            completedTasks: newStateForSession.completedTasks !== prevSessionState.completedTasks ? newStateForSession.completedTasks : undefined,
            currentTaskIndex: newStateForSession.currentTaskIndex !== prevSessionState.currentTaskIndex ? newStateForSession.currentTaskIndex : undefined,
            sessionIds: newStateForSession.sessionIds !== prevSessionState.sessionIds ? newStateForSession.sessionIds : undefined,
            accumulatedElapsedMs: newStateForSession.accumulatedElapsedMs !== prevSessionState.accumulatedElapsedMs ? newStateForSession.accumulatedElapsedMs : undefined,
            lastActiveTimestamp: newStateForSession.lastActiveTimestamp !== prevSessionState.lastActiveTimestamp ? newStateForSession.lastActiveTimestamp : undefined,
            loopIteration: newStateForSession.loopIteration !== prevSessionState.loopIteration ? newStateForSession.loopIteration : undefined,
          }
        });
      }

      broadcastAutoRunState(sessionId, newStateForSession);
    }, [broadcastAutoRunState])
  });

  // Use extracted time tracking hook (replaces manual visibility-based time tracking)
  const timeTracking = useTimeTracking({
    getActiveSessionIds: useCallback(() => {
      return Object.entries(batchRunStatesRef.current)
        .filter(([_, state]) => state.isRunning)
        .map(([sessionId]) => sessionId);
    }, []),
    onTimeUpdate: useCallback((sessionId: string, accumulatedMs: number, activeTimestamp: number | null) => {
      // Update batch state with new time tracking values
      dispatch({
        type: 'UPDATE_PROGRESS',
        sessionId,
        payload: {
          accumulatedElapsedMs: accumulatedMs,
          lastActiveTimestamp: activeTimestamp ?? undefined
        }
      });
    }, [])
  });

  // Use extracted worktree manager hook for git worktree operations
  const worktreeManager = useWorktreeManager();

  // Use extracted document processor hook for document processing
  const documentProcessor = useDocumentProcessor();

  // Helper to get batch state for a session
  const getBatchState = useCallback((sessionId: string): BatchRunState => {
    return batchRunStates[sessionId] || DEFAULT_BATCH_STATE;
  }, [batchRunStates]);

  // Check if any session has an active batch
  const hasAnyActiveBatch = Object.values(batchRunStates).some(state => state.isRunning);

  // Get list of session IDs with active batches
  const activeBatchSessionIds = Object.entries(batchRunStates)
    .filter(([_, state]) => state.isRunning)
    .map(([sessionId]) => sessionId);

  // Set custom prompt for a session
  const setCustomPrompt = useCallback((sessionId: string, prompt: string) => {
    setCustomPrompts(prev => ({ ...prev, [sessionId]: prompt }));
  }, []);

  /**
   * Update batch state AND broadcast to web interface with debouncing.
   * This wrapper uses the extracted useSessionDebounce hook to batch rapid-fire
   * state updates and reduce React re-renders during intensive task processing.
   *
   * Critical updates (isRunning changes, errors) are processed immediately,
   * while progress updates are debounced by BATCH_STATE_DEBOUNCE_MS.
   */
  const updateBatchStateAndBroadcast = useCallback((
    sessionId: string,
    updater: (prev: Record<string, BatchRunState>) => Record<string, BatchRunState>,
    immediate: boolean = false
  ) => {
    scheduleDebouncedUpdate(sessionId, updater, immediate);
  }, [scheduleDebouncedUpdate])

  // Use readDocAndCountTasks from the extracted documentProcessor hook
  // This replaces the previous inline helper function
  const readDocAndCountTasks = documentProcessor.readDocAndCountTasks;

  /**
   * Start a batch processing run for a specific session with multi-document support
   */
  const startBatchRun = useCallback(async (sessionId: string, config: BatchRunConfig, folderPath: string) => {
    console.log('[BatchProcessor] startBatchRun called:', { sessionId, folderPath, config });
    window.maestro.logger.log('info', 'startBatchRun called', 'BatchProcessor', { sessionId, folderPath, documentsCount: config.documents.length, worktreeEnabled: config.worktree?.enabled });

    // Use sessionsRef to get latest sessions (handles case where session was just created)
    const session = sessionsRef.current.find(s => s.id === sessionId);
    if (!session) {
      console.error('[BatchProcessor] Session not found for batch processing:', sessionId);
      window.maestro.logger.log('error', 'Session not found for batch processing', 'BatchProcessor', { sessionId });
      return;
    }

    const { documents, prompt, loopEnabled, maxLoops, worktree } = config;
    console.log('[BatchProcessor] Config parsed - documents:', documents.length, 'loopEnabled:', loopEnabled, 'maxLoops:', maxLoops);

    if (documents.length === 0) {
      console.warn('[BatchProcessor] No documents provided for batch processing:', sessionId);
      window.maestro.logger.log('warn', 'No documents provided for batch processing', 'BatchProcessor', { sessionId });
      return;
    }

    // Debug log: show document configuration
    console.log('[BatchProcessor] Starting batch with documents:', documents.map(d => ({
      filename: d.filename,
      resetOnCompletion: d.resetOnCompletion
    })));

    // Track batch start time for completion notification
    const batchStartTime = Date.now();

    // Initialize visibility-based time tracking for this session using the extracted hook
    timeTracking.startTracking(sessionId);

    // Reset stop flag for this session
    stopRequestedRefs.current[sessionId] = false;
    delete errorResolutionRefs.current[sessionId];

    // Set up worktree if enabled using extracted hook
    const worktreeResult = await worktreeManager.setupWorktree(session.cwd, worktree);
    if (!worktreeResult.success) {
      console.error('[BatchProcessor] Worktree setup failed:', worktreeResult.error);
      return;
    }

    const { effectiveCwd, worktreeActive, worktreePath, worktreeBranch } = worktreeResult;

    // Get git branch for template variable substitution
    let gitBranch: string | undefined;
    if (session.isGitRepo) {
      try {
        const status = await gitService.getStatus(effectiveCwd);
        gitBranch = status.branch;
      } catch {
        // Ignore git errors - branch will be empty string
      }
    }

    // Find group name for this session (sessions have groupId, groups have id)
    const sessionGroup = session.groupId ? groups.find(g => g.id === session.groupId) : null;
    const groupName = sessionGroup?.name;

    // Calculate initial total tasks across all documents
    let initialTotalTasks = 0;
    for (const doc of documents) {
      const { taskCount } = await readDocAndCountTasks(folderPath, doc.filename);
      console.log(`[BatchProcessor] Document ${doc.filename}: ${taskCount} tasks`);
      initialTotalTasks += taskCount;
    }
    console.log(`[BatchProcessor] Initial total tasks: ${initialTotalTasks}`);

    if (initialTotalTasks === 0) {
      console.warn('No unchecked tasks found across all documents for session:', sessionId);
      return;
    }

    // Initialize batch run state using START_BATCH action directly
    // (not updateBatchStateAndBroadcast which only supports UPDATE_PROGRESS)
    const lockedDocuments = documents.map(d => d.filename);
    dispatch({
      type: 'START_BATCH',
      sessionId,
      payload: {
        documents: documents.map(d => d.filename),
        lockedDocuments,
        totalTasksAcrossAllDocs: initialTotalTasks,
        loopEnabled,
        maxLoops,
        folderPath,
        worktreeActive,
        worktreePath,
        worktreeBranch,
        customPrompt: prompt !== '' ? prompt : undefined,
        startTime: batchStartTime,
        // Time tracking
        cumulativeTaskTimeMs: 0, // Sum of actual task durations (most accurate)
        accumulatedElapsedMs: 0, // Visibility-based time (excludes sleep/suspend)
        lastActiveTimestamp: batchStartTime
      }
    });
    // Broadcast state change
    broadcastAutoRunState(sessionId, {
      isRunning: true,
      isStopping: false,
      documents: documents.map(d => d.filename),
      lockedDocuments,
      currentDocumentIndex: 0,
      currentDocTasksTotal: 0,
      currentDocTasksCompleted: 0,
      totalTasksAcrossAllDocs: initialTotalTasks,
      completedTasksAcrossAllDocs: 0,
      loopEnabled,
      loopIteration: 0,
      maxLoops,
      folderPath,
      worktreeActive,
      worktreePath,
      worktreeBranch,
      totalTasks: initialTotalTasks,
      completedTasks: 0,
      currentTaskIndex: 0,
      originalContent: '',
      customPrompt: prompt !== '' ? prompt : undefined,
      sessionIds: [],
      startTime: batchStartTime,
      accumulatedElapsedMs: 0,
      lastActiveTimestamp: batchStartTime,
    });

    // AUTORUN LOG: Start
    try {
      console.log('[AUTORUN] Logging start event - calling window.maestro.logger.autorun');
      window.maestro.logger.autorun(
        `Auto Run started`,
        session.name,
        {
          documents: documents.map(d => d.filename),
          totalTasks: initialTotalTasks,
          loopEnabled,
          maxLoops: maxLoops ?? 'unlimited'
        }
      );
      console.log('[AUTORUN] Start event logged successfully');
    } catch (err) {
      console.error('[AUTORUN] Error logging start event:', err);
    }

    // Add initial history entry when using worktree
    if (worktreeActive && worktreePath && worktreeBranch) {
      const worktreeStartSummary = `Auto Run started in worktree`;
      const worktreeStartDetails = [
        `**Worktree Auto Run Started**`,
        ``,
        `- **Branch:** \`${worktreeBranch}\``,
        `- **Worktree Path:** \`${worktreePath}\``,
        `- **Main Repo:** \`${session.cwd}\``,
        `- **Documents:** ${documents.map(d => d.filename).join(', ')}`,
        `- **Total Tasks:** ${initialTotalTasks}`,
        loopEnabled ? `- **Loop Mode:** Enabled${maxLoops ? ` (max ${maxLoops})` : ''}` : '',
      ].filter(line => line !== '').join('\n');

      onAddHistoryEntry({
        type: 'AUTO',
        timestamp: Date.now(),
        summary: worktreeStartSummary,
        fullResponse: worktreeStartDetails,
        projectPath: effectiveCwd,
        sessionId: sessionId,
        success: true,
      });
    }

    // Store custom prompt for persistence
    setCustomPrompts(prev => ({ ...prev, [sessionId]: prompt }));

    // Collect Claude session IDs and track completion
    const agentSessionIds: string[] = [];
    let totalCompletedTasks = 0;
    let loopIteration = 0;

    // Per-loop tracking for loop summary
    let loopStartTime = Date.now();
    let loopTasksCompleted = 0;
    let loopTotalInputTokens = 0;
    let loopTotalOutputTokens = 0;
    let loopTotalCost = 0;

    // Cumulative tracking for final Auto Run summary (across all loops)
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;

    // Track consecutive runs where document content didn't change to detect stalling
    // If the document hash is identical before/after a run (and no tasks checked), the LLM is stuck
    // Note: This counter is reset per-document, so stalling one document doesn't affect others
    let consecutiveNoChangeCount = 0;
    const MAX_CONSECUTIVE_NO_CHANGES = 2; // Skip document after 2 consecutive runs with no changes

    // Track stalled documents (document filename -> stall reason)
    const stalledDocuments: Map<string, string> = new Map();

    // Track which reset documents have active backups (for cleanup on interruption)
    const activeBackups: Set<string> = new Set();

    // Track the current document being processed (for interruption handling)
    let currentResetDocFilename: string | null = null;

    // Helper to clean up all backups
    const cleanupBackups = async () => {
      if (activeBackups.size > 0) {
        console.log(`[BatchProcessor] Cleaning up ${activeBackups.size} backup(s)`);
        try {
          await window.maestro.autorun.deleteBackups(folderPath);
          activeBackups.clear();
        } catch (err) {
          console.error('[BatchProcessor] Failed to clean up backups:', err);
        }
      }
    };

    // Helper to restore current reset doc and clean up (for interruption)
    const handleInterruptionCleanup = async () => {
      // If we were mid-processing a reset doc, restore it to original state
      if (currentResetDocFilename) {
        console.log(`[BatchProcessor] Restoring interrupted reset document: ${currentResetDocFilename}`);

        // Find the document entry to check if it's reset-on-completion
        const docEntry = documents.find(d => d.filename === currentResetDocFilename);
        const isResetOnCompletion = docEntry?.resetOnCompletion ?? false;

        if (isResetOnCompletion) {
          // Try to restore from backup first
          if (activeBackups.has(currentResetDocFilename)) {
            try {
              await window.maestro.autorun.restoreBackup(folderPath, currentResetDocFilename);
              activeBackups.delete(currentResetDocFilename);
              console.log(`[BatchProcessor] Restored ${currentResetDocFilename} from backup`);
            } catch (err) {
              console.error(`[BatchProcessor] Failed to restore backup for ${currentResetDocFilename}, falling back to uncheckAllTasks:`, err);
              // Fallback: uncheck all tasks in the document
              try {
                const { content } = await readDocAndCountTasks(folderPath, currentResetDocFilename);
                if (content) {
                  const resetContent = uncheckAllTasks(content);
                  await window.maestro.autorun.writeDoc(folderPath, currentResetDocFilename + '.md', resetContent);
                  console.log(`[BatchProcessor] Reset ${currentResetDocFilename} by unchecking all tasks`);
                }
              } catch (resetErr) {
                console.error(`[BatchProcessor] Failed to reset ${currentResetDocFilename}:`, resetErr);
              }
            }
          } else {
            // No backup available - use uncheckAllTasks to reset
            console.log(`[BatchProcessor] No backup for ${currentResetDocFilename}, using uncheckAllTasks`);
            try {
              const { content } = await readDocAndCountTasks(folderPath, currentResetDocFilename);
              if (content) {
                const resetContent = uncheckAllTasks(content);
                await window.maestro.autorun.writeDoc(folderPath, currentResetDocFilename + '.md', resetContent);
                console.log(`[BatchProcessor] Reset ${currentResetDocFilename} by unchecking all tasks`);
              }
            } catch (err) {
              console.error(`[BatchProcessor] Failed to reset ${currentResetDocFilename}:`, err);
            }
          }
        }
      }
      // Clean up any remaining backups
      await cleanupBackups();
    };

    // Helper to add final loop summary (defined here so it has access to tracking vars)
    const addFinalLoopSummary = (exitReason: string) => {
      // AUTORUN LOG: Exit
      window.maestro.logger.autorun(
        `Auto Run exiting: ${exitReason}`,
        session.name,
        {
          reason: exitReason,
          totalTasksCompleted: totalCompletedTasks,
          loopsCompleted: loopIteration + 1
        }
      );

      if (loopEnabled && (loopTasksCompleted > 0 || loopIteration > 0)) {
        onAddHistoryEntry(createLoopSummaryEntry({
          loopIteration,
          loopTasksCompleted,
          loopStartTime,
          loopTotalInputTokens,
          loopTotalOutputTokens,
          loopTotalCost,
          sessionCwd: session.cwd,
          sessionId,
          isFinal: true,
          exitReason
        }));
      }
    };

    // Main processing loop (handles loop mode)
    while (true) {
      // Check for stop request
      if (stopRequestedRefs.current[sessionId]) {
        console.log('[BatchProcessor] Batch run stopped by user for session:', sessionId);
        addFinalLoopSummary('Stopped by user');
        break;
      }

      // Track if any tasks were processed in this iteration
      let anyTasksProcessedThisIteration = false;
      // Track tasks completed in non-reset documents this iteration
      // This is critical for loop mode: if only reset docs have tasks, we'd loop forever
      let tasksCompletedInNonResetDocs = 0;

      // Process each document in order
      for (let docIndex = 0; docIndex < documents.length; docIndex++) {
        // Check for stop request before each document
        if (stopRequestedRefs.current[sessionId]) {
          console.log('[BatchProcessor] Batch run stopped by user at document', docIndex, 'for session:', sessionId);
          break;
        }

        const docEntry = documents[docIndex];

        // Read document and count tasks
        let { taskCount: remainingTasks, content: docContent, checkedCount: docCheckedCount } = await readDocAndCountTasks(folderPath, docEntry.filename);
        let docTasksTotal = remainingTasks;

        // Handle documents with no unchecked tasks
        if (remainingTasks === 0) {
          // For reset-on-completion documents, check if there are checked tasks that need resetting
          if (docEntry.resetOnCompletion && loopEnabled) {
            // Use docCheckedCount from readDocAndCountTasks instead of calling countCheckedTasks again
            if (docCheckedCount > 0) {
              console.log(`[BatchProcessor] Document ${docEntry.filename} has ${docCheckedCount} checked tasks - resetting for next iteration`);
              const resetContent = uncheckAllTasks(docContent);
              await window.maestro.autorun.writeDoc(folderPath, docEntry.filename + '.md', resetContent);
              // Update task count in state
              const resetTaskCount = countUnfinishedTasks(resetContent);
              updateBatchStateAndBroadcast(sessionId, prev => ({
                ...prev,
                [sessionId]: {
                  ...prev[sessionId],
                  totalTasksAcrossAllDocs: prev[sessionId].totalTasksAcrossAllDocs + resetTaskCount,
                  totalTasks: prev[sessionId].totalTasks + resetTaskCount
                }
              }));
            }
          }
          console.log(`[BatchProcessor] Skipping document ${docEntry.filename} - no unchecked tasks`);
          continue;
        }

        // Reset stall detection counter for each new document
        consecutiveNoChangeCount = 0;

        // Create backup for reset-on-completion documents before processing
        if (docEntry.resetOnCompletion) {
          console.log(`[BatchProcessor] Creating backup for reset document: ${docEntry.filename}`);
          try {
            await window.maestro.autorun.createBackup(folderPath, docEntry.filename);
            activeBackups.add(docEntry.filename);
            currentResetDocFilename = docEntry.filename;
          } catch (err) {
            console.error(`[BatchProcessor] Failed to create backup for ${docEntry.filename}:`, err);
            // Continue without backup - will fall back to uncheckAllTasks behavior
          }
        }

        console.log(`[BatchProcessor] Processing document ${docEntry.filename} with ${remainingTasks} tasks`);

        // AUTORUN LOG: Document processing
        window.maestro.logger.autorun(
          `Processing document: ${docEntry.filename}`,
          session.name,
          {
            document: docEntry.filename,
            tasksRemaining: remainingTasks,
            loopNumber: loopIteration + 1
          }
        );

        // Update state to show current document
        updateBatchStateAndBroadcast(sessionId, prev => ({
          ...prev,
          [sessionId]: {
            ...prev[sessionId],
            currentDocumentIndex: docIndex,
            currentDocTasksTotal: docTasksTotal,
            currentDocTasksCompleted: 0
          }
        }));

        let docTasksCompleted = 0;
        let skipCurrentDocumentAfterError = false;

        // Process tasks in this document until none remain
        while (remainingTasks > 0) {
          // Check for stop request before each task
          if (stopRequestedRefs.current[sessionId]) {
            console.log('[BatchProcessor] Batch run stopped by user during document', docEntry.filename);
            break;
          }

          // Pause processing until the user resolves the error state
          const errorResolution = errorResolutionRefs.current[sessionId];
          if (errorResolution) {
            const action = await errorResolution.promise;
            delete errorResolutionRefs.current[sessionId];

            if (action === 'abort') {
              stopRequestedRefs.current[sessionId] = true;
              break;
            }

            if (action === 'skip-document') {
              skipCurrentDocumentAfterError = true;
              break;
            }
          }

          // Use extracted document processor hook for task processing
          // This handles: template substitution, document expansion, agent spawning,
          // session registration, re-reading document, and synopsis generation
          try {
            const taskResult = await documentProcessor.processTask(
              {
                folderPath,
                session,
                gitBranch,
                groupName,
                loopIteration: loopIteration + 1, // 1-indexed
                effectiveCwd,
                customPrompt: prompt,
              },
              docEntry.filename,
              docCheckedCount,
              remainingTasks,
              docContent,
              {
                onSpawnAgent,
                onSpawnSynopsis,
              }
            );

            // Track agent session IDs
            if (taskResult.agentSessionId) {
              agentSessionIds.push(taskResult.agentSessionId);
            }

            anyTasksProcessedThisIteration = true;

            // Extract results from processTask
            const {
              tasksCompletedThisRun,
              addedUncheckedTasks,
              newRemainingTasks,
              documentChanged,
              newCheckedCount,
              shortSummary,
              fullSynopsis,
              usageStats,
              elapsedTimeMs,
              agentSessionId,
              success,
            } = taskResult;

            // Detect stalling: if document content is unchanged and no tasks were checked off
            if (!documentChanged && tasksCompletedThisRun === 0) {
              consecutiveNoChangeCount++;
              console.log(`[BatchProcessor] Document unchanged, no tasks completed (${consecutiveNoChangeCount}/${MAX_CONSECUTIVE_NO_CHANGES} consecutive)`);
            } else {
              // Reset counter on any document change or task completion
              consecutiveNoChangeCount = 0;
            }

            // Update counters
            docTasksCompleted += tasksCompletedThisRun;
            totalCompletedTasks += tasksCompletedThisRun;
            loopTasksCompleted += tasksCompletedThisRun;

            // Track token usage for loop summary and cumulative totals
            if (usageStats) {
              loopTotalInputTokens += usageStats.inputTokens || 0;
              loopTotalOutputTokens += usageStats.outputTokens || 0;
              loopTotalCost += usageStats.totalCostUsd || 0;
              // Also track cumulative totals for final summary
              totalInputTokens += usageStats.inputTokens || 0;
              totalOutputTokens += usageStats.outputTokens || 0;
              totalCost += usageStats.totalCostUsd || 0;
            }

            // Track non-reset document completions for loop exit logic
            if (!docEntry.resetOnCompletion) {
              tasksCompletedInNonResetDocs += tasksCompletedThisRun;
            }

            // Update progress state
            if (addedUncheckedTasks > 0) {
              docTasksTotal += addedUncheckedTasks;
            }

            updateBatchStateAndBroadcast(sessionId, prev => {
              const prevState = prev[sessionId] || DEFAULT_BATCH_STATE;
              const nextTotalAcrossAllDocs = Math.max(0, prevState.totalTasksAcrossAllDocs + addedUncheckedTasks);
              const nextTotalTasks = Math.max(0, prevState.totalTasks + addedUncheckedTasks);
              return {
                ...prev,
                [sessionId]: {
                  ...prevState,
                  currentDocTasksCompleted: docTasksCompleted,
                  currentDocTasksTotal: docTasksTotal,
                  completedTasksAcrossAllDocs: totalCompletedTasks,
                  totalTasksAcrossAllDocs: nextTotalAcrossAllDocs,
                  // Accumulate actual task duration (most accurate work time tracking)
                  cumulativeTaskTimeMs: (prevState.cumulativeTaskTimeMs || 0) + elapsedTimeMs,
                  // Legacy fields
                  completedTasks: totalCompletedTasks,
                  totalTasks: nextTotalTasks,
                  currentTaskIndex: totalCompletedTasks,
                  sessionIds: [...(prevState?.sessionIds || []), agentSessionId || '']
                }
              };
            });

            // Add history entry
            // Use effectiveCwd for projectPath so clicking the session link looks in the right place
            onAddHistoryEntry({
              type: 'AUTO',
              timestamp: Date.now(),
              summary: shortSummary,
              fullResponse: fullSynopsis,
              agentSessionId,
              projectPath: effectiveCwd,
              sessionId: sessionId,
              success,
              usageStats,
              elapsedTimeMs
            });

            // Speak the synopsis via TTS if audio feedback is enabled
            if (audioFeedbackEnabled && audioFeedbackCommand && shortSummary) {
              window.maestro.notification.speak(shortSummary, audioFeedbackCommand).catch(err => {
                console.error('[BatchProcessor] Failed to speak synopsis:', err);
              });
            }

            // Check if we've hit the stalling threshold for this document
            if (consecutiveNoChangeCount >= MAX_CONSECUTIVE_NO_CHANGES) {
              const stallReason = `${consecutiveNoChangeCount} consecutive runs with no progress`;
              console.warn(`[BatchProcessor] Document "${docEntry.filename}" stalled: ${stallReason}`);

              // Track this document as stalled
              stalledDocuments.set(docEntry.filename, stallReason);

              // AUTORUN LOG: Document stalled
              window.maestro.logger.autorun(
                `Document stalled: ${docEntry.filename}`,
                session.name,
                {
                  document: docEntry.filename,
                  reason: stallReason,
                  remainingTasks: newRemainingTasks,
                  loopNumber: loopIteration + 1
                }
              );

              // Add a history entry specifically for this stalled document
              const stallExplanation = [
                `**Document Stalled: ${docEntry.filename}**`,
                '',
                `The AI agent ran ${consecutiveNoChangeCount} times on this document but made no progress:`,
                `- No tasks were checked off`,
                `- No changes were made to the document content`,
                '',
                `**What this means:**`,
                `The remaining tasks in this document may be:`,
                `- Already complete (but not checked off)`,
                `- Unclear or ambiguous for the AI to act on`,
                `- Dependent on external factors or manual intervention`,
                `- Outside the scope of what the AI can accomplish`,
                '',
                `**Remaining unchecked tasks:** ${newRemainingTasks}`,
                '',
                documents.length > 1
                  ? `Skipping to the next document in the playbook...`
                  : `No more documents to process.`
              ].join('\n');

              onAddHistoryEntry({
                type: 'AUTO',
                timestamp: Date.now(),
                summary: `Document stalled: ${docEntry.filename} (${newRemainingTasks} tasks remaining)`,
                fullResponse: stallExplanation,
                projectPath: effectiveCwd,
                sessionId: sessionId,
                success: false,  // Mark as unsuccessful since we couldn't complete
              });

              // Skip to the next document instead of breaking the entire batch
              break; // Break out of the inner while loop for this document
            }

            docCheckedCount = newCheckedCount;
            remainingTasks = newRemainingTasks;
            docContent = taskResult.contentAfterTask;
            console.log(`[BatchProcessor] Document ${docEntry.filename}: ${remainingTasks} tasks remaining`);

          } catch (error) {
            console.error(`[BatchProcessor] Error running task in ${docEntry.filename} for session ${sessionId}:`, error);
            // Continue to next task on error
            remainingTasks--;
          }
        }

        // Check for stop request before doing reset (stalled documents are skipped, not stopped)
        if (stopRequestedRefs.current[sessionId]) {
          break;
        }

        // Skip document reset if this document stalled (it didn't complete normally)
        if (stalledDocuments.has(docEntry.filename)) {
          // If this was a reset doc that stalled, restore from backup
          if (docEntry.resetOnCompletion && activeBackups.has(docEntry.filename)) {
            console.log(`[BatchProcessor] Restoring stalled reset document: ${docEntry.filename}`);
            try {
              await window.maestro.autorun.restoreBackup(folderPath, docEntry.filename);
              activeBackups.delete(docEntry.filename);
            } catch (err) {
              console.error(`[BatchProcessor] Failed to restore backup for stalled doc ${docEntry.filename}:`, err);
            }
          }
          currentResetDocFilename = null;
          // Reset consecutive no-change counter for next document
          consecutiveNoChangeCount = 0;
          continue;
        }

        if (skipCurrentDocumentAfterError) {
          // If this was a reset doc that errored, restore from backup
          if (docEntry.resetOnCompletion && activeBackups.has(docEntry.filename)) {
            console.log(`[BatchProcessor] Restoring error-skipped reset document: ${docEntry.filename}`);
            try {
              await window.maestro.autorun.restoreBackup(folderPath, docEntry.filename);
              activeBackups.delete(docEntry.filename);
            } catch (err) {
              console.error(`[BatchProcessor] Failed to restore backup for errored doc ${docEntry.filename}:`, err);
            }
          }
          currentResetDocFilename = null;
          continue;
        }

        // Document complete - handle reset-on-completion if enabled
        console.log(`[BatchProcessor] Document ${docEntry.filename} complete. resetOnCompletion=${docEntry.resetOnCompletion}, docTasksCompleted=${docTasksCompleted}`);
        if (docEntry.resetOnCompletion && docTasksCompleted > 0) {
          console.log(`[BatchProcessor] Resetting document ${docEntry.filename} (reset-on-completion enabled)`);

          // AUTORUN LOG: Document reset
          window.maestro.logger.autorun(
            `Resetting document: ${docEntry.filename}`,
            session.name,
            {
              document: docEntry.filename,
              tasksCompleted: docTasksCompleted,
              loopNumber: loopIteration + 1
            }
          );

          // Restore from backup if available, otherwise fall back to uncheckAllTasks
          if (activeBackups.has(docEntry.filename)) {
            console.log(`[BatchProcessor] Restoring document ${docEntry.filename} from backup`);
            try {
              await window.maestro.autorun.restoreBackup(folderPath, docEntry.filename);
              activeBackups.delete(docEntry.filename);
              currentResetDocFilename = null;

              // Count tasks in restored content for loop mode
              if (loopEnabled) {
                const { taskCount: resetTaskCount } = await readDocAndCountTasks(folderPath, docEntry.filename);
                console.log(`[BatchProcessor] Restored document has ${resetTaskCount} tasks`);
                updateBatchStateAndBroadcast(sessionId, prev => ({
                  ...prev,
                  [sessionId]: {
                    ...prev[sessionId],
                    totalTasksAcrossAllDocs: prev[sessionId].totalTasksAcrossAllDocs + resetTaskCount,
                    totalTasks: prev[sessionId].totalTasks + resetTaskCount
                  }
                }));
              }
            } catch (err) {
              console.error(`[BatchProcessor] Failed to restore backup for ${docEntry.filename}, falling back to uncheckAllTasks:`, err);
              // Fall back to uncheckAllTasks behavior
              const { content: currentContent } = await readDocAndCountTasks(folderPath, docEntry.filename);
              const resetContent = uncheckAllTasks(currentContent);
              await window.maestro.autorun.writeDoc(folderPath, docEntry.filename + '.md', resetContent);
              activeBackups.delete(docEntry.filename);
              currentResetDocFilename = null;

              if (loopEnabled) {
                const resetTaskCount = countUnfinishedTasks(resetContent);
                updateBatchStateAndBroadcast(sessionId, prev => ({
                  ...prev,
                  [sessionId]: {
                    ...prev[sessionId],
                    totalTasksAcrossAllDocs: prev[sessionId].totalTasksAcrossAllDocs + resetTaskCount,
                    totalTasks: prev[sessionId].totalTasks + resetTaskCount
                  }
                }));
              }
            }
          } else {
            // No backup available - use legacy uncheckAllTasks behavior
            console.log(`[BatchProcessor] No backup found for ${docEntry.filename}, using uncheckAllTasks`);
            const { content: currentContent } = await readDocAndCountTasks(folderPath, docEntry.filename);
            const resetContent = uncheckAllTasks(currentContent);
            await window.maestro.autorun.writeDoc(folderPath, docEntry.filename + '.md', resetContent);

            if (loopEnabled) {
              const resetTaskCount = countUnfinishedTasks(resetContent);
              updateBatchStateAndBroadcast(sessionId, prev => ({
                ...prev,
                [sessionId]: {
                  ...prev[sessionId],
                  totalTasksAcrossAllDocs: prev[sessionId].totalTasksAcrossAllDocs + resetTaskCount,
                  totalTasks: prev[sessionId].totalTasks + resetTaskCount
                }
              }));
            }
          }
        } else if (docEntry.resetOnCompletion) {
          // Document had reset enabled but no tasks were completed - clean up backup
          if (activeBackups.has(docEntry.filename)) {
            console.log(`[BatchProcessor] Cleaning up unused backup for ${docEntry.filename}`);
            try {
              // Delete just this backup by restoring (which deletes) or we can just delete it
              // Actually, let's leave it for now and clean up at the end
            } catch {
              // Ignore errors
            }
          }
          currentResetDocFilename = null;
        }
      }

      // Note: We no longer break immediately when a document stalls.
      // Individual documents that stall are skipped, and we continue processing other documents.
      // The stalledDocuments map tracks which documents stalled for the final summary.

      // Check if we should continue looping
      if (!loopEnabled) {
        // No loop mode - we're done after one pass
        // AUTORUN LOG: Exit (non-loop mode)
        window.maestro.logger.autorun(
          `Auto Run completed (single pass)`,
          session.name,
          {
            reason: 'Single pass completed',
            totalTasksCompleted: totalCompletedTasks,
            loopsCompleted: 1
          }
        );
        break;
      }

      // Check if we've hit the max loop limit
      if (maxLoops !== null && maxLoops !== undefined && loopIteration + 1 >= maxLoops) {
        console.log(`[BatchProcessor] Reached max loop limit (${maxLoops}), exiting loop`);
        addFinalLoopSummary(`Reached max loop limit (${maxLoops})`);
        break;
      }

      // Check for stop request after full pass
      if (stopRequestedRefs.current[sessionId]) {
        addFinalLoopSummary('Stopped by user');
        break;
      }

      // Safety check: if we didn't process ANY tasks this iteration, exit to avoid infinite loop
      if (!anyTasksProcessedThisIteration) {
        console.warn('[BatchProcessor] No tasks processed this iteration - exiting to avoid infinite loop');
        addFinalLoopSummary('No tasks processed this iteration');
        break;
      }

      // Loop mode: check if we should continue looping
      // Check if there are any non-reset documents in the playbook
      const hasAnyNonResetDocs = documents.some(doc => !doc.resetOnCompletion);

      if (hasAnyNonResetDocs) {
        // If we have non-reset docs, only continue if they have remaining tasks
        let anyNonResetDocsHaveTasks = false;
        for (const doc of documents) {
          if (doc.resetOnCompletion) continue;

          const { taskCount } = await readDocAndCountTasks(folderPath, doc.filename);
          if (taskCount > 0) {
            anyNonResetDocsHaveTasks = true;
            break;
          }
        }

        if (!anyNonResetDocsHaveTasks) {
          console.log('[BatchProcessor] All non-reset documents completed, exiting loop');
          addFinalLoopSummary('All tasks completed');
          break;
        }
      }
      // If all documents are reset docs, we continue looping (maxLoops check above will stop us)

      // Re-scan all documents to get fresh task counts for next loop (tasks may have been added/removed)
      let newTotalTasks = 0;
      for (const doc of documents) {
        const { taskCount } = await readDocAndCountTasks(folderPath, doc.filename);
        newTotalTasks += taskCount;
      }

      // Calculate loop elapsed time
      const loopElapsedMs = Date.now() - loopStartTime;

      // Add loop summary history entry
      const loopSummary = `Loop ${loopIteration + 1} completed: ${loopTasksCompleted} task${loopTasksCompleted !== 1 ? 's' : ''} accomplished`;
      const loopDetails = [
        `**Loop ${loopIteration + 1} Summary**`,
        '',
        `- **Tasks Accomplished:** ${loopTasksCompleted}`,
        `- **Duration:** ${formatElapsedTime(loopElapsedMs)}`,
        loopTotalInputTokens > 0 || loopTotalOutputTokens > 0
          ? `- **Tokens:** ${(loopTotalInputTokens + loopTotalOutputTokens).toLocaleString()} (${loopTotalInputTokens.toLocaleString()} in / ${loopTotalOutputTokens.toLocaleString()} out)`
          : '',
        loopTotalCost > 0 ? `- **Cost:** $${loopTotalCost.toFixed(4)}` : '',
        `- **Tasks Discovered for Next Loop:** ${newTotalTasks}`,
      ].filter(line => line !== '').join('\n');

      onAddHistoryEntry({
        type: 'AUTO',
        timestamp: Date.now(),
        summary: loopSummary,
        fullResponse: loopDetails,
        projectPath: session.cwd,
        sessionId: sessionId,
        success: true,
        elapsedTimeMs: loopElapsedMs,
        usageStats: loopTotalInputTokens > 0 || loopTotalOutputTokens > 0 ? {
          inputTokens: loopTotalInputTokens,
          outputTokens: loopTotalOutputTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalCostUsd: loopTotalCost,
          contextWindow: 0
        } : undefined
      });

      // Reset per-loop tracking for next iteration
      loopStartTime = Date.now();
      loopTasksCompleted = 0;
      loopTotalInputTokens = 0;
      loopTotalOutputTokens = 0;
      loopTotalCost = 0;

      // AUTORUN LOG: Loop completion
      window.maestro.logger.autorun(
        `Loop ${loopIteration + 1} completed`,
        session.name,
        {
          loopNumber: loopIteration + 1,
          tasksCompleted: loopTasksCompleted,
          tasksForNextLoop: newTotalTasks
        }
      );

      // Continue looping
      loopIteration++;
      console.log(`[BatchProcessor] Starting loop iteration ${loopIteration + 1}: ${newTotalTasks} tasks across all documents`);

      updateBatchStateAndBroadcast(sessionId, prev => ({
        ...prev,
        [sessionId]: {
          ...prev[sessionId],
          loopIteration,
          totalTasksAcrossAllDocs: newTotalTasks + prev[sessionId].completedTasksAcrossAllDocs,
          totalTasks: newTotalTasks + prev[sessionId].completedTasks
        }
      }));
    }

    // Handle backup cleanup - if we were stopped mid-document, restore the reset doc first
    if (stopRequestedRefs.current[sessionId]) {
      await handleInterruptionCleanup();
    } else {
      // Normal completion - just clean up any remaining backups
      await cleanupBackups();
    }

    // Create PR if worktree was used, PR creation is enabled, and not stopped
    const wasStopped = stopRequestedRefs.current[sessionId] || false;
    const sessionName = session.name || session.cwd.split('/').pop() || 'Unknown';
    if (worktreeActive && worktree?.createPROnCompletion && !wasStopped && totalCompletedTasks > 0 && worktreePath) {
      const prResult = await worktreeManager.createPR({
        worktreePath,
        mainRepoCwd: session.cwd,
        worktree,
        documents,
        totalCompletedTasks,
      });

      if (onPRResult) {
        onPRResult({
          sessionId,
          sessionName,
          success: prResult.success,
          prUrl: prResult.prUrl,
          error: prResult.error,
        });
      }
    }

    // Add final Auto Run summary entry
    // Calculate visibility-aware elapsed time using the extracted time tracking hook
    // (excludes time when laptop was sleeping/suspended)
    const totalElapsedMs = timeTracking.getElapsedTime(sessionId);
    const loopsCompleted = loopEnabled ? loopIteration + 1 : 1;

    console.log('[BatchProcessor] Creating final Auto Run summary:', { sessionId, totalElapsedMs, totalCompletedTasks, stalledCount: stalledDocuments.size });

    // Determine status based on stalled documents and completion
    const stalledCount = stalledDocuments.size;
    const allDocsStalled = stalledCount === documents.length;
    const someDocsStalled = stalledCount > 0 && stalledCount < documents.length;
    const statusText = wasStopped
      ? 'stopped'
      : allDocsStalled
        ? 'stalled'
        : someDocsStalled
          ? 'completed with stalls'
          : 'completed';

    // Calculate achievement progress for the summary
    // Note: We use the stats BEFORE this run is recorded (the parent will call recordAutoRunComplete after)
    // So we need to add totalElapsedMs to get the projected cumulative time
    const projectedCumulativeTime = (autoRunStats?.cumulativeTimeMs || 0) + totalElapsedMs;
    const currentBadge = getBadgeForTime(projectedCumulativeTime);
    const nextBadge = getNextBadge(currentBadge);
    const levelProgressText = nextBadge
      ? `Level ${currentBadge?.level || 0} → ${nextBadge.level}: ${formatTimeRemaining(projectedCumulativeTime, nextBadge)}`
      : currentBadge
        ? `Level ${currentBadge.level} (${currentBadge.name}) - Maximum level achieved!`
        : 'Level 0 → 1: ' + formatTimeRemaining(0, getBadgeForTime(0));

    // Build summary with stall info if applicable
    const stalledSuffix = stalledCount > 0 ? ` (${stalledCount} stalled)` : '';
    const finalSummary = `Auto Run ${statusText}: ${totalCompletedTasks} task${totalCompletedTasks !== 1 ? 's' : ''} in ${formatElapsedTime(totalElapsedMs)}${stalledSuffix}`;

    // Build status message with detailed info
    let statusMessage: string;
    if (wasStopped) {
      statusMessage = 'Stopped by user';
    } else if (allDocsStalled) {
      statusMessage = `Stalled - All ${stalledCount} document(s) stopped making progress`;
    } else if (someDocsStalled) {
      statusMessage = `Completed with ${stalledCount} stalled document(s)`;
    } else {
      statusMessage = 'Completed';
    }

    // Build stalled documents section if any documents stalled
    const stalledDocsSection: string[] = [];
    if (stalledCount > 0) {
      stalledDocsSection.push('');
      stalledDocsSection.push('**Stalled Documents**');
      stalledDocsSection.push('');
      stalledDocsSection.push('The following documents stopped making progress after multiple attempts:');
      for (const [docName, reason] of stalledDocuments) {
        stalledDocsSection.push(`- **${docName}**: ${reason}`);
      }
      stalledDocsSection.push('');
      stalledDocsSection.push('*Tasks in stalled documents may need manual review or clarification.*');
    }

    const finalDetails = [
      `**Auto Run Summary**`,
      '',
      `- **Status:** ${statusMessage}`,
      `- **Tasks Completed:** ${totalCompletedTasks}`,
      `- **Total Duration:** ${formatElapsedTime(totalElapsedMs)}`,
      loopEnabled ? `- **Loops Completed:** ${loopsCompleted}` : '',
      totalInputTokens > 0 || totalOutputTokens > 0
        ? `- **Total Tokens:** ${(totalInputTokens + totalOutputTokens).toLocaleString()} (${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out)`
        : '',
      totalCost > 0 ? `- **Total Cost:** $${totalCost.toFixed(4)}` : '',
      '',
      `- **Documents:** ${documents.map(d => d.filename).join(', ')}`,
      ...stalledDocsSection,
      '',
      `**Achievement Progress**`,
      `- ${levelProgressText}`,
    ].filter(line => line !== '').join('\n');

    // Success is true if not stopped and at least some documents completed without stalling
    const isSuccess = !wasStopped && !allDocsStalled;

    try {
      await onAddHistoryEntry({
        type: 'AUTO',
        timestamp: Date.now(),
        summary: finalSummary,
        fullResponse: finalDetails,
        projectPath: session.cwd,
        sessionId, // Include sessionId so the summary appears in session's history
        success: isSuccess,
        elapsedTimeMs: totalElapsedMs,
        usageStats: totalInputTokens > 0 || totalOutputTokens > 0 ? {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalCostUsd: totalCost,
          contextWindow: 0
        } : undefined,
        achievementAction: 'openAbout'  // Enable clickable link to achievements panel
      });
      console.log('[BatchProcessor] Final Auto Run summary added to history successfully');
    } catch (historyError) {
      console.error('[BatchProcessor] Failed to add final Auto Run summary to history:', historyError);
    }

    // Reset state for this session using COMPLETE_BATCH action
    // (not updateBatchStateAndBroadcast which only supports UPDATE_PROGRESS)
    dispatch({
      type: 'COMPLETE_BATCH',
      sessionId,
      finalSessionIds: agentSessionIds
    });
    // Broadcast state change
    broadcastAutoRunState(sessionId, null);

    // Call completion callback if provided
    if (onComplete) {
      onComplete({
        sessionId,
        sessionName: session.name || session.cwd.split('/').pop() || 'Unknown',
        completedTasks: totalCompletedTasks,
        totalTasks: initialTotalTasks,
        wasStopped,
        elapsedTimeMs: totalElapsedMs
      });
    }

    // Clean up time tracking and error resolution
    timeTracking.stopTracking(sessionId);
    delete errorResolutionRefs.current[sessionId];
  }, [onUpdateSession, onSpawnAgent, onSpawnSynopsis, onAddHistoryEntry, onComplete, onPRResult, audioFeedbackEnabled, audioFeedbackCommand, updateBatchStateAndBroadcast, timeTracking]);

  /**
   * Request to stop the batch run for a specific session after current task completes
   */
  const stopBatchRun = useCallback((sessionId: string) => {
    stopRequestedRefs.current[sessionId] = true;
    const errorResolution = errorResolutionRefs.current[sessionId];
    if (errorResolution) {
      errorResolution.resolve('abort');
      delete errorResolutionRefs.current[sessionId];
    }
    // Use SET_STOPPING action directly (not updateBatchStateAndBroadcast which only supports UPDATE_PROGRESS)
    dispatch({ type: 'SET_STOPPING', sessionId });
    // Broadcast state change
    const newState = batchRunStatesRef.current[sessionId];
    if (newState) {
      broadcastAutoRunState(sessionId, { ...newState, isStopping: true });
    }
  }, [broadcastAutoRunState]);

  /**
   * Pause the batch run due to an agent error (Phase 5.10)
   * Called externally when agent error is detected
   */
  const pauseBatchOnError = useCallback((sessionId: string, error: AgentError, documentIndex: number, taskDescription?: string) => {
    console.log('[BatchProcessor] Pausing batch due to error:', { sessionId, errorType: error.type, documentIndex });
    window.maestro.logger.autorun(
      `Auto Run paused due to error: ${error.type}`,
      sessionId,
      {
        errorType: error.type,
        errorMessage: error.message,
        documentIndex,
        taskDescription
      }
    );

    // Use SET_ERROR action directly (not updateBatchStateAndBroadcast which only supports UPDATE_PROGRESS)
    dispatch({
      type: 'SET_ERROR',
      sessionId,
      payload: { error, documentIndex, taskDescription }
    });
    // Broadcast state change
    const currentState = batchRunStatesRef.current[sessionId];
    if (currentState) {
      broadcastAutoRunState(sessionId, {
        ...currentState,
        error,
        errorPaused: true,
        errorDocumentIndex: documentIndex,
        errorTaskDescription: taskDescription
      });
    }

    if (!errorResolutionRefs.current[sessionId]) {
      let resolvePromise: ((action: ErrorResolutionAction) => void) | undefined;
      const promise = new Promise<ErrorResolutionAction>(resolve => {
        resolvePromise = resolve;
      });
      errorResolutionRefs.current[sessionId] = {
        promise,
        resolve: resolvePromise as (action: ErrorResolutionAction) => void
      };
    }
  }, [broadcastAutoRunState]);

  /**
   * Skip the current document that caused an error and continue with the next one (Phase 5.10)
   */
  const skipCurrentDocument = useCallback((sessionId: string) => {
    console.log('[BatchProcessor] Skipping current document after error:', sessionId);
    window.maestro.logger.autorun(
      `Skipping document after error`,
      sessionId,
      {}
    );

    // Use CLEAR_ERROR action directly (not updateBatchStateAndBroadcast which only supports UPDATE_PROGRESS)
    dispatch({ type: 'CLEAR_ERROR', sessionId });
    // Broadcast state change
    const currentState = batchRunStatesRef.current[sessionId];
    if (currentState) {
      broadcastAutoRunState(sessionId, {
        ...currentState,
        error: undefined,
        errorPaused: false,
        errorDocumentIndex: undefined,
        errorTaskDescription: undefined
      });
    }

    const errorResolution = errorResolutionRefs.current[sessionId];
    if (errorResolution) {
      errorResolution.resolve('skip-document');
      delete errorResolutionRefs.current[sessionId];
    }

    // Signal to skip the current document in the processing loop
  }, [broadcastAutoRunState]);

  /**
   * Resume the batch run after an error has been resolved (Phase 5.10)
   * This clears the error state and allows the batch to continue
   */
  const resumeAfterError = useCallback((sessionId: string) => {
    console.log('[BatchProcessor] Resuming batch after error resolution:', sessionId);
    window.maestro.logger.autorun(
      `Resuming Auto Run after error resolution`,
      sessionId,
      {}
    );

    // Use CLEAR_ERROR action directly (not updateBatchStateAndBroadcast which only supports UPDATE_PROGRESS)
    dispatch({ type: 'CLEAR_ERROR', sessionId });
    // Broadcast state change
    const currentState = batchRunStatesRef.current[sessionId];
    if (currentState) {
      broadcastAutoRunState(sessionId, {
        ...currentState,
        error: undefined,
        errorPaused: false,
        errorDocumentIndex: undefined,
        errorTaskDescription: undefined
      });
    }

    const errorResolution = errorResolutionRefs.current[sessionId];
    if (errorResolution) {
      errorResolution.resolve('resume');
      delete errorResolutionRefs.current[sessionId];
    }
  }, [broadcastAutoRunState]);

  /**
   * Abort the batch run completely due to an unrecoverable error (Phase 5.10)
   */
  const abortBatchOnError = useCallback((sessionId: string) => {
    console.log('[BatchProcessor] Aborting batch due to error:', sessionId);
    window.maestro.logger.autorun(
      `Auto Run aborted due to error`,
      sessionId,
      {}
    );

    // Request stop and clear error state
    stopRequestedRefs.current[sessionId] = true;
    const errorResolution = errorResolutionRefs.current[sessionId];
    if (errorResolution) {
      errorResolution.resolve('abort');
      delete errorResolutionRefs.current[sessionId];
    }
    updateBatchStateAndBroadcast(sessionId, prev => ({
      ...prev,
      [sessionId]: {
        ...prev[sessionId],
        isStopping: true,
        error: undefined,
        errorPaused: false,
        errorDocumentIndex: undefined,
        errorTaskDescription: undefined
      }
    }), true); // immediate: critical state change (aborting)
  }, [updateBatchStateAndBroadcast]);

  return {
    batchRunStates,
    getBatchState,
    hasAnyActiveBatch,
    activeBatchSessionIds,
    startBatchRun,
    stopBatchRun,
    customPrompts,
    setCustomPrompt,
    // Error handling (Phase 5.10)
    pauseBatchOnError,
    skipCurrentDocument,
    resumeAfterError,
    abortBatchOnError
  };
}
