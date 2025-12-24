/**
 * Context Merge IPC Handlers
 *
 * This module provides IPC handlers for context merging operations,
 * enabling session context transfer and grooming across AI agents.
 *
 * Usage:
 * - window.maestro.context.getStoredSession(agentId, projectRoot, sessionId)
 * - window.maestro.context.groomContext(projectRoot, agentType, prompt) - NEW: single call for grooming
 * - window.maestro.context.createGroomingSession(projectRoot, agentType) - DEPRECATED
 * - window.maestro.context.sendGroomingPrompt(sessionId, prompt) - DEPRECATED
 * - window.maestro.context.cleanupGroomingSession(sessionId)
 */

import { ipcMain, BrowserWindow } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';
import {
  withIpcErrorLogging,
  requireDependency,
  CreateHandlerOptions,
} from '../../utils/ipcHandler';
import {
  getSessionStorage,
  type SessionMessagesResult,
} from '../../agent-session-storage';
import { buildAgentArgs } from '../../utils/agent-args';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agent-detector';

const LOG_CONTEXT = '[ContextMerge]';

/**
 * Helper to create handler options with consistent context
 */
const handlerOpts = (
  operation: string,
  extra?: Partial<CreateHandlerOptions>
): Pick<CreateHandlerOptions, 'context' | 'operation' | 'logSuccess'> => ({
  context: LOG_CONTEXT,
  operation,
  logSuccess: false,
  ...extra,
});

/**
 * Dependencies required for context handler registration
 */
export interface ContextHandlerDependencies {
  getMainWindow: () => BrowserWindow | null;
  getProcessManager: () => ProcessManager | null;
  getAgentDetector: () => AgentDetector | null;
}

/**
 * Track grooming sessions for cleanup
 * Maps sessionId -> { processId, startTime }
 */
const activeGroomingSessions = new Map<string, {
  groomerSessionId: string;
  startTime: number;
  cleanup?: () => void;
}>();

/**
 * Default timeout for grooming operations (5 minutes)
 */
const GROOMING_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Register all Context Merge IPC handlers.
 *
 * These handlers support context merging operations:
 * - getStoredSession: Retrieve messages from an agent session storage
 * - createGroomingSession: Create a temporary session for context grooming
 * - sendGroomingPrompt: Send a grooming prompt to a session
 * - cleanupGroomingSession: Clean up a temporary grooming session
 */
