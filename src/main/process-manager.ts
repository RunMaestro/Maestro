import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stripControlSequences, stripAllAnsiCodes } from './utils/terminalFilter';
import { logger } from './utils/logger';
import { getOutputParser, type ParsedEvent, type AgentOutputParser } from './parsers';
import { aggregateModelUsage } from './parsers/usage-aggregator';
import type { AgentError } from '../shared/types';
import { getAgentCapabilities } from './agent-capabilities';

// Re-export parser types for consumers
export type { ParsedEvent, AgentOutputParser } from './parsers';
export { getOutputParser } from './parsers';

// Re-export error types for consumers
export type { AgentError, AgentErrorType } from '../shared/types';

// Re-export usage types for backwards compatibility
export type { UsageStats, ModelStats } from './parsers/usage-aggregator';
export { aggregateModelUsage } from './parsers/usage-aggregator';

/**
 * Maximum buffer size for stdout/stderr error detection buffers.
 * Prevents memory exhaustion during extended process execution.
 * Only the last MAX_BUFFER_SIZE bytes are kept for error detection at exit.
 */
const MAX_BUFFER_SIZE = 100 * 1024; // 100KB

/**
 * Append to a buffer while enforcing max size limit.
 * If the buffer exceeds MAX_BUFFER_SIZE, keeps only the last MAX_BUFFER_SIZE bytes.
 */
function appendToBuffer(buffer: string, data: string, maxSize: number = MAX_BUFFER_SIZE): string {
  const combined = buffer + data;
  if (combined.length <= maxSize) {
    return combined;
  }
  // Keep only the last maxSize characters
  return combined.slice(-maxSize);
}

interface ProcessConfig {
  sessionId: string;
  toolType: string;
  cwd: string;
  command: string;
  args: string[];
  requiresPty?: boolean; // Whether this agent needs a pseudo-terminal
  prompt?: string; // For batch mode agents like Claude (passed as CLI argument)
  shell?: string; // Shell to use for terminal sessions (e.g., 'zsh', 'bash', 'fish', or full path)
  shellArgs?: string; // Additional CLI arguments for shell sessions (e.g., '--login')
  shellEnvVars?: Record<string, string>; // Environment variables for shell sessions
  images?: string[]; // Base64 data URLs for images (passed via stream-json input or file args)
  imageArgs?: (imagePath: string) => string[]; // Function to build image CLI args (e.g., ['-i', path] for Codex)
  contextWindow?: number; // Configured context window size (0 or undefined = not configured, hide UI)
  customEnvVars?: Record<string, string>; // Custom environment variables from user configuration
  noPromptSeparator?: boolean; // If true, don't add '--' before the prompt (e.g., OpenCode doesn't support it)
}

interface ManagedProcess {
  sessionId: string;
  toolType: string;
  ptyProcess?: pty.IPty;
  childProcess?: ChildProcess;
  cwd: string;
  pid: number;
  isTerminal: boolean;
  isBatchMode?: boolean; // True for agents that run in batch mode (exit after response)
  isStreamJsonMode?: boolean; // True when using stream-json input/output (for images)
  jsonBuffer?: string; // Buffer for accumulating JSON output in batch mode
  lastCommand?: string; // Last command sent to terminal (for filtering command echoes)
  sessionIdEmitted?: boolean; // True after session_id has been emitted (prevents duplicate emissions)
  resultEmitted?: boolean; // True after result data has been emitted (prevents duplicate emissions)
  errorEmitted?: boolean; // True after an error has been emitted (prevents duplicate error emissions)
  startTime: number; // Timestamp when process was spawned
  outputParser?: AgentOutputParser; // Parser for agent-specific JSON output
  stderrBuffer?: string; // Buffer for accumulating stderr output (for error detection)
  stdoutBuffer?: string; // Buffer for accumulating stdout output (for error detection at exit)
  streamedText?: string; // Buffer for accumulating streamed text from partial events (OpenCode, Codex)
  contextWindow?: number; // Configured context window size (0 or undefined = not configured)
  tempImageFiles?: string[]; // Temp files to clean up when process exits (for file-based image args)
  lastUsageTotals?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningTokens: number;
  };
  usageIsCumulative?: boolean;
}

/**
 * Parse a data URL and extract base64 data and media type
 */
function parseDataUrl(dataUrl: string): { base64: string; mediaType: string } | null {
  // Format: data:image/png;base64,iVBORw0KGgo...
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mediaType: match[1],
    base64: match[2],
  };
}

function normalizeCodexUsage(
  managedProcess: ManagedProcess,
  usageStats: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    totalCostUsd: number;
    contextWindow: number;
    reasoningTokens?: number;
  }
): typeof usageStats {
  const totals = {
    inputTokens: usageStats.inputTokens,
    outputTokens: usageStats.outputTokens,
    cacheReadInputTokens: usageStats.cacheReadInputTokens,
    cacheCreationInputTokens: usageStats.cacheCreationInputTokens,
    reasoningTokens: usageStats.reasoningTokens || 0,
  };

  const last = managedProcess.lastUsageTotals;
  const cumulativeFlag = managedProcess.usageIsCumulative;

  if (cumulativeFlag === false) {
    managedProcess.lastUsageTotals = totals;
    return usageStats;
  }

  if (!last) {
    managedProcess.lastUsageTotals = totals;
    return usageStats;
  }

  const delta = {
    inputTokens: totals.inputTokens - last.inputTokens,
    outputTokens: totals.outputTokens - last.outputTokens,
    cacheReadInputTokens: totals.cacheReadInputTokens - last.cacheReadInputTokens,
    cacheCreationInputTokens: totals.cacheCreationInputTokens - last.cacheCreationInputTokens,
    reasoningTokens: totals.reasoningTokens - last.reasoningTokens,
  };

  const isMonotonic =
    delta.inputTokens >= 0 &&
    delta.outputTokens >= 0 &&
    delta.cacheReadInputTokens >= 0 &&
    delta.cacheCreationInputTokens >= 0 &&
    delta.reasoningTokens >= 0;

  if (!isMonotonic) {
    managedProcess.usageIsCumulative = false;
    managedProcess.lastUsageTotals = totals;
    return usageStats;
  }

  managedProcess.usageIsCumulative = true;
  managedProcess.lastUsageTotals = totals;
  return {
    ...usageStats,
    inputTokens: delta.inputTokens,
    outputTokens: delta.outputTokens,
    cacheReadInputTokens: delta.cacheReadInputTokens,
    cacheCreationInputTokens: delta.cacheCreationInputTokens,
    reasoningTokens: delta.reasoningTokens,
  };
}

