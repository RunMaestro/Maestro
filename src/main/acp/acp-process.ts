/**
 * ACP Process Wrapper
 *
 * Wraps an ACPClient to provide the same interface as ProcessManager
 * for ACP-enabled agents like OpenCode.
 *
 * This allows seamless switching between:
 * - Standard mode: spawn process → parse stdout JSON
 * - ACP mode: ACPClient → JSON-RPC over stdio
 */

import { EventEmitter } from 'events';
import { ACPClient, type ACPClientConfig } from './acp-client';
import {
  acpUpdateToParseEvent,
  createSessionIdEvent,
  createResultEvent,
} from './acp-adapter';
import type { SessionUpdate, SessionId } from './types';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[ACPProcess]';

export interface ACPProcessConfig {
  /** Maestro session ID */
  sessionId: string;
  /** Agent type (e.g., 'opencode') */
  toolType: string;
  /** Working directory */
  cwd: string;
  /** Command to run (e.g., 'opencode') */
  command: string;
  /** Initial prompt to send */
  prompt?: string;
  /** Images to include with prompt */
  images?: Array<{ data: string; mimeType: string }>;
  /** ACP session ID for resume */
  acpSessionId?: string;
  /** Custom environment variables */
  customEnvVars?: Record<string, string>;
  /** Context window size */
  contextWindow?: number;
}

/**
 * Represents an ACP-based agent process.
 * Emits the same events as ProcessManager for compatibility:
 * - 'data': parsed event data
 * - 'exit': process exit
 * - 'agent-error': agent errors
 */
export class ACPProcess extends EventEmitter {
  private client: ACPClient;
  private config: ACPProcessConfig;
  private acpSessionId: SessionId | null = null;
  private streamedText = ''; // Text accumulated during current prompt
  private emittedTextLength = 0; // Track how much text we've emitted (for deduplication within a response)
  private totalAccumulatedText = ''; // All text across all prompts (for cross-prompt deduplication)
  private startTime: number;
  private isLoadingSession = false; // Track if we're loading a session (to ignore historical messages)

  constructor(config: ACPProcessConfig) {
    super();
    this.config = config;
    this.startTime = Date.now();

    // Create ACP client
    const clientConfig: ACPClientConfig = {
      command: config.command,
      args: ['acp'], // ACP mode
      cwd: config.cwd,
      env: config.customEnvVars,
      clientInfo: {
        name: 'maestro',
        version: '0.12.0',
        title: 'Maestro',
      },
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    };

    this.client = new ACPClient(clientConfig);

    // Wire up ACP events
    this.setupEventHandlers();
  }

  /**
   * Get the PID of the spawned OpenCode process
   */
  get pid(): number {
    const process = this.client.getProcess();
    return process?.pid ?? -1;
  }

  /**
   * Get session info for compatibility
   */
  getInfo(): {
    sessionId: string;
    toolType: string;
    pid: number;
    cwd: string;
    isTerminal: boolean;
    isBatchMode: boolean;
    startTime: number;
    command: string;
    args: string[];
  } {
    return {
      sessionId: this.config.sessionId,
      toolType: this.config.toolType,
      pid: this.pid,
      cwd: this.config.cwd,
      isTerminal: false,
      isBatchMode: true,
      startTime: this.startTime,
      command: this.config.command,
      args: ['acp'],
    };
  }