export function registerContextHandlers(deps: ContextHandlerDependencies): void {
  const { getProcessManager, getAgentDetector } = deps;

  logger.info('Registering context IPC handlers', LOG_CONTEXT);
  console.log('[ContextMerge] Registering context IPC handlers (v2 with response collection)');

  // Get context from a stored agent session
  ipcMain.handle(
    'context:getStoredSession',
    withIpcErrorLogging(
      handlerOpts('getStoredSession'),
      async (agentId: string, projectRoot: string, sessionId: string): Promise<SessionMessagesResult | null> => {
        logger.debug('Getting stored session context', LOG_CONTEXT, {
          agentId,
          projectRoot,
          sessionId,
        });

        const storage = getSessionStorage(agentId);
        if (!storage) {
          logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
          return null;
        }

        try {
          const result = await storage.readSessionMessages(projectRoot, sessionId);
          logger.debug('Retrieved session messages', LOG_CONTEXT, {
            agentId,
            sessionId,
            messageCount: result.messages.length,
            total: result.total,
          });
          return result;
        } catch (error) {
          logger.error('Failed to read session messages', LOG_CONTEXT, {
            agentId,
            projectRoot,
            sessionId,
            error: String(error),
          });
          return null;
        }
      }
    )
  );

  // NEW: Single-call grooming - spawns batch mode process with prompt
  // This is the recommended approach for context grooming
  ipcMain.handle(
    'context:groomContext',
    withIpcErrorLogging(
      handlerOpts('groomContext'),
      async (projectRoot: string, agentType: string, prompt: string): Promise<string> => {
        const processManager = requireDependency(getProcessManager, 'Process manager');
        const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

        const groomerSessionId = `groomer-${uuidv4()}`;

        logger.info('Starting context grooming (single-call)', LOG_CONTEXT, {
          groomerSessionId,
          projectRoot,
          agentType,
          promptLength: prompt.length,
        });
        console.log('[ContextMerge] Starting grooming:', groomerSessionId, 'prompt length:', prompt.length);

        // Get agent configuration
        const agent = await agentDetector.getAgent(agentType);
        if (!agent || !agent.available) {
          throw new Error(`Agent ${agentType} is not available`);
        }

        // Build args using the unified buildAgentArgs utility
        // This ensures consistent behavior across all agent types (batch mode, JSON output, etc.)
        const finalArgs = buildAgentArgs(agent, {
          baseArgs: agent.args || [],
          prompt: prompt,
          cwd: projectRoot,
          // Grooming doesn't need read-only mode, model selection, or YOLO mode
          readOnlyMode: false,
          modelId: undefined,
          yoloMode: false,
          agentSessionId: undefined,
        });

        // Track this grooming session
        activeGroomingSessions.set(groomerSessionId, {
          groomerSessionId,
          startTime: Date.now(),
        });

        // Create a promise that collects the response
        return new Promise<string>((resolve, reject) => {
          let responseBuffer = '';
          let lastDataTime = Date.now();
          let idleCheckInterval: NodeJS.Timeout | null = null;
          let resolved = false;
          let chunkCount = 0;

          const cleanup = () => {
            if (idleCheckInterval) {
              clearInterval(idleCheckInterval);
              idleCheckInterval = null;
            }
            processManager.off('data', onData);
            processManager.off('exit', onExit);
            processManager.off('agent-error', onError);
            activeGroomingSessions.delete(groomerSessionId);
          };

          const finishWithResponse = (reason: string) => {
            if (resolved) return;
            resolved = true;
            cleanup();

            logger.info('Grooming response collected', LOG_CONTEXT, {
              groomerSessionId,
              responseLength: responseBuffer.length,
              chunkCount,
              reason,
            });
            console.log('[ContextMerge] Grooming complete:', reason, 'length:', responseBuffer.length);

            resolve(responseBuffer);
          };

          const onData = (eventSessionId: string, data: string) => {
            if (eventSessionId !== groomerSessionId) return;

            chunkCount++;
            responseBuffer += data;
            lastDataTime = Date.now();

            if (chunkCount % 10 === 0 || chunkCount === 1) {
              console.log('[ContextMerge] Data chunk', chunkCount, 'total length:', responseBuffer.length);
            }
          };

          const onExit = (eventSessionId: string, exitCode: number) => {
            if (eventSessionId !== groomerSessionId) return;

            logger.info('Grooming process exited', LOG_CONTEXT, {
              groomerSessionId,
              exitCode,
              responseLength: responseBuffer.length,
            });

            finishWithResponse(`process exited with code ${exitCode}`);
          };

          const onError = (eventSessionId: string, error: unknown) => {
            if (eventSessionId !== groomerSessionId) return;

            cleanup();
            if (!resolved) {
              resolved = true;
              const errorMsg = error instanceof Error ? error.message : String(error);
              logger.error('Grooming error', LOG_CONTEXT, { groomerSessionId, error: errorMsg });
              reject(new Error(`Grooming error: ${errorMsg}`));
            }
          };

          // Listen for events BEFORE spawning
          processManager.on('data', onData);
          processManager.on('exit', onExit);
          processManager.on('agent-error', onError);

          // Spawn the process in batch mode using unified spawn config
          // finalArgs already includes batch mode args from buildAgentArgs
          const spawnResult = processManager.spawn({
            sessionId: groomerSessionId,
            toolType: agentType,
            cwd: projectRoot,
            command: agent.command,
            args: finalArgs,
            prompt: prompt, // Triggers batch mode (no PTY)
            noPromptSeparator: agent.noPromptSeparator, // OpenCode doesn't use '--' before prompt
          });

          if (!spawnResult || spawnResult.pid <= 0) {
            cleanup();
            reject(new Error(`Failed to spawn grooming process for ${agentType}`));
            return;
          }

          console.log('[ContextMerge] Spawned batch process, pid:', spawnResult.pid);

          // Set up idle check
          const IDLE_TIMEOUT_MS = 5000;
          const MIN_RESPONSE_LENGTH = 100;

          idleCheckInterval = setInterval(() => {
            const idleTime = Date.now() - lastDataTime;
            if (idleTime > IDLE_TIMEOUT_MS && responseBuffer.length >= MIN_RESPONSE_LENGTH) {
              finishWithResponse('idle timeout with content');
            }
          }, 1000);

          // Overall timeout
          setTimeout(() => {
            if (!resolved) {
              logger.warn('Grooming timeout', LOG_CONTEXT, {
                groomerSessionId,
                responseLength: responseBuffer.length,
              });

              if (responseBuffer.length > 0) {
                finishWithResponse('overall timeout with content');
              } else {
                cleanup();
                resolved = true;
                reject(new Error('Grooming timed out with no response'));
              }
            }
          }, GROOMING_TIMEOUT_MS);
        });
      }
    )
  );

  // DEPRECATED: Create a temporary grooming session (use groomContext instead)
  ipcMain.handle(
    'context:createGroomingSession',
    withIpcErrorLogging(
      handlerOpts('createGroomingSession'),
      async (projectRoot: string, agentType: string): Promise<string> => {
        const processManager = requireDependency(getProcessManager, 'Process manager');
        const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

        // Generate unique grooming session ID
        const groomerSessionId = `groomer-${uuidv4()}`;

        logger.info('Creating grooming session', LOG_CONTEXT, {
          groomerSessionId,
          projectRoot,
          agentType,
        });
        console.log('[ContextMerge] Creating grooming session:', groomerSessionId, 'for', agentType);

        // Get agent configuration
        const agent = await agentDetector.getAgent(agentType);
        if (!agent || !agent.available) {
          throw new Error(`Agent ${agentType} is not available`);
        }

        // Build base args for the agent in batch mode (if supported)
        const baseArgs = [...(agent.args || [])];

        // Add batch mode args if the agent supports it
        // For Claude Code, this means using --print --output-format stream-json
        if (agent.capabilities?.supportsBatchMode) {
          // The process manager will handle adding batch mode args
          // We just need to spawn the process with a prompt
        }

        // Spawn the grooming agent process
        const spawnResult = await processManager.spawn({
          sessionId: groomerSessionId,
          toolType: agentType,
          cwd: projectRoot,
          command: agent.command,
          args: baseArgs,
        });

        if (!spawnResult || spawnResult.pid <= 0) {
          throw new Error(`Failed to spawn grooming process for ${agentType}`);
        }

        // Track this grooming session
        activeGroomingSessions.set(groomerSessionId, {
          groomerSessionId,
          startTime: Date.now(),
        });

        // Set up timeout cleanup
        const timeoutId = setTimeout(() => {
          logger.warn('Grooming session timed out', LOG_CONTEXT, { groomerSessionId });
          cleanupGroomingSessionInternal(groomerSessionId, processManager);
        }, GROOMING_TIMEOUT_MS);

        // Store cleanup function
        const groomingSession = activeGroomingSessions.get(groomerSessionId);
        if (groomingSession) {
          groomingSession.cleanup = () => clearTimeout(timeoutId);
        }

        logger.info('Grooming session created', LOG_CONTEXT, {
          groomerSessionId,
          pid: spawnResult.pid,
        });
        console.log('[ContextMerge] Grooming session created, pid:', spawnResult.pid);

        return groomerSessionId;
      }
    )
  );

  // Send grooming prompt to a session and wait for the response
  console.log('[ContextMerge] About to register context:sendGroomingPrompt handler');
  try {
    ipcMain.handle(
      'context:sendGroomingPrompt',
      withIpcErrorLogging(
        handlerOpts('sendGroomingPrompt'),
        async (sessionId: string, prompt: string): Promise<string> => {
        const processManager = requireDependency(getProcessManager, 'Process manager');

        logger.info('Sending grooming prompt', LOG_CONTEXT, {
          sessionId,
          promptLength: prompt.length,
        });

        // Verify this is a valid grooming session
        const groomingSession = activeGroomingSessions.get(sessionId);
        if (!groomingSession) {
          throw new Error(`No active grooming session found: ${sessionId}`);
        }

        // Create a promise that collects the response and resolves when complete
        return new Promise<string>((resolve, reject) => {
          let responseBuffer = '';
          let lastDataTime = Date.now();
          let idleCheckInterval: NodeJS.Timeout | null = null;
          let resolved = false;

          // Track chunks received for logging
          let chunkCount = 0;

          const cleanup = () => {
            if (idleCheckInterval) {
              clearInterval(idleCheckInterval);
              idleCheckInterval = null;
            }
            processManager.off('data', onData);
            processManager.off('exit', onExit);
            processManager.off('agent-error', onError);
          };

          const finishWithResponse = (reason: string) => {
            if (resolved) return;
            resolved = true;
            cleanup();

            logger.info('Grooming response collected', LOG_CONTEXT, {
              sessionId,
              responseLength: responseBuffer.length,
              chunkCount,
              reason,
            });

            resolve(responseBuffer);
          };

          const onData = (eventSessionId: string, data: string) => {
            if (eventSessionId !== sessionId) return;

            chunkCount++;
            responseBuffer += data;
            lastDataTime = Date.now();

            // Log progress periodically
            if (chunkCount % 10 === 0 || chunkCount === 1) {
              logger.debug('Grooming data received', LOG_CONTEXT, {
                sessionId,
                chunkCount,
                totalLength: responseBuffer.length,
              });
              console.log('[ContextMerge] Data chunk', chunkCount, 'received, total length:', responseBuffer.length);
            }
          };

          const onExit = (eventSessionId: string, exitCode: number) => {
            if (eventSessionId !== sessionId) return;

            logger.info('Grooming session exited', LOG_CONTEXT, {
              sessionId,
              exitCode,
              responseLength: responseBuffer.length,
            });

            // Process exited - return whatever we collected
            finishWithResponse(`process exited with code ${exitCode}`);
          };

          const onError = (eventSessionId: string, error: unknown) => {
            if (eventSessionId !== sessionId) return;

            cleanup();
            if (!resolved) {
              resolved = true;
              const errorMsg = error instanceof Error ? error.message : String(error);
              logger.error('Grooming session error', LOG_CONTEXT, {
                sessionId,
                error: errorMsg,
              });
              reject(new Error(`Grooming session error: ${errorMsg}`));
            }
          };

          // Listen for events
          processManager.on('data', onData);
          processManager.on('exit', onExit);
          processManager.on('agent-error', onError);

          // Write the prompt to the process
          const success = processManager.write(sessionId, prompt + '\n');
          if (!success) {
            cleanup();
            reject(new Error(`Failed to write prompt to grooming session: ${sessionId}`));
            return;
          }

          logger.debug('Grooming prompt written to process', LOG_CONTEXT, {
            sessionId,
            promptLength: prompt.length,
          });
          console.log('[ContextMerge] Prompt written to process, waiting for response...');

          // Set up idle check - if no data for 5 seconds and we have content, consider it done
          // This handles cases where the process doesn't cleanly exit
          const IDLE_TIMEOUT_MS = 5000;
          const MIN_RESPONSE_LENGTH = 100; // Minimum response length to consider valid

          idleCheckInterval = setInterval(() => {
            const idleTime = Date.now() - lastDataTime;

            if (idleTime > IDLE_TIMEOUT_MS && responseBuffer.length >= MIN_RESPONSE_LENGTH) {
              logger.info('Grooming idle timeout reached with valid response', LOG_CONTEXT, {
                sessionId,
                idleTime,
                responseLength: responseBuffer.length,
              });
              finishWithResponse('idle timeout with content');
            }
          }, 1000);

          // Overall timeout - 2 minutes max
          setTimeout(() => {
            if (!resolved) {
              logger.warn('Grooming overall timeout reached', LOG_CONTEXT, {
                sessionId,
                responseLength: responseBuffer.length,
              });

              if (responseBuffer.length > 0) {
                finishWithResponse('overall timeout with content');
              } else {
                cleanup();
                resolved = true;
                reject(new Error('Grooming session timed out with no response'));
              }
            }
          }, GROOMING_TIMEOUT_MS);
        });
      }
    )
  );
    console.log('[ContextMerge] Successfully registered context:sendGroomingPrompt handler');
  } catch (error) {
    console.error('[ContextMerge] Failed to register context:sendGroomingPrompt handler:', error);
  }

  // Cleanup grooming session
  ipcMain.handle(
    'context:cleanupGroomingSession',
    withIpcErrorLogging(
      handlerOpts('cleanupGroomingSession'),
      async (sessionId: string): Promise<void> => {
        const processManager = requireDependency(getProcessManager, 'Process manager');

        logger.info('Cleaning up grooming session', LOG_CONTEXT, { sessionId });

        await cleanupGroomingSessionInternal(sessionId, processManager);
      }
    )
  );
}