// UsageStats, ModelStats, and aggregateModelUsage are now imported from ./parsers/usage-aggregator
// and re-exported above for backwards compatibility

/**
 * Build a stream-json message for Claude Code with images and text
 */
function buildStreamJsonMessage(prompt: string, images: string[]): string {
  // Build content array with images first, then text
  const content: Array<{
    type: 'image' | 'text';
    text?: string;
    source?: { type: 'base64'; media_type: string; data: string };
  }> = [];

  // Add images
  for (const dataUrl of images) {
    const parsed = parseDataUrl(dataUrl);
    if (parsed) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: parsed.mediaType,
          data: parsed.base64,
        },
      });
    }
  }

  // Add text prompt
  content.push({
    type: 'text',
    text: prompt,
  });

  // Build the stream-json message
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  };

  return JSON.stringify(message);
}

/**
 * Save a base64 data URL image to a temp file.
 * Returns the full path to the temp file.
 */
function saveImageToTempFile(dataUrl: string, index: number): string | null {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    logger.warn('[ProcessManager] Failed to parse data URL for temp file', 'ProcessManager');
    return null;
  }

  // Determine file extension from media type
  const ext = parsed.mediaType.split('/')[1] || 'png';
  const filename = `maestro-image-${Date.now()}-${index}.${ext}`;
  const tempPath = path.join(os.tmpdir(), filename);

  try {
    // Convert base64 to buffer and write to file
    const buffer = Buffer.from(parsed.base64, 'base64');
    fs.writeFileSync(tempPath, buffer);
    logger.debug('[ProcessManager] Saved image to temp file', 'ProcessManager', { tempPath, size: buffer.length });
    return tempPath;
  } catch (error) {
    logger.error('[ProcessManager] Failed to save image to temp file', 'ProcessManager', { error: String(error) });
    return null;
  }
}

/**
 * Clean up temp image files.
 */
function cleanupTempFiles(files: string[]): void {
  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        logger.debug('[ProcessManager] Cleaned up temp file', 'ProcessManager', { file });
      }
    } catch (error) {
      logger.warn('[ProcessManager] Failed to clean up temp file', 'ProcessManager', { file, error: String(error) });
    }
  }
}

export class ProcessManager extends EventEmitter {
  private processes: Map<string, ManagedProcess> = new Map();

