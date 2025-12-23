// Batch processor service for CLI
// Executes playbooks and yields JSONL events

import { execFileSync } from 'child_process';
import type { Playbook, SessionInfo, UsageStats, HistoryEntry } from '../../shared/types';
import type { JsonlEvent } from '../output/jsonl';
import {
  spawnAgent,
  readDocAndCountTasks,
  readDocAndGetTasks,
  uncheckAllTasks,
  writeDoc,
} from './agent-spawner';
import { addHistoryEntry, readGroups } from './storage';
import { substituteTemplateVariables, TemplateContext } from '../../shared/templateVariables';
import { registerCliActivity, unregisterCliActivity } from '../../shared/cli-activity';
import { logger } from '../../main/utils/logger';
import { autorunSynopsisPrompt } from '../../prompts';
import { parseSynopsis } from '../../shared/synopsis';
import { generateUUID } from '../../shared/uuid';
import { formatElapsedTime } from '../../shared/formatters';

// Synopsis prompt for batch tasks
const BATCH_SYNOPSIS_PROMPT = autorunSynopsisPrompt;

/**
 * Get the current git branch for a directory
 */
function getGitBranch(cwd: string): string | undefined {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if a directory is a git repository
 */
function isGitRepo(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Process a playbook and yield JSONL events
 */
export async function* runPlaybook(
  session: SessionInfo,
  playbook: Playbook,
  folderPath: string,
  options: {
    dryRun?: boolean;
    writeHistory?: boolean;
    debug?: boolean;
    verbose?: boolean;
  } = {}
): AsyncGenerator<JsonlEvent> {
  const { dryRun = false, writeHistory = true, debug = false, verbose = false } = options;
  const batchStartTime = Date.now();

  // Get git branch and group name for template variable substitution
  const gitBranch = getGitBranch(session.cwd);
  const isGit = isGitRepo(session.cwd);
  const groups = readGroups();
  const sessionGroup = groups.find(g => g.id === session.groupId);
  const groupName = sessionGroup?.name;

  // Register CLI activity so desktop app knows this session is busy
  registerCliActivity({
    sessionId: session.id,
    playbookId: playbook.id,
    playbookName: playbook.name,
    startedAt: Date.now(),
    pid: process.pid,
  });

  // Emit start event
  yield {
    type: 'start',
    timestamp: Date.now(),
    playbook: { id: playbook.id, name: playbook.name },
    session: { id: session.id, name: session.name, cwd: session.cwd },
  };

  // AUTORUN LOG: Start
  logger.autorun(
    `Auto Run started`,
    session.name,
    {
      playbook: playbook.name,
      documents: playbook.documents.map(d => d.filename),
      loopEnabled: playbook.loopEnabled,
      maxLoops: playbook.maxLoops ?? 'unlimited'
    }
  );

  // Emit debug info about playbook configuration
  if (debug) {
    yield {
      type: 'debug',
      timestamp: Date.now(),
      category: 'config',
      message: `Playbook config: loopEnabled=${playbook.loopEnabled}, maxLoops=${playbook.maxLoops ?? 'unlimited'}`,
    };
    yield {
      type: 'debug',
      timestamp: Date.now(),
      category: 'config',
      message: `Documents (${playbook.documents.length}): ${playbook.documents.map(d => `${d.filename}${d.resetOnCompletion ? ' [RESET]' : ''}`).join(', ')}`,
    };
    yield {
      type: 'debug',
      timestamp: Date.now(),
      category: 'config',
      message: `Folder path: ${folderPath}`,
    };
  }

  // Calculate initial total tasks
  let initialTotalTasks = 0;
  for (const doc of playbook.documents) {
    const { taskCount } = readDocAndCountTasks(folderPath, doc.filename);
    if (debug) {
      yield {
        type: 'debug',
        timestamp: Date.now(),
        category: 'scan',
        message: `${doc.filename}: ${taskCount} unchecked task${taskCount !== 1 ? 's' : ''}`,
      };
    }
    initialTotalTasks += taskCount;
  }
  if (debug) {
    yield {
      type: 'debug',
      timestamp: Date.now(),
      category: 'scan',
      message: `Total unchecked tasks: ${initialTotalTasks}`,
    };
  }

  if (initialTotalTasks === 0) {
    unregisterCliActivity(session.id);
    yield {
      type: 'error',
      timestamp: Date.now(),
      message: 'No unchecked tasks found in any documents',
      code: 'NO_TASKS',
    };
    return;
  }

  if (dryRun) {
    // Dry run - show detailed breakdown of what would be executed
    for (let docIndex = 0; docIndex < playbook.documents.length; docIndex++) {
      const docEntry = playbook.documents[docIndex];
      const { tasks } = readDocAndGetTasks(folderPath, docEntry.filename);

      if (tasks.length === 0) {
        continue;
      }

      // Emit document start event
      yield {
        type: 'document_start',
        timestamp: Date.now(),
        document: docEntry.filename,
        index: docIndex,
        taskCount: tasks.length,
        dryRun: true,
      };

      // Emit each task that would be processed
      for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
        yield {
          type: 'task_preview',
          timestamp: Date.now(),
          document: docEntry.filename,
          taskIndex,
          task: tasks[taskIndex],
        };
      }

      // Emit document complete event
      yield {
        type: 'document_complete',
        timestamp: Date.now(),
        document: docEntry.filename,
        tasksCompleted: tasks.length,
        dryRun: true,
      };
    }

    unregisterCliActivity(session.id);
    yield {
      type: 'complete',
      timestamp: Date.now(),
      success: true,
      totalTasksCompleted: 0,
      totalElapsedMs: 0,
      dryRun: true,
      wouldProcess: initialTotalTasks,
    };
    return;
  }

  // Track totals
  let totalCompletedTasks = 0;
  let totalCost = 0;
  let loopIteration = 0;

  // Per-loop tracking
  let loopStartTime = Date.now();
  let loopTasksCompleted = 0;
  let loopTotalInputTokens = 0;
  let loopTotalOutputTokens = 0;
  let loopTotalCost = 0;

  // Total tracking across all loops
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Helper to create final loop entry with exit reason
  const createFinalLoopEntry = (exitReason: string): void => {
    // AUTORUN LOG: Exit
    logger.autorun(
      `Auto Run exiting: ${exitReason}`,
      session.name,
      {
        reason: exitReason,
        totalTasksCompleted: totalCompletedTasks,
        loopsCompleted: loopIteration + 1
      }
    );

    if (!writeHistory) return;
    // Only write if looping was enabled and we did some work
    if (!playbook.loopEnabled && loopIteration === 0) return;
    if (loopTasksCompleted === 0 && loopIteration === 0) return;

    const loopElapsedMs = Date.now() - loopStartTime;
    const loopNumber = loopIteration + 1;
    const loopSummary = `Loop ${loopNumber} (final) completed: ${loopTasksCompleted} task${loopTasksCompleted !== 1 ? 's' : ''} accomplished`;

    const loopUsageStats: UsageStats | undefined =
      loopTotalInputTokens > 0 || loopTotalOutputTokens > 0
        ? {
            inputTokens: loopTotalInputTokens,
            outputTokens: loopTotalOutputTokens,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalCostUsd: loopTotalCost,
            contextWindow: 0, // Set to 0 for summaries - these are cumulative totals, not per-task context
          }
        : undefined;

    const loopDetails = [
      `**Loop ${loopNumber} (final) Summary**`,
      '',
      `- **Tasks Accomplished:** ${loopTasksCompleted}`,
      `- **Duration:** ${formatElapsedTime(loopElapsedMs)}`,
      loopTotalInputTokens > 0 || loopTotalOutputTokens > 0
        ? `- **Tokens:** ${(loopTotalInputTokens + loopTotalOutputTokens).toLocaleString()} (${loopTotalInputTokens.toLocaleString()} in / ${loopTotalOutputTokens.toLocaleString()} out)`
        : '',
      loopTotalCost > 0 ? `- **Cost:** $${loopTotalCost.toFixed(4)}` : '',
      `- **Exit Reason:** ${exitReason}`,
    ].filter(line => line !== '').join('\n');

    const historyEntry: HistoryEntry = {
      id: generateUUID(),
      type: 'AUTO',
      timestamp: Date.now(),
      summary: loopSummary,
      fullResponse: loopDetails,
      projectPath: session.cwd,
      sessionId: session.id,
      success: true,
      elapsedTimeMs: loopElapsedMs,
      usageStats: loopUsageStats,
    };
    addHistoryEntry(historyEntry);
  };

  // Helper to create total Auto Run summary
  const createAutoRunSummary = (): void => {
    if (!writeHistory) return;
    // Only write if we completed multiple loops or if looping was enabled
    if (!playbook.loopEnabled && loopIteration === 0) return;

    const totalElapsedMs = Date.now() - batchStartTime;
    const loopsCompleted = loopIteration + 1;
    const summary = `Auto Run completed: ${totalCompletedTasks} tasks in ${loopsCompleted} loop${loopsCompleted !== 1 ? 's' : ''}`;

    const totalUsageStats: UsageStats | undefined =
      totalInputTokens > 0 || totalOutputTokens > 0
        ? {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalCostUsd: totalCost,
            contextWindow: 0, // Set to 0 for summaries - these are cumulative totals, not per-task context
          }
        : undefined;

    const details = [
      `**Auto Run Summary**`,
      '',
      `- **Total Tasks Completed:** ${totalCompletedTasks}`,
      `- **Loops Completed:** ${loopsCompleted}`,
      `- **Total Duration:** ${formatElapsedTime(totalElapsedMs)}`,
      totalInputTokens > 0 || totalOutputTokens > 0
        ? `- **Total Tokens:** ${(totalInputTokens + totalOutputTokens).toLocaleString()} (${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out)`
        : '',
      totalCost > 0 ? `- **Total Cost:** $${totalCost.toFixed(4)}` : '',
    ].filter(line => line !== '').join('\n');

    const historyEntry: HistoryEntry = {
      id: generateUUID(),
      type: 'AUTO',
      timestamp: Date.now(),
      summary,
      fullResponse: details,
      projectPath: session.cwd,
      sessionId: session.id,
      success: true,
      elapsedTimeMs: totalElapsedMs,
      usageStats: totalUsageStats,
    };
    addHistoryEntry(historyEntry);
  };

  // Main processing loop
  while (true) {
    let anyTasksProcessedThisIteration = false;

    // Process each document in order
    for (let docIndex = 0; docIndex < playbook.documents.length; docIndex++) {
      const docEntry = playbook.documents[docIndex];

      // Read document and count tasks
      let { taskCount: remainingTasks } = readDocAndCountTasks(folderPath, docEntry.filename);

      // Skip documents with no tasks
      if (remainingTasks === 0) {
        continue;
      }

      // Emit document start event
      yield {
        type: 'document_start',
        timestamp: Date.now(),
        document: docEntry.filename,
        index: docIndex,
        taskCount: remainingTasks,
      };

      // AUTORUN LOG: Document processing
      logger.autorun(
        `Processing document: ${docEntry.filename}`,
        session.name,
        {
          document: docEntry.filename,
          tasksRemaining: remainingTasks,
          loopNumber: loopIteration + 1
        }
      );

      let docTasksCompleted = 0;
      let taskIndex = 0;

      // Process tasks in this document
      while (remainingTasks > 0) {
        // Emit task start
        yield {
          type: 'task_start',
          timestamp: Date.now(),
          document: docEntry.filename,
          taskIndex,
        };

        const taskStartTime = Date.now();

        const docFilePath = `${folderPath}/${docEntry.filename}.md`;

        // Build template context for this task
        const templateContext: TemplateContext = {
          session: {
            ...session,
            isGitRepo: isGit,
          },
          gitBranch,
          groupName,
          autoRunFolder: folderPath,
          loopNumber: loopIteration + 1, // 1-indexed
          documentName: docEntry.filename,
          documentPath: docFilePath,
        };

        // Substitute template variables in the prompt
        const basePrompt = substituteTemplateVariables(playbook.prompt, templateContext);

        // Read document content and expand template variables in it
        const { content: docContent } = readDocAndCountTasks(folderPath, docEntry.filename);
        const expandedDocContent = docContent
          ? substituteTemplateVariables(docContent, templateContext)
          : '';

        // Write expanded content back to document (so agent edits have correct paths)
        if (expandedDocContent && expandedDocContent !== docContent) {
          writeDoc(folderPath, `${docEntry.filename}.md`, expandedDocContent);
        }

        // Combine prompt with document content - agent works on what it's given
        // Include explicit file path so agent knows where to save changes
        const finalPrompt = `${basePrompt}\n\n---\n\n# Current Document: ${docFilePath}\n\nProcess tasks from this document and save changes back to the file above.\n\n${expandedDocContent}`;

        // Emit verbose event with full prompt
        if (verbose) {
          yield {
            type: 'verbose',
            timestamp: Date.now(),
            category: 'prompt',
            document: docEntry.filename,
            taskIndex,
            prompt: finalPrompt,
          };
        }

        // Spawn agent with combined prompt + document
        const result = await spawnAgent(session.toolType, session.cwd, finalPrompt);

        const elapsedMs = Date.now() - taskStartTime;

        // Re-read document to get new task count
        const { taskCount: newRemainingTasks } = readDocAndCountTasks(folderPath, docEntry.filename);
        const tasksCompletedThisRun = remainingTasks - newRemainingTasks;

        // Update counters
        docTasksCompleted += tasksCompletedThisRun;
        totalCompletedTasks += tasksCompletedThisRun;
        loopTasksCompleted += tasksCompletedThisRun;
        anyTasksProcessedThisIteration = true;

        // Track usage
        if (result.usageStats) {
          loopTotalInputTokens += result.usageStats.inputTokens || 0;
          loopTotalOutputTokens += result.usageStats.outputTokens || 0;
          loopTotalCost += result.usageStats.totalCostUsd || 0;
          totalCost += result.usageStats.totalCostUsd || 0;
          totalInputTokens += result.usageStats.inputTokens || 0;
          totalOutputTokens += result.usageStats.outputTokens || 0;
        }

        // Generate synopsis
        let shortSummary = `[${docEntry.filename}] Task completed`;
        let fullSynopsis = shortSummary;

        if (result.success && result.agentSessionId) {
          // Request synopsis from the agent
          const synopsisResult = await spawnAgent(
            session.toolType,
            session.cwd,
            BATCH_SYNOPSIS_PROMPT,
            result.agentSessionId
          );

          if (synopsisResult.success && synopsisResult.response) {
            const parsed = parseSynopsis(synopsisResult.response);
            shortSummary = parsed.shortSummary;
            fullSynopsis = parsed.fullSynopsis;
          }
        } else if (!result.success) {
          shortSummary = `[${docEntry.filename}] Task failed`;
          fullSynopsis = result.error || shortSummary;
        }

        // Emit task complete event
        yield {
          type: 'task_complete',
          timestamp: Date.now(),
          document: docEntry.filename,
          taskIndex,
          success: result.success,
          summary: shortSummary,
          fullResponse: fullSynopsis,
          elapsedMs,
          usageStats: result.usageStats,
          agentSessionId: result.agentSessionId,
        };

        // Add history entry if enabled
        if (writeHistory) {
          const historyEntry: HistoryEntry = {
            id: generateUUID(),
            type: 'AUTO',
            timestamp: Date.now(),
            summary: shortSummary,
            fullResponse: fullSynopsis,
            agentSessionId: result.agentSessionId,
            projectPath: session.cwd,
            sessionId: session.id,
            success: result.success,
            usageStats: result.usageStats,
            elapsedTimeMs: elapsedMs,
          };
          addHistoryEntry(historyEntry);
          if (debug) {
            yield {
              type: 'history_write',
              timestamp: Date.now(),
              entryId: historyEntry.id,
            };
          }
        }

        remainingTasks = newRemainingTasks;
        taskIndex++;
      }

      // Document complete - handle reset-on-completion
      if (docEntry.resetOnCompletion && docTasksCompleted > 0) {
        // AUTORUN LOG: Document reset
        logger.autorun(
          `Resetting document: ${docEntry.filename}`,
          session.name,
          {
            document: docEntry.filename,
            tasksCompleted: docTasksCompleted,
            loopNumber: loopIteration + 1
          }
        );

        const { content: currentContent } = readDocAndCountTasks(folderPath, docEntry.filename);
        const resetContent = uncheckAllTasks(currentContent);
        writeDoc(folderPath, docEntry.filename + '.md', resetContent);
        if (debug) {
          const { taskCount: newTaskCount } = readDocAndCountTasks(folderPath, docEntry.filename);
          yield {
            type: 'debug',
            timestamp: Date.now(),
            category: 'reset',
            message: `Reset ${docEntry.filename}: unchecked all tasks (${newTaskCount} tasks now open)`,
          };
        }
      }

      // Emit document complete event
      yield {
        type: 'document_complete',
        timestamp: Date.now(),
        document: docEntry.filename,
        tasksCompleted: docTasksCompleted,
      };
    }

    // Check if we should continue looping
    if (!playbook.loopEnabled) {
      if (debug) {
        yield {
          type: 'debug',
          timestamp: Date.now(),
          category: 'loop',
          message: 'Exiting: loopEnabled is false',
        };
      }
      createFinalLoopEntry('Looping disabled');
      break;
    }

    // Check max loop limit
    if (playbook.maxLoops !== null && playbook.maxLoops !== undefined && loopIteration + 1 >= playbook.maxLoops) {
      if (debug) {
        yield {
          type: 'debug',
          timestamp: Date.now(),
          category: 'loop',
          message: `Exiting: reached max loops (${playbook.maxLoops})`,
        };
      }
      createFinalLoopEntry(`Reached max loop limit (${playbook.maxLoops})`);
      break;
    }

    // Check if any non-reset documents have remaining tasks
    const hasAnyNonResetDocs = playbook.documents.some(doc => !doc.resetOnCompletion);
    if (debug) {
      const nonResetDocs = playbook.documents.filter(d => !d.resetOnCompletion).map(d => d.filename);
      const resetDocs = playbook.documents.filter(d => d.resetOnCompletion).map(d => d.filename);
      yield {
        type: 'debug',
        timestamp: Date.now(),
        category: 'loop',
        message: `Checking loop condition: ${nonResetDocs.length} non-reset docs [${nonResetDocs.join(', ')}], ${resetDocs.length} reset docs [${resetDocs.join(', ')}]`,
      };
    }

    if (hasAnyNonResetDocs) {
      let anyNonResetDocsHaveTasks = false;
      for (const doc of playbook.documents) {
        if (doc.resetOnCompletion) continue;
        const { taskCount } = readDocAndCountTasks(folderPath, doc.filename);
        if (debug) {
          yield {
            type: 'debug',
            timestamp: Date.now(),
            category: 'loop',
            message: `Non-reset doc ${doc.filename}: ${taskCount} unchecked task${taskCount !== 1 ? 's' : ''}`,
          };
        }
        if (taskCount > 0) {
          anyNonResetDocsHaveTasks = true;
          break;
        }
      }
      if (!anyNonResetDocsHaveTasks) {
        if (debug) {
          yield {
            type: 'debug',
            timestamp: Date.now(),
            category: 'loop',
            message: 'Exiting: all non-reset documents have 0 remaining tasks',
          };
        }
        createFinalLoopEntry('All tasks completed');
        break;
      }
    } else {
      // All documents are reset docs - exit after one pass
      if (debug) {
        yield {
          type: 'debug',
          timestamp: Date.now(),
          category: 'loop',
          message: 'Exiting: ALL documents have resetOnCompletion=true (loop requires at least one non-reset doc to drive iterations)',
        };
      }
      createFinalLoopEntry('All documents have reset-on-completion');
      break;
    }

    // Safety check
    if (!anyTasksProcessedThisIteration) {
      if (debug) {
        yield {
          type: 'debug',
          timestamp: Date.now(),
          category: 'loop',
          message: 'Exiting: no tasks were processed this iteration (safety check)',
        };
      }
      createFinalLoopEntry('No tasks processed this iteration');
      break;
    }

    if (debug) {
      yield {
        type: 'debug',
        timestamp: Date.now(),
        category: 'loop',
        message: `Continuing to next loop iteration (current: ${loopIteration + 1})`,
      };
    }

    // Emit loop complete event
    const loopElapsedMs = Date.now() - loopStartTime;
    const loopUsageStats: UsageStats | undefined =
      loopTotalInputTokens > 0 || loopTotalOutputTokens > 0
        ? {
            inputTokens: loopTotalInputTokens,
            outputTokens: loopTotalOutputTokens,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalCostUsd: loopTotalCost,
            contextWindow: 0, // Set to 0 for summaries - these are cumulative totals, not per-task context
          }
        : undefined;

    yield {
      type: 'loop_complete',
      timestamp: Date.now(),
      iteration: loopIteration + 1,
      tasksCompleted: loopTasksCompleted,
      elapsedMs: loopElapsedMs,
      usageStats: loopUsageStats,
    };

    // AUTORUN LOG: Loop completion
    logger.autorun(
      `Loop ${loopIteration + 1} completed`,
      session.name,
      {
        loopNumber: loopIteration + 1,
        tasksCompleted: loopTasksCompleted
      }
    );

    // Add loop summary history entry
    if (writeHistory) {
      const loopSummary = `Loop ${loopIteration + 1} completed: ${loopTasksCompleted} tasks accomplished`;
      const historyEntry: HistoryEntry = {
        id: generateUUID(),
        type: 'AUTO',
        timestamp: Date.now(),
        summary: loopSummary,
        projectPath: session.cwd,
        sessionId: session.id,
        success: true,
        elapsedTimeMs: loopElapsedMs,
        usageStats: loopUsageStats,
      };
      addHistoryEntry(historyEntry);
    }

    // Reset per-loop tracking
    loopStartTime = Date.now();
    loopTasksCompleted = 0;
    loopTotalInputTokens = 0;
    loopTotalOutputTokens = 0;
    loopTotalCost = 0;

    loopIteration++;
  }

  // Unregister CLI activity - session is no longer busy
  unregisterCliActivity(session.id);

  // Add total Auto Run summary (only if looping was used)
  createAutoRunSummary();

  // Emit complete event
  yield {
    type: 'complete',
    timestamp: Date.now(),
    success: true,
    totalTasksCompleted: totalCompletedTasks,
    totalElapsedMs: Date.now() - batchStartTime,
    totalCost,
  };
}