/**
 * Internal helper to clean up a grooming session
 */
async function cleanupGroomingSessionInternal(
  sessionId: string,
  processManager: ProcessManager
): Promise<void> {
  const groomingSession = activeGroomingSessions.get(sessionId);

  if (groomingSession) {
    // Clear timeout if set
    if (groomingSession.cleanup) {
      groomingSession.cleanup();
    }

    // Remove from tracking
    activeGroomingSessions.delete(sessionId);

    logger.debug('Removed grooming session from tracking', LOG_CONTEXT, {
      sessionId,
      durationMs: Date.now() - groomingSession.startTime,
    });
  }

  // Kill the process
  try {
    processManager.kill(sessionId);
    logger.debug('Killed grooming session process', LOG_CONTEXT, { sessionId });
  } catch (error) {
    // Process may have already exited
    logger.debug('Could not kill grooming session (may have already exited)', LOG_CONTEXT, {
      sessionId,
      error: String(error),
    });
  }
}

/**
 * Get the number of active grooming sessions (for debugging/monitoring)
 */
export function getActiveGroomingSessionCount(): number {
  return activeGroomingSessions.size;
}

/**
 * Clean up all active grooming sessions (for graceful shutdown)
 */
export async function cleanupAllGroomingSessions(
  processManager: ProcessManager
): Promise<void> {
  logger.info('Cleaning up all grooming sessions', LOG_CONTEXT, {
    count: activeGroomingSessions.size,
  });

  const sessionIds = Array.from(activeGroomingSessions.keys());
  for (const sessionId of sessionIds) {
    await cleanupGroomingSessionInternal(sessionId, processManager);
  }
}