  /**
   * Spawn a new process for a session
   */
  spawn(config: ProcessConfig): { pid: number; success: boolean } {
    const { sessionId, toolType, cwd, command, args, requiresPty, prompt, shell, shellArgs, shellEnvVars, images, imageArgs, contextWindow, customEnvVars, noPromptSeparator } = config;

    // For batch mode with images, use stream-json mode and send message via stdin
    // For batch mode without images, append prompt to args with -- separator (unless noPromptSeparator is true)
    const hasImages = images && images.length > 0;
    const capabilities = getAgentCapabilities(toolType);
    let finalArgs: string[];
    let tempImageFiles: string[] = [];

    if (hasImages && prompt && capabilities.supportsStreamJsonInput) {
      // For agents that support stream-json input (like Claude Code), add the flag
      // The prompt will be sent via stdin as a JSON message with image data
      finalArgs = [...args, '--input-format', 'stream-json'];
    } else if (hasImages && prompt && imageArgs) {
      // For agents that use file-based image args (like Codex, OpenCode),
      // save images to temp files and add CLI args
      finalArgs = [...args]; // Start with base args
      tempImageFiles = [];
      for (let i = 0; i < images.length; i++) {
        const tempPath = saveImageToTempFile(images[i], i);
        if (tempPath) {
          tempImageFiles.push(tempPath);
          finalArgs = [...finalArgs, ...imageArgs(tempPath)];
        }
      }
      // Add the prompt at the end (with or without -- separator)
      if (noPromptSeparator) {
        finalArgs = [...finalArgs, prompt];
      } else {
        finalArgs = [...finalArgs, '--', prompt];
      }
      logger.debug('[ProcessManager] Using file-based image args', 'ProcessManager', {
        sessionId,
        imageCount: images.length,
        tempFiles: tempImageFiles,
      });
    } else if (prompt) {
      // Regular batch mode - prompt as CLI arg
      // The -- ensures prompt is treated as positional arg, not a flag (even if it starts with --)
      // Some agents (e.g., OpenCode) don't support the -- separator
      if (noPromptSeparator) {
        finalArgs = [...args, prompt];
      } else {
        finalArgs = [...args, '--', prompt];
      }
    } else {
      finalArgs = args;
    }

    logger.debug('[ProcessManager] spawn() config', 'ProcessManager', {
      sessionId,
      toolType,
      hasPrompt: !!prompt,
      hasImages,
      hasImageArgs: !!imageArgs,
      tempImageFilesCount: tempImageFiles.length,
      promptValue: prompt,
      baseArgs: args,
      finalArgs
    });

    // Determine if this should use a PTY:
    // - If toolType is 'terminal', always use PTY for full shell emulation
    // - If requiresPty is true, use PTY for AI agents that need TTY (like Claude Code)
    // - Batch mode (with prompt) never uses PTY
    const usePty = (toolType === 'terminal' || requiresPty === true) && !prompt;
    const isTerminal = toolType === 'terminal';

    try {
      if (usePty) {
        // Use node-pty for terminal mode or AI agents that require PTY
        let ptyCommand: string;
        let ptyArgs: string[];

        if (isTerminal) {
          // Full shell emulation for terminal mode
          // Use the provided shell (can be a shell ID like 'zsh' or a full path like '/usr/local/bin/zsh')
          if (shell) {
            ptyCommand = shell;
          } else {
            ptyCommand = process.platform === 'win32' ? 'powershell.exe' : 'bash';
          }
          // Use -l (login) AND -i (interactive) flags to spawn a fully configured shell
          // - Login shells source .zprofile/.bash_profile (system-wide PATH additions)
          // - Interactive shells source .zshrc/.bashrc (user customizations, aliases, functions)
          // Both are needed to match the user's regular terminal environment
          ptyArgs = process.platform === 'win32' ? [] : ['-l', '-i'];

          // Append custom shell arguments from user configuration
          if (shellArgs && shellArgs.trim()) {
            const customShellArgsArray = shellArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
            // Remove surrounding quotes from quoted args
            const cleanedArgs = customShellArgsArray.map(arg => {
              if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
                return arg.slice(1, -1);
              }
              return arg;
            });
            if (cleanedArgs.length > 0) {
              logger.debug('Appending custom shell args', 'ProcessManager', { shellArgs: cleanedArgs });
              ptyArgs = [...ptyArgs, ...cleanedArgs];
            }
          }
        } else {
          // Spawn the AI agent directly with PTY support
          ptyCommand = command;
          ptyArgs = finalArgs;
        }

        // Build environment for PTY process
        // For terminal sessions, pass minimal env with base system PATH.
        // Shell startup files (.zprofile, .zshrc) will prepend user paths (homebrew, go, etc.)
        // We need the base system paths or commands like sort, find, head won't work.
        let ptyEnv: NodeJS.ProcessEnv;
        if (isTerminal) {
          ptyEnv = {
            HOME: process.env.HOME,
            USER: process.env.USER,
            SHELL: process.env.SHELL,
            TERM: 'xterm-256color',
            LANG: process.env.LANG || 'en_US.UTF-8',
            // Provide base system PATH - shell startup files will prepend user paths
            PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          };

          // Apply custom shell environment variables from user configuration
          if (shellEnvVars && Object.keys(shellEnvVars).length > 0) {
            for (const [key, value] of Object.entries(shellEnvVars)) {
              ptyEnv[key] = value;
            }
            logger.debug('Applied custom shell env vars to PTY', 'ProcessManager', {
              keys: Object.keys(shellEnvVars)
            });
          }
        } else {
          // For AI agents in PTY mode: pass full env (they need NODE_PATH, etc.)
          ptyEnv = process.env;
        }

        const ptyProcess = pty.spawn(ptyCommand, ptyArgs, {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: cwd,
          env: ptyEnv as any,
        });

        const managedProcess: ManagedProcess = {
          sessionId,
          toolType,
          ptyProcess,
          cwd,
          pid: ptyProcess.pid,
          isTerminal: true,
          startTime: Date.now(),
        };

        this.processes.set(sessionId, managedProcess);

        // Handle output
        ptyProcess.onData((data) => {
          // Strip terminal control sequences and filter prompts/echoes
          const managedProc = this.processes.get(sessionId);
          const cleanedData = stripControlSequences(data, managedProc?.lastCommand, isTerminal);
          logger.debug('[ProcessManager] PTY onData', 'ProcessManager', { sessionId, pid: ptyProcess.pid, dataPreview: cleanedData.substring(0, 100) });
          // Only emit if there's actual content after filtering
          if (cleanedData.trim()) {
            this.emit('data', sessionId, cleanedData);
          }
        });

        ptyProcess.onExit(({ exitCode }) => {
          logger.debug('[ProcessManager] PTY onExit', 'ProcessManager', { sessionId, exitCode });
          this.emit('exit', sessionId, exitCode);
          this.processes.delete(sessionId);
        });

        logger.debug('[ProcessManager] PTY process created', 'ProcessManager', {
          sessionId,
          toolType,
          isTerminal,
          requiresPty: requiresPty || false,
          pid: ptyProcess.pid,
          command: ptyCommand,
          args: ptyArgs,
          cwd
        });

        return { pid: ptyProcess.pid, success: true };
      } else {
        // Use regular child_process for AI tools (including batch mode)

        // Fix PATH for Electron environment
        // Electron's main process may have a limited PATH that doesn't include
        // user-installed binaries like node, which is needed for #!/usr/bin/env node scripts
        const env = { ...process.env };
        const standardPaths = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
        if (env.PATH) {
          // Prepend standard paths if not already present
          if (!env.PATH.includes('/opt/homebrew/bin')) {
            env.PATH = `${standardPaths}:${env.PATH}`;
          }
        } else {
          env.PATH = standardPaths;
        }

        // Set MAESTRO_SESSION_RESUMED env var when resuming an existing session
        // This allows user hooks to differentiate between new sessions and resumed ones
        // See: https://github.com/pedramamini/Maestro/issues/42
        const isResuming = finalArgs.includes('--resume') || finalArgs.includes('--session');
        if (isResuming) {
          env.MAESTRO_SESSION_RESUMED = '1';
        }

        // Apply custom environment variables from user configuration
        // See: https://github.com/pedramamini/Maestro/issues/41
        if (customEnvVars && Object.keys(customEnvVars).length > 0) {
          for (const [key, value] of Object.entries(customEnvVars)) {
            env[key] = value;
          }
          logger.debug('[ProcessManager] Applied custom env vars', 'ProcessManager', {
            sessionId,
            keys: Object.keys(customEnvVars)
          });
        }

        logger.debug('[ProcessManager] About to spawn child process', 'ProcessManager', {
          command,
          finalArgs,
          cwd,
          PATH: env.PATH?.substring(0, 150),
          hasStdio: 'default (pipe)'
        });

        const childProcess = spawn(command, finalArgs, {
          cwd,
          env,
          shell: false, // Explicitly disable shell to prevent injection
          stdio: ['pipe', 'pipe', 'pipe'], // Explicitly set stdio to pipe
        });

        logger.debug('[ProcessManager] Child process spawned', 'ProcessManager', {
          pid: childProcess.pid,
          hasStdout: !!childProcess.stdout,
          hasStderr: !!childProcess.stderr,
          hasStdin: !!childProcess.stdin,
          killed: childProcess.killed,
          exitCode: childProcess.exitCode
        });

        const isBatchMode = !!prompt;
        // Detect JSON streaming mode from args:
        // - Claude Code: --output-format stream-json
        // - OpenCode: --format json
        // - Codex: --json
        // Also triggered when images are present (forces stream-json mode)
        const isStreamJsonMode = finalArgs.includes('stream-json') ||
          finalArgs.includes('--json') ||
          (finalArgs.includes('--format') && finalArgs.includes('json')) ||
          (hasImages && !!prompt);

        // Get the output parser for this agent type (if available)
        const outputParser = getOutputParser(toolType) || undefined;

        logger.debug('[ProcessManager] Output parser lookup', 'ProcessManager', {
          sessionId,
          toolType,
          hasParser: !!outputParser,
          parserId: outputParser?.agentId,
          isStreamJsonMode,
          isBatchMode
        });

        const managedProcess: ManagedProcess = {
          sessionId,
          toolType,
          childProcess,
          cwd,
          pid: childProcess.pid || -1,
          isTerminal: false,
          isBatchMode,
          isStreamJsonMode,
          jsonBuffer: isBatchMode ? '' : undefined,
          startTime: Date.now(),
          outputParser,
          stderrBuffer: '', // Initialize stderr buffer for error detection at exit
          stdoutBuffer: '', // Initialize stdout buffer for error detection at exit
          contextWindow, // User-configured context window size (0 = not configured)
          tempImageFiles: tempImageFiles.length > 0 ? tempImageFiles : undefined, // Temp files to clean up on exit
        };

        this.processes.set(sessionId, managedProcess);

        logger.debug('[ProcessManager] Setting up stdout/stderr/exit handlers', 'ProcessManager', {
          sessionId,
          hasStdout: childProcess.stdout ? 'exists' : 'null',
          hasStderr: childProcess.stderr ? 'exists' : 'null'
        });

        // Handle stdout
        if (childProcess.stdout) {
          logger.debug('[ProcessManager] Attaching stdout data listener', 'ProcessManager', { sessionId });
          childProcess.stdout.setEncoding('utf8'); // Ensure proper encoding
          childProcess.stdout.on('error', (err) => {
            logger.error('[ProcessManager] stdout error', 'ProcessManager', { sessionId, error: String(err) });
          });
          childProcess.stdout.on('data', (data: Buffer | string) => {
          const output = data.toString();

          // Debug: Log all stdout data for group chat sessions
          if (sessionId.includes('group-chat-')) {
            console.log(`[GroupChat:Debug:ProcessManager] STDOUT received for session ${sessionId}`);
            console.log(`[GroupChat:Debug:ProcessManager] Raw output length: ${output.length}`);
            console.log(`[GroupChat:Debug:ProcessManager] Raw output preview: "${output.substring(0, 500)}${output.length > 500 ? '...' : ''}"`);
          }

          if (isStreamJsonMode) {
            // In stream-json mode, each line is a JSONL message
            // Accumulate and process complete lines
            managedProcess.jsonBuffer = (managedProcess.jsonBuffer || '') + output;

            // Process complete lines
            const lines = managedProcess.jsonBuffer.split('\n');
            // Keep the last incomplete line in the buffer
            managedProcess.jsonBuffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) continue;

              // Accumulate stdout for error detection at exit (with size limit to prevent memory exhaustion)
              managedProcess.stdoutBuffer = appendToBuffer(managedProcess.stdoutBuffer || '', line + '\n');

              // Check for errors using the parser (if available)
              if (outputParser && !managedProcess.errorEmitted) {
                const agentError = outputParser.detectErrorFromLine(line);
                if (agentError) {
                  managedProcess.errorEmitted = true;
                  agentError.sessionId = sessionId;
                  logger.debug('[ProcessManager] Error detected from output', 'ProcessManager', {
                    sessionId,
                    errorType: agentError.type,
                    errorMessage: agentError.message,
                  });
                  this.emit('agent-error', sessionId, agentError);
                }
              }

              try {
                const msg = JSON.parse(line);

                // Use output parser for agents that have one (Codex, OpenCode, Claude Code)
                // This provides a unified way to extract session ID, usage, and data
                if (outputParser) {
                  const event = outputParser.parseJsonLine(line);

                  logger.debug('[ProcessManager] Parsed event from output parser', 'ProcessManager', {
                    sessionId,
                    eventType: event?.type,
                    hasText: !!event?.text,
                    textPreview: event?.text?.substring(0, 100),
                    isPartial: event?.isPartial,
                    isResultMessage: event ? outputParser.isResultMessage(event) : false,
                    resultEmitted: managedProcess.resultEmitted
                  });

                  if (event) {
                    // Extract usage statistics
                    const usage = outputParser.extractUsage(event);
                    if (usage) {
                      // Map parser's usage format to UsageStats
                      // For contextWindow: prefer user-configured value (from Maestro settings), then parser-reported value, then 0
                      // User configuration takes priority because they may be using a different model than detected
                      // A value of 0 signals the UI to hide context usage display
                      const usageStats = {
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                        cacheReadInputTokens: usage.cacheReadTokens || 0,
                        cacheCreationInputTokens: usage.cacheCreationTokens || 0,
                        totalCostUsd: usage.costUsd || 0,
                        contextWindow: managedProcess.contextWindow || usage.contextWindow || 0,
                        reasoningTokens: usage.reasoningTokens,
                      };
                      const normalizedUsageStats = managedProcess.toolType === 'codex'
                        ? normalizeCodexUsage(managedProcess, usageStats)
                        : usageStats;
                      this.emit('usage', sessionId, normalizedUsageStats);
                    }

                    // Extract session ID from parsed event (thread_id for Codex, session_id for Claude)
                    const eventSessionId = outputParser.extractSessionId(event);
                    if (eventSessionId && !managedProcess.sessionIdEmitted) {
                      managedProcess.sessionIdEmitted = true;
                      logger.debug('[ProcessManager] Emitting session-id event', 'ProcessManager', {
                        sessionId,
                        eventSessionId,
                        toolType: managedProcess.toolType,
                      });
                      this.emit('session-id', sessionId, eventSessionId);
                    }

                    // Extract slash commands from init events
                    const slashCommands = outputParser.extractSlashCommands(event);
                    if (slashCommands) {
                      this.emit('slash-commands', sessionId, slashCommands);
                    }

                    // Accumulate text from partial streaming events (OpenCode text messages)
                    // Skip error events - they're handled separately by detectErrorFromLine
                    if (event.type === 'text' && event.isPartial && event.text) {
                      managedProcess.streamedText = (managedProcess.streamedText || '') + event.text;
                    }

                    // Skip processing error events further - they're handled by agent-error emission
                    if (event.type === 'error') {
                      continue;
                    }

                    // Extract text data from result events (final complete response)
                    // For Codex: agent_message events have text directly
                    // For OpenCode: step_finish with reason="stop" triggers emission of accumulated text
                    if (outputParser.isResultMessage(event) && !managedProcess.resultEmitted) {
                      managedProcess.resultEmitted = true;
                      // Use event text if available, otherwise use accumulated streamed text
                      const resultText = event.text || managedProcess.streamedText || '';
                      if (resultText) {
                        logger.debug('[ProcessManager] Emitting result data via parser', 'ProcessManager', {
                          sessionId,
                          resultLength: resultText.length,
                          hasEventText: !!event.text,
                          hasStreamedText: !!managedProcess.streamedText
                        });
                        this.emit('data', sessionId, resultText);
                      }
                    }
                  }
                } else {
                  // Fallback for agents without parsers (legacy Claude Code format)
                  // Handle different message types from stream-json output

                  // Skip error messages in fallback mode - they're handled by detectErrorFromLine
                  if (msg.type === 'error' || msg.error) {
                    continue;
                  }

                  if (msg.type === 'result' && msg.result && !managedProcess.resultEmitted) {
                    managedProcess.resultEmitted = true;
                    logger.debug('[ProcessManager] Emitting result data', 'ProcessManager', { sessionId, resultLength: msg.result.length });
                    this.emit('data', sessionId, msg.result);
                  }
                  if (msg.session_id && !managedProcess.sessionIdEmitted) {
                    managedProcess.sessionIdEmitted = true;
                    this.emit('session-id', sessionId, msg.session_id);
                  }
                  if (msg.type === 'system' && msg.subtype === 'init' && msg.slash_commands) {
                    this.emit('slash-commands', sessionId, msg.slash_commands);
                  }
                  if (msg.modelUsage || msg.usage || msg.total_cost_usd !== undefined) {
                    const usageStats = aggregateModelUsage(
                      msg.modelUsage,
                      msg.usage || {},
                      msg.total_cost_usd || 0
                    );
                    this.emit('usage', sessionId, usageStats);
                  }
                }
              } catch (e) {
                // If it's not valid JSON, emit as raw text
                this.emit('data', sessionId, line);
              }
            }
          } else if (isBatchMode) {
            // In regular batch mode, accumulate JSON output
            managedProcess.jsonBuffer = (managedProcess.jsonBuffer || '') + output;
            logger.debug('[ProcessManager] Accumulated JSON buffer', 'ProcessManager', { sessionId, bufferLength: managedProcess.jsonBuffer.length });
          } else {
            // In interactive mode, emit data immediately
            this.emit('data', sessionId, output);
          }
          });
        } else {
          logger.warn('[ProcessManager] childProcess.stdout is null', 'ProcessManager', { sessionId });
        }

