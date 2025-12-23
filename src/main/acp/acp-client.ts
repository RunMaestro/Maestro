/**
 * ACP (Agent Client Protocol) Client Implementation
 *
 * A client for communicating with ACP-compatible agents like OpenCode.
 * Uses JSON-RPC 2.0 over stdio to communicate with the agent process.
 *
 * @see https://agentclientprotocol.com/protocol/overview
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface, Interface } from 'readline';
import { logger } from '../utils/logger';
import type {
  RequestId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  Implementation,
  ClientCapabilities,
  AgentCapabilities,
  InitializeRequest,
  InitializeResponse,
  SessionId,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  ContentBlock,
  SessionNotification,
  SessionUpdate,
  CancelNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
} from './types';
import { CURRENT_PROTOCOL_VERSION } from './types';

const LOG_CONTEXT = '[ACPClient]';

/**
 * Events emitted by the ACP client
 */
export interface ACPClientEvents {
  /** Session update notification from agent */
  'session:update': (sessionId: SessionId, update: SessionUpdate) => void;
  /** Permission request from agent */
  'session:permission_request': (
    request: RequestPermissionRequest,
    respond: (response: RequestPermissionResponse) => void
  ) => void;
  /** File read request from agent */
  'fs:read': (
    request: ReadTextFileRequest,
    respond: (response: ReadTextFileResponse) => void
  ) => void;
  /** File write request from agent */
  'fs:write': (
    request: WriteTextFileRequest,
    respond: (response: WriteTextFileResponse) => void
  ) => void;
  /** Terminal create request from agent */
  'terminal:create': (
    request: CreateTerminalRequest,
    respond: (response: CreateTerminalResponse) => void
  ) => void;
  /** Terminal output request from agent */
  'terminal:output': (
    request: TerminalOutputRequest,
    respond: (response: TerminalOutputResponse) => void
  ) => void;
  /** Error occurred */
  error: (error: Error) => void;
  /** Client disconnected */
  disconnected: () => void;
}

/**
 * Configuration for ACP client
 */
export interface ACPClientConfig {
  /** Command to spawn the agent (e.g., 'opencode') */
  command: string;
  /** Arguments for the agent command (e.g., ['acp']) */
  args: string[];
  /** Working directory for the agent process */
  cwd: string;
  /** Environment variables for the agent process */
  env?: Record<string, string>;
  /** Client info to send during initialization */
  clientInfo?: Implementation;
  /** Client capabilities */
  clientCapabilities?: ClientCapabilities;
}

/**
 * ACP Client for communicating with agents via JSON-RPC over stdio
 */