  /**
   * Connect to ACP agent and run the initial prompt
   */
  async start(): Promise<{ pid: number; success: boolean }> {
    try {
      logger.info(`Starting ACP process for ${this.config.toolType}`, LOG_CONTEXT, {
        sessionId: this.config.sessionId,
        command: this.config.command,
        hasPrompt: !!this.config.prompt,
      });

      // Connect to the ACP agent
      const initResponse = await this.client.connect();

      logger.info(`ACP connected to ${initResponse.agentInfo?.name}`, LOG_CONTEXT, {
        version: initResponse.agentInfo?.version,
        protocolVersion: initResponse.protocolVersion,
      });

      // Create or load session
      if (this.config.acpSessionId) {
        // Resume existing session
        // Set flag to ignore historical messages during session load
        this.isLoadingSession = true;
        await this.client.loadSession(this.config.acpSessionId, this.config.cwd);
        this.acpSessionId = this.config.acpSessionId;
        // Clear flag after session load completes
        this.isLoadingSession = false;
        logger.debug('Session loaded, ignoring historical messages received during load', LOG_CONTEXT);
      } else {
        // Create new session
        const sessionResponse = await this.client.newSession(this.config.cwd);
        this.acpSessionId = sessionResponse.sessionId;
      }

      // Emit session_id event
      const sessionIdEvent = createSessionIdEvent(this.acpSessionId);
      this.emit('data', this.config.sessionId, sessionIdEvent);

      // If we have a prompt, send it
      if (this.config.prompt) {
        this.sendPrompt(this.config.prompt);
      }

      return { pid: this.pid, success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to start ACP process: ${message}`, LOG_CONTEXT);

      this.emit('agent-error', this.config.sessionId, {
        type: 'unknown',
        message,
        recoverable: false,
      });
      this.emit('exit', this.config.sessionId, 1);

      return { pid: -1, success: false };
    }
  }

  /**
   * Send a prompt to the agent
   */
  async sendPrompt(text: string): Promise<void> {
    if (!this.acpSessionId) {
      logger.error('Cannot send prompt: no ACP session', LOG_CONTEXT);
      return;
    }

    // Clear streamed text for new prompt (but keep totalAccumulatedText for cross-prompt dedup)
    this.streamedText = '';
    this.emittedTextLength = 0; // Reset emission tracker for new prompt

    try {
      logger.debug(`Sending prompt to ACP agent`, LOG_CONTEXT, {
        sessionId: this.config.sessionId,
        promptLength: text.length,
      });

      let response;
      if (this.config.images && this.config.images.length > 0) {
        response = await this.client.promptWithImages(
          this.acpSessionId,
          text,
          this.config.images
        );
      } else {
        response = await this.client.prompt(this.acpSessionId, text);
      }

      logger.debug('Received prompt response from ACP agent', LOG_CONTEXT, {
        stopReason: response.stopReason,
        hasUsage: !!response.usage,
        usage: response.usage,
      });

      // Workaround for OpenCode bug: Remove previous response if it's repeated
      // OpenCode may send cumulative text (all previous messages + new message)
      let finalText = this.streamedText;
      if (this.totalAccumulatedText && finalText.startsWith(this.totalAccumulatedText)) {
        // Agent repeated the previous response - extract only the new part
        const newContent = finalText.substring(this.totalAccumulatedText.length);
        logger.debug('Detected cumulative response, extracting delta', LOG_CONTEXT, {
          previousLength: this.totalAccumulatedText.length,
          totalLength: finalText.length,
          deltaLength: newContent.length,
        });
        finalText = newContent;
      }

      // Update total accumulated text for next deduplication check
      this.totalAccumulatedText += finalText;

      // Emit final result event to signal completion
      // Include finalText (deduplicated) so ProcessManager can emit it if streaming was disabled
      const resultEvent = createResultEvent(
        this.config.sessionId,
        finalText, // Use deduplicated text
        response.stopReason,
        response.usage // Include usage stats from response
      );
      this.emit('data', this.config.sessionId, resultEvent);

      // If stop reason indicates completion, emit exit
      if (response.stopReason === 'end_turn' || response.stopReason === 'cancelled') {
        this.emit('exit', this.config.sessionId, 0);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`ACP prompt failed: ${message}`, LOG_CONTEXT);

      this.emit('agent-error', this.config.sessionId, {
        type: 'unknown',
        message,
        recoverable: false,
      });
    }
  }

  /**
   * Write data to the agent (for follow-up prompts)
   */
  async write(data: string): Promise<void> {
    // In ACP mode, writing is sending a new prompt
    await this.sendPrompt(data);
  }

  /**
   * Cancel ongoing operations
   */
  cancel(): void {
    if (this.acpSessionId) {
      this.client.cancel(this.acpSessionId);
    }
  }

  /**
   * Kill the ACP process
   */
  kill(): void {
    this.client.disconnect();
    this.emit('exit', this.config.sessionId, 0);
  }

  /**
   * Interrupt (same as cancel for ACP)
   */
  interrupt(): void {
    this.cancel();
  }

  /**
   * Set up event handlers for ACP client
   */
  private setupEventHandlers(): void {
    // Handle session updates
    this.client.on('session:update', (sessionId: SessionId, update: SessionUpdate) => {
      // Ignore updates during session load - these are historical messages
      if (this.isLoadingSession) {
        logger.debug('Ignoring session update during session load (historical message)', LOG_CONTEXT, {
          updateKeys: Object.keys(update)
        });
        return;
      }

      const event = acpUpdateToParseEvent(sessionId, update);
      if (event) {
        // Accumulate text for final result
        if (event.type === 'text' && event.text) {
          this.streamedText += event.text;
          
          // Deduplication: Check against totalAccumulatedText (cross-prompt) + within-prompt tracking
          // Calculate the absolute position in the total accumulated text
          const absolutePosition = this.totalAccumulatedText.length + this.emittedTextLength;
          const totalCurrentLength = this.totalAccumulatedText.length + this.streamedText.length;
          
          if (totalCurrentLength > absolutePosition) {
            // Extract only the new portion that hasn't been emitted yet
            const fullText = this.totalAccumulatedText + this.streamedText;
            const newText = fullText.substring(absolutePosition);
            this.emittedTextLength = this.streamedText.length; // Update within-prompt tracker
            
            // Emit only the delta
            const deltaEvent = { ...event, text: newText };
            this.emit('data', this.config.sessionId, deltaEvent);
          }
          // Skip emitting if we've already sent this text
        } else {
          // Non-text events - emit as-is
          this.emit('data', this.config.sessionId, event);
        }
      }
    });

    // Handle permission requests (auto-approve in YOLO mode)
    this.client.on('session:permission_request', (request, respond) => {
      logger.debug(`ACP permission request: ${request.toolCall.title}`, LOG_CONTEXT);

      // Find allow option and auto-approve
      const allowOption = request.options.find(
        (o: { kind: string; optionId: string }) => o.kind === 'allow_once' || o.kind === 'allow_always'
      );
      if (allowOption) {
        respond({ outcome: { selected: { optionId: allowOption.optionId } } });
      } else {
        respond({ outcome: { cancelled: {} } });
      }
    });

    // Handle file system read requests
    this.client.on('fs:read', async (request, respond) => {
      try {
        const fs = await import('fs');
        const content = fs.readFileSync(request.path, 'utf-8');
        respond({ content });
      } catch {
        logger.error(`Failed to read file: ${request.path}`, LOG_CONTEXT);
        respond({ content: '' });
      }
    });

    // Handle file system write requests
    this.client.on('fs:write', async (request, respond) => {
      try {
        const fs = await import('fs');
        fs.writeFileSync(request.path, request.content, 'utf-8');
        respond({});
      } catch {
        logger.error(`Failed to write file: ${request.path}`, LOG_CONTEXT);
        respond({});
      }
    });

    // Handle disconnection
    this.client.on('disconnected', () => {
      logger.info('ACP client disconnected', LOG_CONTEXT);
    });

    // Handle errors
    this.client.on('error', (error) => {
      logger.error(`ACP client error: ${error.message}`, LOG_CONTEXT);
      this.emit('agent-error', this.config.sessionId, {
        type: 'unknown',
        message: error.message,
        recoverable: false,
      });
    });
  }
}

/**
 * Create and start an ACP process
 */
export async function spawnACPProcess(
  config: ACPProcessConfig
): Promise<{ process: ACPProcess; pid: number; success: boolean }> {
  const process = new ACPProcess(config);
  const result = await process.start();
  return { process, ...result };
}