        // Handle stderr
        if (childProcess.stderr) {
          logger.debug('[ProcessManager] Attaching stderr data listener', 'ProcessManager', { sessionId });
          childProcess.stderr.setEncoding('utf8');
          childProcess.stderr.on('error', (err) => {
            logger.error('[ProcessManager] stderr error', 'ProcessManager', { sessionId, error: String(err) });
          });
          childProcess.stderr.on('data', (data: Buffer | string) => {
            const stderrData = data.toString();
            logger.debug('[ProcessManager] stderr event fired', 'ProcessManager', { sessionId, dataPreview: stderrData.substring(0, 100) });

            // Debug: Log all stderr data for group chat sessions
            if (sessionId.includes('group-chat-')) {
              console.log(`[GroupChat:Debug:ProcessManager] STDERR received for session ${sessionId}`);
              console.log(`[GroupChat:Debug:ProcessManager] Stderr length: ${stderrData.length}`);
              console.log(`[GroupChat:Debug:ProcessManager] Stderr preview: "${stderrData.substring(0, 500)}${stderrData.length > 500 ? '...' : ''}"`);
            }

            // Accumulate stderr for error detection at exit (with size limit to prevent memory exhaustion)
            managedProcess.stderrBuffer = appendToBuffer(managedProcess.stderrBuffer || '', stderrData);

            // Check for errors in stderr using the parser (if available)
            if (outputParser && !managedProcess.errorEmitted) {
              const agentError = outputParser.detectErrorFromLine(stderrData);
              if (agentError) {
                managedProcess.errorEmitted = true;
                agentError.sessionId = sessionId;
                logger.debug('[ProcessManager] Error detected from stderr', 'ProcessManager', {
                  sessionId,
                  errorType: agentError.type,
                  errorMessage: agentError.message,
                });
                this.emit('agent-error', sessionId, agentError);
              }
            }

            // Strip ANSI codes and only emit if there's actual content
            const cleanedStderr = stripAllAnsiCodes(stderrData).trim();
            if (cleanedStderr) {
              // Emit to separate 'stderr' event for AI processes (consistent with runCommand)
              this.emit('stderr', sessionId, cleanedStderr);
            }
          });
        }

