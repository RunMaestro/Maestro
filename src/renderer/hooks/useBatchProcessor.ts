import { useState, useCallback, useRef, useEffect } from 'react';
import type { BatchRunState, Session, HistoryEntry, UsageStats } from '../types';

// Regex to count unchecked markdown checkboxes: - [ ] task
const UNCHECKED_TASK_REGEX = /^[\s]*-\s*\[\s*\]\s*.+$/gm;

// Default empty batch state
const DEFAULT_BATCH_STATE: BatchRunState = {
  isRunning: false,
  isStopping: false,
  // Multi-document progress (new fields)
  documents: [],
  currentDocumentIndex: 0,
  currentDocTasksTotal: 0,
  currentDocTasksCompleted: 0,
  totalTasksAcrossAllDocs: 0,
  completedTasksAcrossAllDocs: 0,
  // Loop mode
  loopEnabled: false,
  loopIteration: 0,
  // Folder path for file operations
  folderPath: '',
  // Legacy fields (kept for backwards compatibility)
  totalTasks: 0,
  completedTasks: 0,
  currentTaskIndex: 0,
  originalContent: '',
  sessionIds: []
};

interface BatchCompleteInfo {
  sessionId: string;
  sessionName: string;
  completedTasks: number;
  totalTasks: number;
  wasStopped: boolean;
  elapsedTimeMs: number;
}

interface UseBatchProcessorProps {
  sessions: Session[];
  onUpdateSession: (sessionId: string, updates: Partial<Session>) => void;
  onSpawnAgent: (sessionId: string, prompt: string) => Promise<{ success: boolean; response?: string; claudeSessionId?: string; usageStats?: UsageStats }>;
  onSpawnSynopsis: (sessionId: string, cwd: string, claudeSessionId: string, prompt: string) => Promise<{ success: boolean; response?: string }>;
  onAddHistoryEntry: (entry: Omit<HistoryEntry, 'id'>) => void;
  onComplete?: (info: BatchCompleteInfo) => void;
  // TTS settings for speaking synopsis after each task
  audioFeedbackEnabled?: boolean;
  audioFeedbackCommand?: string;
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
  // Start batch run for a specific session
  startBatchRun: (sessionId: string, scratchpadContent: string, prompt: string) => Promise<void>;
  // Stop batch run for a specific session
  stopBatchRun: (sessionId: string) => void;
  // Custom prompts per session
  customPrompts: Record<string, string>;
  setCustomPrompt: (sessionId: string, prompt: string) => void;
}

/**
 * Count unchecked tasks in markdown content
 * Matches lines like: - [ ] task description
 */
export function countUnfinishedTasks(content: string): number {
  const matches = content.match(UNCHECKED_TASK_REGEX);
  return matches ? matches.length : 0;
}

/**
 * Hook for managing batch processing of scratchpad tasks across multiple sessions
 */
// Synopsis prompt for batch tasks - requests a two-part response
const BATCH_SYNOPSIS_PROMPT = `Provide a brief synopsis of what you just accomplished in this task using this exact format:

**Summary:** [1-2 sentences describing the key outcome]

**Details:** [A paragraph with more specifics about what was done, files changed, etc.]

Rules:
- Be specific about what was actually accomplished, not what was attempted.
- Focus only on meaningful work that was done. Omit filler phrases like "the task is complete", "no further action needed", "everything is working", etc.
- If nothing meaningful was accomplished, respond with only: **Summary:** No changes made.`;

/**
 * Parse a synopsis response into short summary and full synopsis
 * Expected format:
 *   **Summary:** Short 1-2 sentence summary
 *   **Details:** Detailed paragraph...
 */
function parseSynopsis(response: string): { shortSummary: string; fullSynopsis: string } {
  // Clean up ANSI codes and box drawing characters
  const clean = response
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/─+/g, '')
    .replace(/[│┌┐└┘├┤┬┴┼]/g, '')
    .trim();

  // Try to extract Summary and Details sections
  const summaryMatch = clean.match(/\*\*Summary:\*\*\s*(.+?)(?=\*\*Details:\*\*|$)/is);
  const detailsMatch = clean.match(/\*\*Details:\*\*\s*(.+?)$/is);

  const shortSummary = summaryMatch?.[1]?.trim() || clean.split('\n')[0]?.trim() || 'Task completed';
  const details = detailsMatch?.[1]?.trim() || '';

  // Full synopsis includes both parts
  const fullSynopsis = details ? `${shortSummary}\n\n${details}` : shortSummary;

  return { shortSummary, fullSynopsis };
}