export class ACPClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    RequestId,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      method: string;
    }
  >();
  private config: ACPClientConfig;
  private isConnected = false;
  private agentCapabilities: AgentCapabilities | null = null;
  private agentInfo: Implementation | null = null;

  constructor(config: ACPClientConfig) {
    super();
    this.config = config;
  }

  /**
   * Start the agent process and initialize the connection
   */
  async connect(): Promise<InitializeResponse> {
    if (this.isConnected) {
      throw new Error('Already connected');
    }

    logger.info(`Starting ACP agent: ${this.config.command} ${this.config.args.join(' ')}`, LOG_CONTEXT);

    // Spawn the agent process
    this.process = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error('Failed to create agent process with stdio');
    }

    // Set up readline for line-by-line JSON-RPC parsing
    this.readline = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    this.readline.on('line', (line) => this.handleLine(line));

    this.process.stderr?.on('data', (data) => {
      logger.warn(`Agent stderr: ${data.toString()}`, LOG_CONTEXT);
    });

    this.process.on('close', (code) => {
      logger.info(`Agent process exited with code ${code}`, LOG_CONTEXT);
      this.handleDisconnect();
    });

    this.process.on('error', (error) => {
      logger.error(`Agent process error: ${error.message}`, LOG_CONTEXT);
      this.emit('error', error);
    });

    // Send initialize request
    const initRequest: InitializeRequest = {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      clientInfo: this.config.clientInfo || {
        name: 'maestro',
        version: '0.12.0',
        title: 'Maestro',
      },
      clientCapabilities: this.config.clientCapabilities || {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    };

    const response = (await this.sendRequest('initialize', initRequest)) as InitializeResponse;

    this.agentCapabilities = response.agentCapabilities || null;
    this.agentInfo = response.agentInfo || null;
    this.isConnected = true;

    logger.info(
      `Connected to agent: ${this.agentInfo?.name || 'unknown'} v${this.agentInfo?.version || '?'}`,
      LOG_CONTEXT
    );

    return response;
  }

  /**
   * Disconnect from the agent
   */
  disconnect(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.handleDisconnect();
  }

  /**
   * Create a new session
   */
  async newSession(cwd: string): Promise<NewSessionResponse> {
    const request: NewSessionRequest = {
      cwd,
      mcpServers: [], // No MCP servers for now
    };
    return (await this.sendRequest('session/new', request)) as NewSessionResponse;
  }

  /**
   * Load an existing session
   */
  async loadSession(sessionId: SessionId, cwd: string): Promise<LoadSessionResponse> {
    if (!this.agentCapabilities?.loadSession) {
      throw new Error('Agent does not support loading sessions');
    }
    const request: LoadSessionRequest = {
      sessionId,
      cwd,
      mcpServers: [],
    };
    return (await this.sendRequest('session/load', request)) as LoadSessionResponse;
  }

  /**
   * Send a prompt to the agent
   * 
   * Note: ACP ContentBlock format is { type: 'text', text: 'content' }
   * not { text: { text: 'content' } } as the union type suggests
   */
  async prompt(sessionId: SessionId, text: string): Promise<PromptResponse> {
    // ACP uses a simpler content block format for text
    const contentBlock = {
      type: 'text',
      text,
    };
    const request: PromptRequest = {
      sessionId,
      prompt: [contentBlock as unknown as ContentBlock],
    };
    return (await this.sendRequest('session/prompt', request)) as PromptResponse;
  }

  /**
   * Send a prompt with images
   */
  async promptWithImages(
    sessionId: SessionId,
    text: string,
    images: Array<{ data: string; mimeType: string }>
  ): Promise<PromptResponse> {
    const contentBlocks: ContentBlock[] = [{ text: { text } }];

    for (const image of images) {
      contentBlocks.push({
        image: {
          data: image.data,
          mimeType: image.mimeType,
        },
      });
    }

    const request: PromptRequest = {
      sessionId,
      prompt: contentBlocks,
    };
    return (await this.sendRequest('session/prompt', request)) as PromptResponse;
  }

  /**
   * Cancel ongoing operations for a session
   */
  cancel(sessionId: SessionId): void {
    const notification: CancelNotification = { sessionId };
    this.sendNotification('session/cancel', notification);
  }

  /**
   * Get agent capabilities
   */
  getAgentCapabilities(): AgentCapabilities | null {
    return this.agentCapabilities;
  }

  /**
   * Get agent info
   */
  getAgentInfo(): Implementation | null {
    return this.agentInfo;
  }

  /**
   * Check if connected
   */
  getIsConnected(): boolean {
    return this.isConnected;
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private handleLine(line: string): void {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line);

      if ('id' in message && message.id !== null) {
        // This is a response to a request we sent
        if ('result' in message || 'error' in message) {
          this.handleResponse(message as JsonRpcResponse);
        } else {
          // This is a request from the agent to us
          this.handleAgentRequest(message as JsonRpcRequest);
        }
      } else if ('method' in message) {
        // This is a notification
        this.handleNotification(message as JsonRpcNotification);
      }
    } catch (error) {
      logger.error(`Failed to parse JSON-RPC message: ${line}`, LOG_CONTEXT);
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      logger.warn(`Received response for unknown request: ${response.id}`, LOG_CONTEXT);
      return;
    }

    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(new Error(`${response.error.message} (code: ${response.error.code})`));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    switch (notification.method) {
      case 'session/update': {
        const params = notification.params as SessionNotification;
        // OpenCode uses a slightly different format: { sessionUpdate: 'type', ...data }
        // Convert to standard format if needed
        const update = this.normalizeSessionUpdate(params.update || params);
        this.emit('session:update', params.sessionId, update);
        break;
      }
      default:
        logger.debug(`Unhandled notification: ${notification.method}`, LOG_CONTEXT);
    }
  }

  /**
   * Normalize session update format from OpenCode
   * OpenCode sends: { sessionUpdate: 'agent_message_chunk', content: {...} }
   * We need: { agent_message_chunk: { content: {...} } }
   */
  private normalizeSessionUpdate(update: unknown): SessionUpdate {
    const raw = update as Record<string, unknown>;
    
    if ('sessionUpdate' in raw) {
      const updateType = raw.sessionUpdate as string;
      const { sessionUpdate, ...rest } = raw;
      
      // Convert to standard ACP format
      return { [updateType]: rest } as unknown as SessionUpdate;
    }
    
    return update as SessionUpdate;
  }

  private handleAgentRequest(request: JsonRpcRequest): void {
    const respond = (result: unknown) => {
      this.sendResponse(request.id, result);
    };

    const respondError = (code: number, message: string) => {
      this.sendErrorResponse(request.id, code, message);
    };

    switch (request.method) {
      case 'session/request_permission': {
        const params = request.params as RequestPermissionRequest;
        this.emit('session:permission_request', params, (response: RequestPermissionResponse) => {
          respond(response);
        });
        break;
      }
      case 'fs/read_text_file': {
        const params = request.params as ReadTextFileRequest;
        this.emit('fs:read', params, (response: ReadTextFileResponse) => {
          respond(response);
        });
        break;
      }
      case 'fs/write_text_file': {
        const params = request.params as WriteTextFileRequest;
        this.emit('fs:write', params, (response: WriteTextFileResponse) => {
          respond(response);
        });
        break;
      }
      case 'terminal/create': {
        const params = request.params as CreateTerminalRequest;
        this.emit('terminal:create', params, (response: CreateTerminalResponse) => {
          respond(response);
        });
        break;
      }
      case 'terminal/output': {
        const params = request.params as TerminalOutputRequest;
        this.emit('terminal:output', params, (response: TerminalOutputResponse) => {
          respond(response);
        });
        break;
      }
      default:
        logger.warn(`Unhandled agent request: ${request.method}`, LOG_CONTEXT);
        respondError(-32601, `Method not found: ${request.method}`);
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, { resolve, reject, method });

      const line = JSON.stringify(request) + '\n';
      logger.debug(`Sending request: ${method} (id: ${id})`, LOG_CONTEXT);

      if (!this.process?.stdin?.writable) {
        reject(new Error('Agent process is not writable'));
        return;
      }

      this.process.stdin.write(line);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const line = JSON.stringify(notification) + '\n';
    logger.debug(`Sending notification: ${method}`, LOG_CONTEXT);

    if (this.process?.stdin?.writable) {
      this.process.stdin.write(line);
    }
  }

  private sendResponse(id: RequestId, result: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };

    const line = JSON.stringify(response) + '\n';

    if (this.process?.stdin?.writable) {
      this.process.stdin.write(line);
    }
  }

  private sendErrorResponse(id: RequestId, code: number, message: string): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };

    const line = JSON.stringify(response) + '\n';

    if (this.process?.stdin?.writable) {
      this.process.stdin.write(line);
    }
  }

  private handleDisconnect(): void {
    this.isConnected = false;
    this.readline?.close();
    this.readline = null;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('Connection closed'));
      this.pendingRequests.delete(id);
    }

    this.emit('disconnected');
  }
}