        // Handle exit
        childProcess.on('exit', (code) => {
          logger.debug('[ProcessManager] Child process exit event', 'ProcessManager', {
            sessionId,
            code,
            isBatchMode,
            isStreamJsonMode,
            jsonBufferLength: managedProcess.jsonBuffer?.length || 0,
            jsonBufferPreview: managedProcess.jsonBuffer?.substring(0, 200)
          });

          // Debug: Log exit details for group chat sessions
          if (sessionId.includes('group-chat-')) {
            console.log(`[GroupChat:Debug:ProcessManager] EXIT for session ${sessionId}`);
            console.log(`[GroupChat:Debug:ProcessManager] Exit code: ${code}`);
            console.log(`[GroupChat:Debug:ProcessManager] isStreamJsonMode: ${isStreamJsonMode}`);
            console.log(`[GroupChat:Debug:ProcessManager] isBatchMode: ${isBatchMode}`);
            console.log(`[GroupChat:Debug:ProcessManager] resultEmitted: ${managedProcess.resultEmitted}`);
            console.log(`[GroupChat:Debug:ProcessManager] streamedText length: ${managedProcess.streamedText?.length || 0}`);
            console.log(`[GroupChat:Debug:ProcessManager] jsonBuffer length: ${managedProcess.jsonBuffer?.length || 0}`);
            console.log(`[GroupChat:Debug:ProcessManager] stderrBuffer length: ${managedProcess.stderrBuffer?.length || 0}`);
            console.log(`[GroupChat:Debug:ProcessManager] stderrBuffer preview: "${(managedProcess.stderrBuffer || '').substring(0, 500)}"`);
          }
          if (isBatchMode && !isStreamJsonMode && managedProcess.jsonBuffer) {
            // Parse JSON response from regular batch mode (not stream-json)
            try {
              const jsonResponse = JSON.parse(managedProcess.jsonBuffer);

              // Emit the result text (only once per process)
              if (jsonResponse.result && !managedProcess.resultEmitted) {
                managedProcess.resultEmitted = true;
                this.emit('data', sessionId, jsonResponse.result);
              }

              // Emit session_id if present (only once per process)
              if (jsonResponse.session_id && !managedProcess.sessionIdEmitted) {
                managedProcess.sessionIdEmitted = true;
                this.emit('session-id', sessionId, jsonResponse.session_id);
              }

              // Extract and emit usage statistics
              if (jsonResponse.modelUsage || jsonResponse.usage || jsonResponse.total_cost_usd !== undefined) {
                const usageStats = aggregateModelUsage(
                  jsonResponse.modelUsage,
                  jsonResponse.usage || {},
                  jsonResponse.total_cost_usd || 0
                );
                this.emit('usage', sessionId, usageStats);
              }
            } catch (error) {
              logger.error('[ProcessManager] Failed to parse JSON response', 'ProcessManager', { sessionId, error: String(error) });
              // Emit raw buffer as fallback
              this.emit('data', sessionId, managedProcess.jsonBuffer);
            }
          }

          // Check for errors using the parser (if not already emitted)
          // Note: Some agents (OpenCode) may exit with code 0 but still have errors
          // The parser's detectErrorFromExit handles both non-zero exit and the
          // "exit 0 with stderr but no stdout" case
          if (outputParser && !managedProcess.errorEmitted) {
            const agentError = outputParser.detectErrorFromExit(
              code || 0,
              managedProcess.stderrBuffer || '',
              managedProcess.stdoutBuffer || managedProcess.streamedText || ''
            );
            if (agentError) {
              managedProcess.errorEmitted = true;
              agentError.sessionId = sessionId;
              logger.debug('[ProcessManager] Error detected from exit', 'ProcessManager', {
                sessionId,
                exitCode: code,
                errorType: agentError.type,
                errorMessage: agentError.message,
              });
              this.emit('agent-error', sessionId, agentError);
            }
          }

          // Clean up temp image files if any
          if (managedProcess.tempImageFiles && managedProcess.tempImageFiles.length > 0) {
            cleanupTempFiles(managedProcess.tempImageFiles);
          }

          this.emit('exit', sessionId, code || 0);
          this.processes.delete(sessionId);
        });