export function useBatchProcessor({
  sessions,
  onUpdateSession,
  onSpawnAgent,
  onSpawnSynopsis,
  onAddHistoryEntry,
  onComplete,
  audioFeedbackEnabled,
  audioFeedbackCommand
}: UseBatchProcessorProps): UseBatchProcessorReturn {
  // Batch states per session
  const [batchRunStates, setBatchRunStates] = useState<Record<string, BatchRunState>>({});

  // Custom prompts per session
  const [customPrompts, setCustomPrompts] = useState<Record<string, string>>({});

  // Refs for tracking stop requests per session
  const stopRequestedRefs = useRef<Record<string, boolean>>({});
  const scratchpadPathRefs = useRef<Record<string, string | null>>({});

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

  // Broadcast batch run state changes to web interface
  useEffect(() => {
    // Broadcast state for each session that has batch state
    Object.entries(batchRunStates).forEach(([sessionId, state]) => {
      if (state.isRunning || state.completedTasks > 0) {
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
    });
  }, [batchRunStates]);

  /**
   * Start a batch processing run for a specific session
   */
  const startBatchRun = useCallback(async (sessionId: string, scratchpadContent: string, prompt: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) {
      console.error('Session not found for batch processing:', sessionId);
      return;
    }

    // Track batch start time for completion notification
    const batchStartTime = Date.now();

    // Count tasks
    const totalTasks = countUnfinishedTasks(scratchpadContent);

    if (totalTasks === 0) {
      console.warn('No unchecked tasks found in scratchpad for session:', sessionId);
      return;
    }

    // Reset stop flag for this session
    stopRequestedRefs.current[sessionId] = false;

    // Write scratchpad content to temp file
    const writeResult = await window.maestro.tempfile.write(
      scratchpadContent,
      `maestro-scratchpad-${sessionId}-${Date.now()}.md`
    );

    if (!writeResult.success || !writeResult.path) {
      console.error('Failed to write temp file:', writeResult.error);
      return;
    }

    scratchpadPathRefs.current[sessionId] = writeResult.path;

    // Replace $$SCRATCHPAD$$ placeholder with actual path
    const finalPrompt = prompt.replace(/\$\$SCRATCHPAD\$\$/g, writeResult.path);

    // Initialize batch run state for this session
    setBatchRunStates(prev => ({
      ...prev,
      [sessionId]: {
        isRunning: true,
        isStopping: false,
        // Multi-document progress (new fields - currently single-doc legacy mode)
        documents: [],
        currentDocumentIndex: 0,
        currentDocTasksTotal: totalTasks,
        currentDocTasksCompleted: 0,
        totalTasksAcrossAllDocs: totalTasks,
        completedTasksAcrossAllDocs: 0,
        // Loop mode (not yet enabled in legacy mode)
        loopEnabled: false,
        loopIteration: 0,
        // Folder path (empty in legacy mode - uses temp file)
        folderPath: '',
        // Legacy fields
        totalTasks,
        completedTasks: 0,
        currentTaskIndex: 0,
        scratchpadPath: writeResult.path,
        originalContent: scratchpadContent,
        customPrompt: prompt !== '' ? prompt : undefined,
        sessionIds: [],
        startTime: batchStartTime
      }
    }));

    // Store custom prompt for persistence
    setCustomPrompts(prev => ({ ...prev, [sessionId]: prompt }));

    // Run agent iterations
    const claudeSessionIds: string[] = [];
    let completedCount = 0;


    for (let i = 0; i < totalTasks; i++) {
      // Check if stop was requested for this session
      if (stopRequestedRefs.current[sessionId]) {
        console.log('Batch run stopped by user after task', i, 'for session:', sessionId);
        break;
      }

      // Update current task index
      setBatchRunStates(prev => ({
        ...prev,
        [sessionId]: {
          ...prev[sessionId],
          currentTaskIndex: i
        }
      }));

      try {
        // Capture start time for elapsed time tracking
        const taskStartTime = Date.now();

        // Spawn agent with the prompt for this specific session
        const result = await onSpawnAgent(sessionId, finalPrompt);

        // Capture elapsed time
        const elapsedTimeMs = Date.now() - taskStartTime;

        if (result.claudeSessionId) {
          claudeSessionIds.push(result.claudeSessionId);
          // Register as auto-initiated Maestro session
          window.maestro.claude.registerSessionOrigin(session.cwd, result.claudeSessionId, 'auto')
            .catch(err => console.error('[BatchProcessor] Failed to register session origin:', err));
        }

        completedCount++;

        // Update progress
        setBatchRunStates(prev => ({
          ...prev,
          [sessionId]: {
            ...prev[sessionId],
            completedTasks: completedCount,
            sessionIds: [...(prev[sessionId]?.sessionIds || []), result.claudeSessionId || '']
          }
        }));

        // Generate synopsis for successful tasks with a Claude session
        let shortSummary = `Task ${i + 1} of ${totalTasks}`;
        let fullSynopsis = shortSummary;

        if (result.success && result.claudeSessionId) {
          // Request a synopsis from the agent by resuming the session
          try {
            const synopsisResult = await onSpawnSynopsis(
              sessionId,
              session.cwd,
              result.claudeSessionId,
              BATCH_SYNOPSIS_PROMPT
            );

            if (synopsisResult.success && synopsisResult.response) {
              const parsed = parseSynopsis(synopsisResult.response);
              shortSummary = parsed.shortSummary;
              fullSynopsis = parsed.fullSynopsis;
            }
          } catch (err) {
            console.error('[BatchProcessor] Synopsis generation failed:', err);
            // Fall back to default summary
          }
        } else if (!result.success) {
          shortSummary = `Task ${i + 1} of ${totalTasks} failed`;
          fullSynopsis = shortSummary;
        }

        // Add history entry with both short summary (for list/toast) and full synopsis (for details)
        onAddHistoryEntry({
          type: 'AUTO',
          timestamp: Date.now(),
          summary: shortSummary,           // Short 1-2 sentence for list view and toast
          fullResponse: fullSynopsis,      // Complete synopsis for detail view
          claudeSessionId: result.claudeSessionId,
          projectPath: session.cwd,
          sessionId: sessionId, // Associate with this Maestro session for isolation
          success: result.success,
          // Use per-task usage stats returned from spawnAgentForSession
          usageStats: result.usageStats,
          elapsedTimeMs
        });

        // Speak the synopsis via TTS if audio feedback is enabled
        if (audioFeedbackEnabled && audioFeedbackCommand && shortSummary) {
          window.maestro.notification.speak(shortSummary, audioFeedbackCommand).catch(err => {
            console.error('[BatchProcessor] Failed to speak synopsis:', err);
          });
        }

        // Re-read the scratchpad file to check remaining tasks
        // TODO: In new Auto Run system, content is stored in files, not session state
        const readResult = await window.maestro.tempfile.read(writeResult.path);
        if (readResult.success && readResult.content) {
          console.log('[BatchProcessor] Checking remaining tasks after task', i + 1, 'for session:', sessionId);
          // Note: scratchPadContent field removed - content now stored in files

          const remainingTasks = countUnfinishedTasks(readResult.content);
          console.log('[BatchProcessor] Remaining unchecked tasks:', remainingTasks);

          // If no more tasks, we're done
          if (remainingTasks === 0) {
            console.log('All tasks completed by agent for session:', sessionId);
            break;
          }
        }
      } catch (error) {
        console.error(`Error running task ${i + 1} for session ${sessionId}:`, error);
        // Continue to next task on error
      }
    }

    // Note: In the old system, we would sync back changes from temp file to session state
    // TODO: In new Auto Run system, content is persisted directly to files via autorun:writeDoc IPC
    // No need to sync back - the file IS the source of truth

    // Clean up temp file
    try {
      await window.maestro.tempfile.delete(writeResult.path);
    } catch (error) {
      console.error('Error deleting temp file:', error);
    }

    // Reset state for this session
    setBatchRunStates(prev => ({
      ...prev,
      [sessionId]: {
        isRunning: false,
        isStopping: false,
        // Multi-document progress (reset)
        documents: [],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 0,
        currentDocTasksCompleted: 0,
        totalTasksAcrossAllDocs: 0,
        completedTasksAcrossAllDocs: 0,
        // Loop mode (reset)
        loopEnabled: false,
        loopIteration: 0,
        // Folder path (reset)
        folderPath: '',
        // Legacy fields (reset)
        totalTasks: 0,
        completedTasks: 0,
        currentTaskIndex: 0,
        originalContent: '',
        sessionIds: claudeSessionIds
      }
    }));

    scratchpadPathRefs.current[sessionId] = null;

    // Call completion callback if provided
    if (onComplete) {
      const wasStopped = stopRequestedRefs.current[sessionId] || false;
      onComplete({
        sessionId,
        sessionName: session.name || session.cwd.split('/').pop() || 'Unknown',
        completedTasks: completedCount,
        totalTasks,
        wasStopped,
        elapsedTimeMs: Date.now() - batchStartTime
      });
    }
  }, [sessions, onUpdateSession, onSpawnAgent, onAddHistoryEntry, onComplete]);

  /**
   * Request to stop the batch run for a specific session after current task completes
   */
  const stopBatchRun = useCallback((sessionId: string) => {
    stopRequestedRefs.current[sessionId] = true;
    setBatchRunStates(prev => ({
      ...prev,
      [sessionId]: {
        ...prev[sessionId],
        isStopping: true
      }
    }));
  }, []);

  return {
    batchRunStates,
    getBatchState,
    hasAnyActiveBatch,
    activeBatchSessionIds,
    startBatchRun,
    stopBatchRun,
    customPrompts,
    setCustomPrompt
  };
}