        childProcess.on('error', (error) => {
          logger.error('[ProcessManager] Child process error', 'ProcessManager', { sessionId, error: error.message });

          // Emit agent error for process spawn failures
          if (!managedProcess.errorEmitted) {
            managedProcess.errorEmitted = true;
            const agentError: AgentError = {
              type: 'agent_crashed',
              message: `Agent process error: ${error.message}`,
              recoverable: true,
              agentId: toolType,
              sessionId,
              timestamp: Date.now(),
              raw: {
                stderr: error.message,
              },
            };
            this.emit('agent-error', sessionId, agentError);
          }

          // Clean up temp image files if any
          if (managedProcess.tempImageFiles && managedProcess.tempImageFiles.length > 0) {
            cleanupTempFiles(managedProcess.tempImageFiles);
          }

          this.emit('data', sessionId, `[error] ${error.message}`);
          this.emit('exit', sessionId, 1); // Ensure exit is emitted on error
          this.processes.delete(sessionId);
        });

        // Handle stdin for batch mode
        if (isStreamJsonMode && prompt && images) {
          // Stream-json mode with images: send the message via stdin
          const streamJsonMessage = buildStreamJsonMessage(prompt, images);
          logger.debug('[ProcessManager] Sending stream-json message with images', 'ProcessManager', {
            sessionId,
            messageLength: streamJsonMessage.length,
            imageCount: images.length
          });
          childProcess.stdin?.write(streamJsonMessage + '\n');
          childProcess.stdin?.end(); // Signal end of input
        } else if (isBatchMode) {
          // Regular batch mode: close stdin immediately since prompt is passed as CLI arg
          // Some CLIs wait for stdin to close before processing
          logger.debug('[ProcessManager] Closing stdin for batch mode', 'ProcessManager', { sessionId });
          childProcess.stdin?.end();
        }

        return { pid: childProcess.pid || -1, success: true };
      }
    } catch (error: any) {
      logger.error('[ProcessManager] Failed to spawn process', 'ProcessManager', { error: String(error) });
      return { pid: -1, success: false };
    }
  }

  /**
   * Write data to a process's stdin
   */
  write(sessionId: string, data: string): boolean {
    const process = this.processes.get(sessionId);
    if (!process) {
      logger.error('[ProcessManager] write() - No process found for session', 'ProcessManager', { sessionId });
      return false;
    }

    logger.debug('[ProcessManager] write() - Process info', 'ProcessManager', {
      sessionId,
      toolType: process.toolType,
      isTerminal: process.isTerminal,
      pid: process.pid,
      hasPtyProcess: !!process.ptyProcess,
      hasChildProcess: !!process.childProcess,
      hasStdin: !!process.childProcess?.stdin,
      dataLength: data.length,
      dataPreview: data.substring(0, 50)
    });

    try {
      if (process.isTerminal && process.ptyProcess) {
        logger.debug('[ProcessManager] Writing to PTY process', 'ProcessManager', { sessionId, pid: process.pid });
        // Track the command for filtering echoes (remove trailing newline for comparison)
        const command = data.replace(/\r?\n$/, '');
        if (command.trim()) {
          process.lastCommand = command.trim();
        }
        process.ptyProcess.write(data);
        return true;
      } else if (process.childProcess?.stdin) {
        logger.debug('[ProcessManager] Writing to child process stdin', 'ProcessManager', { sessionId, pid: process.pid });
        process.childProcess.stdin.write(data);
        return true;
      }
      logger.error('[ProcessManager] No valid input stream for session', 'ProcessManager', { sessionId });
      return false;
    } catch (error) {
      logger.error('[ProcessManager] Failed to write to process', 'ProcessManager', { sessionId, error: String(error) });
      return false;
    }
  }

  /**
   * Resize terminal (for pty processes)
   */
  resize(sessionId: string, cols: number, rows: number): boolean {
    const process = this.processes.get(sessionId);
    if (!process || !process.isTerminal || !process.ptyProcess) return false;

    try {
      process.ptyProcess.resize(cols, rows);
      return true;
    } catch (error) {
      logger.error('[ProcessManager] Failed to resize terminal', 'ProcessManager', { sessionId, error: String(error) });
      return false;
    }
  }

  /**
   * Send interrupt signal (SIGINT/Ctrl+C) to a process
   * This attempts a graceful interrupt first, like pressing Ctrl+C
   */
  interrupt(sessionId: string): boolean {
    const process = this.processes.get(sessionId);
    if (!process) {
      logger.error('[ProcessManager] interrupt() - No process found for session', 'ProcessManager', { sessionId });
      return false;
    }

    try {
      if (process.isTerminal && process.ptyProcess) {
        // For PTY processes, send Ctrl+C character
        logger.debug('[ProcessManager] Sending Ctrl+C to PTY process', 'ProcessManager', { sessionId, pid: process.pid });
        process.ptyProcess.write('\x03'); // Ctrl+C
        return true;
      } else if (process.childProcess) {
        // For child processes, send SIGINT signal
        logger.debug('[ProcessManager] Sending SIGINT to child process', 'ProcessManager', { sessionId, pid: process.pid });
        process.childProcess.kill('SIGINT');
        return true;
      }
      logger.error('[ProcessManager] No valid process to interrupt for session', 'ProcessManager', { sessionId });
      return false;
    } catch (error) {
      logger.error('[ProcessManager] Failed to interrupt process', 'ProcessManager', { sessionId, error: String(error) });
      return false;
    }
  }

  /**
   * Kill a specific process
   */
  kill(sessionId: string): boolean {
    const process = this.processes.get(sessionId);
    if (!process) return false;

    try {
      if (process.isTerminal && process.ptyProcess) {
        process.ptyProcess.kill();
      } else if (process.childProcess) {
        process.childProcess.kill('SIGTERM');
      }
      this.processes.delete(sessionId);
      return true;
    } catch (error) {
      logger.error('[ProcessManager] Failed to kill process', 'ProcessManager', { sessionId, error: String(error) });
      return false;
    }
  }

  /**
   * Kill all managed processes
   */
  killAll(): void {
    for (const [sessionId] of this.processes) {
      this.kill(sessionId);
    }
  }

  /**
   * Get all active processes
   */
  getAll(): ManagedProcess[] {
    return Array.from(this.processes.values());
  }

  /**
   * Get a specific process
   */
  get(sessionId: string): ManagedProcess | undefined {
    return this.processes.get(sessionId);
  }

  /**
   * Get the output parser for a session's agent type
   * @param sessionId - The session ID
   * @returns The parser or null if not available
   */
  getParser(sessionId: string): AgentOutputParser | null {
    const process = this.processes.get(sessionId);
    return process?.outputParser || null;
  }

  /**
   * Parse a JSON line using the appropriate parser for the session
   * @param sessionId - The session ID
   * @param line - The JSON line to parse
   * @returns ParsedEvent or null if no parser or invalid
   */
  parseLine(sessionId: string, line: string): ParsedEvent | null {
    const parser = this.getParser(sessionId);
    if (!parser) {
      return null;
    }
    return parser.parseJsonLine(line);
  }

  /**
   * Run a single command and capture stdout/stderr cleanly
   * This does NOT use PTY - it spawns the command directly via shell -c
   * and captures only the command output without prompts or echoes.
   *
   * @param sessionId - Session ID for event emission
   * @param command - The shell command to execute
   * @param cwd - Working directory
   * @param shell - Shell to use (default: bash)
   * @param shellEnvVars - Additional environment variables for the shell
   * @returns Promise that resolves when command completes
   */
  runCommand(
    sessionId: string,
    command: string,
    cwd: string,
    shell: string = 'bash',
    shellEnvVars?: Record<string, string>
  ): Promise<{ exitCode: number }> {
    return new Promise((resolve) => {
      logger.debug('[ProcessManager] runCommand()', 'ProcessManager', { sessionId, command, cwd, shell, hasEnvVars: !!shellEnvVars });

      // Build the command with shell config sourcing
      // This ensures PATH, aliases, and functions are available
      const shellName = shell.split('/').pop() || shell;
      let wrappedCommand: string;

      if (shellName === 'fish') {
        // Fish auto-sources config.fish, just run the command
        wrappedCommand = command;
      } else if (shellName === 'zsh') {
        // Source both .zprofile (login shell - PATH setup) and .zshrc (interactive - aliases, functions)
        // This matches what a login interactive shell does (zsh -l -i)
        // Without eval, the shell parses the command before configs are sourced, so aliases aren't available
        const escapedCommand = command.replace(/'/g, "'\\''");
        wrappedCommand = `source ~/.zprofile 2>/dev/null; source ~/.zshrc 2>/dev/null; eval '${escapedCommand}'`;
      } else if (shellName === 'bash') {
        // Source both .bash_profile (login shell) and .bashrc (interactive)
        const escapedCommand = command.replace(/'/g, "'\\''");
        wrappedCommand = `source ~/.bash_profile 2>/dev/null; source ~/.bashrc 2>/dev/null; eval '${escapedCommand}'`;
      } else {
        // Other POSIX-compatible shells
        wrappedCommand = command;
      }

      // Pass minimal environment with a base PATH for essential system commands.
      // Shell startup files (.zprofile, .zshrc) will prepend user paths to this.
      // We need the base system paths or commands like sort, find, head won't work.
      const env: NodeJS.ProcessEnv = {
        HOME: process.env.HOME,
        USER: process.env.USER,
        SHELL: process.env.SHELL,
        TERM: 'xterm-256color',
        LANG: process.env.LANG || 'en_US.UTF-8',
        // Provide base system PATH - shell startup files will prepend user paths (homebrew, go, etc.)
        PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      };

      // Apply custom shell environment variables from user configuration
      if (shellEnvVars && Object.keys(shellEnvVars).length > 0) {
        for (const [key, value] of Object.entries(shellEnvVars)) {
          env[key] = value;
        }
        logger.debug('[ProcessManager] Applied custom shell env vars to runCommand', 'ProcessManager', {
          keys: Object.keys(shellEnvVars)
        });
      }

      // Resolve shell to full path - Electron's internal PATH may not include /bin
      // where common shells like zsh and bash are located
      let shellPath = shell;
      if (!shell.includes('/')) {
        const fs = require('fs');
        const commonPaths = ['/bin/', '/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/'];
        for (const prefix of commonPaths) {
          try {
            fs.accessSync(prefix + shell, fs.constants.X_OK);
            shellPath = prefix + shell;
            break;
          } catch {
            // Try next path
          }
        }
      }

      logger.debug('[ProcessManager] runCommand spawning', 'ProcessManager', { shell, shellPath, wrappedCommand, cwd, PATH: env.PATH?.substring(0, 100) });

      const childProcess = spawn(wrappedCommand, [], {
        cwd,
        env,
        shell: shellPath, // Use resolved full path to shell
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';

      // Handle stdout - emit data events for real-time streaming
      childProcess.stdout?.on('data', (data: Buffer) => {
        let output = data.toString();
        logger.debug('[ProcessManager] runCommand stdout RAW', 'ProcessManager', { sessionId, rawLength: output.length, rawPreview: output.substring(0, 200) });

        // Filter out shell integration sequences that may appear in interactive shells
        // These include iTerm2, VSCode, and other terminal emulator integration markers
        // Format: ]1337;..., ]133;..., ]7;... (with or without ESC prefix)
        output = output.replace(/\x1b?\]1337;[^\x07\x1b\n]*(\x07|\x1b\\)?/g, '');
        output = output.replace(/\x1b?\]133;[^\x07\x1b\n]*(\x07|\x1b\\)?/g, '');
        output = output.replace(/\x1b?\]7;[^\x07\x1b\n]*(\x07|\x1b\\)?/g, '');
        // Remove OSC sequences for window title, etc.
        output = output.replace(/\x1b?\][0-9];[^\x07\x1b\n]*(\x07|\x1b\\)?/g, '');

        logger.debug('[ProcessManager] runCommand stdout FILTERED', 'ProcessManager', { sessionId, filteredLength: output.length, filteredPreview: output.substring(0, 200), trimmedEmpty: !output.trim() });

        // Only emit if there's actual content after filtering
        if (output.trim()) {
          stdoutBuffer += output;
          logger.debug('[ProcessManager] runCommand EMITTING data event', 'ProcessManager', { sessionId, outputLength: output.length });
          this.emit('data', sessionId, output);
        } else {
          logger.debug('[ProcessManager] runCommand SKIPPED emit (empty after trim)', 'ProcessManager', { sessionId });
        }
      });

      // Handle stderr - emit with [stderr] prefix for differentiation
      childProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        stderrBuffer += output;
        // Emit stderr with prefix so renderer can style it differently
        this.emit('stderr', sessionId, output);
      });

      // Handle process exit
      childProcess.on('exit', (code) => {
        logger.debug('[ProcessManager] runCommand exit', 'ProcessManager', { sessionId, exitCode: code });
        this.emit('command-exit', sessionId, code || 0);
        resolve({ exitCode: code || 0 });
      });

      // Handle errors (e.g., spawn failures)
      childProcess.on('error', (error) => {
        logger.error('[ProcessManager] runCommand error', 'ProcessManager', { sessionId, error: error.message });
        this.emit('stderr', sessionId, `Error: ${error.message}`);
        this.emit('command-exit', sessionId, 1);
        resolve({ exitCode: 1 });
      });
    });
  }
}
