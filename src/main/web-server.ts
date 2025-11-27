import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WebSocket } from 'ws';
import crypto from 'crypto';

// Types for web client messages
interface WebClientMessage {
  type: string;
  [key: string]: unknown;
}

// Web client connection info
interface WebClient {
  socket: WebSocket;
  id: string;
  connectedAt: number;
  authenticated: boolean;
}

// Authentication configuration
export interface WebAuthConfig {
  enabled: boolean;
  token: string | null;
}

// Rate limiting configuration
export interface RateLimitConfig {
  // Maximum requests per time window
  max: number;
  // Time window in milliseconds
  timeWindow: number;
  // Maximum requests for POST endpoints (typically lower)
  maxPost: number;
  // Enable/disable rate limiting
  enabled: boolean;
}

/**
 * WebServer - HTTP and WebSocket server for remote access
 *
 * STATUS: Partial implementation (Phase 6 - Remote Access & Tunneling)
 *
 * Current functionality:
 * - Health check endpoint (/health) - WORKING
 * - WebSocket echo endpoint (/ws) - PLACEHOLDER (echoes messages for connectivity testing)
 * - Session list endpoint (/api/sessions) - WORKING (returns actual session data)
 * - Session detail endpoint (/api/session/:id) - WORKING (returns detailed session info)
 * - Web interface WebSocket (/ws/web) - WORKING (real-time updates, authentication)
 * - Authentication (token-based) - WORKING
 * - Rate limiting - WORKING
 *
 * Phase 6 implementation plan:
 * - Integrate with ProcessManager to expose real session data
 * - Implement real-time session state broadcasting via WebSocket
 * - Stream process output to connected clients
 * - Handle input commands from remote clients
 * - Support mobile/tablet responsive UI
 * - Integrate with ngrok tunneling for public access
 *
 * See PRD.md Phase 6 for full requirements.
 */
// Callback type for fetching sessions data
export type GetSessionsCallback = () => Array<{
  id: string;
  name: string;
  toolType: string;
  state: string;
  inputMode: string;
  cwd: string;
}>;

// Session detail type for single session endpoint
export interface SessionDetail {
  id: string;
  name: string;
  toolType: string;
  state: string;
  inputMode: string;
  cwd: string;
  aiLogs?: Array<{ timestamp: number; content: string; type?: string }>;
  shellLogs?: Array<{ timestamp: number; content: string; type?: string }>;
  usageStats?: {
    inputTokens?: number;
    outputTokens?: number;
    totalCost?: number;
  };
  claudeSessionId?: string;
  isGitRepo?: boolean;
}

// Callback type for fetching single session details
export type GetSessionDetailCallback = (sessionId: string) => SessionDetail | null;

// Theme type for web clients (matches renderer/types/index.ts)
export interface WebTheme {
  id: string;
  name: string;
  mode: 'light' | 'dark' | 'vibe';
  colors: {
    bgMain: string;
    bgSidebar: string;
    bgActivity: string;
    border: string;
    textMain: string;
    textDim: string;
    accent: string;
    accentDim: string;
    accentText: string;
    success: string;
    warning: string;
    error: string;
  };
}

// Callback type for fetching current theme
export type GetThemeCallback = () => WebTheme | null;

// Default rate limit configuration
const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  max: 100,           // 100 requests per minute for GET endpoints
  timeWindow: 60000,  // 1 minute in milliseconds
  maxPost: 30,        // 30 requests per minute for POST endpoints (more restrictive)
  enabled: true,
};

export class WebServer {
  private server: FastifyInstance;
  private port: number;
  private isRunning: boolean = false;
  private webClients: Map<string, WebClient> = new Map();
  private clientIdCounter: number = 0;
  private authConfig: WebAuthConfig = { enabled: false, token: null };
  private rateLimitConfig: RateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG };
  private getSessionsCallback: GetSessionsCallback | null = null;
  private getSessionDetailCallback: GetSessionDetailCallback | null = null;
  private getThemeCallback: GetThemeCallback | null = null;

  constructor(port: number = 8000) {
    this.port = port;
    this.server = Fastify({
      logger: {
        level: 'info',
      },
    });

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Set the callback function for fetching current sessions list
   * This is called when a new client connects to send the initial state
   */
  setGetSessionsCallback(callback: GetSessionsCallback) {
    this.getSessionsCallback = callback;
  }

  /**
   * Set the callback function for fetching single session details
   * This is called by the /api/session/:id endpoint
   */
  setGetSessionDetailCallback(callback: GetSessionDetailCallback) {
    this.getSessionDetailCallback = callback;
  }

  /**
   * Set the callback function for fetching current theme
   * This is called when a new client connects to send the initial theme
   */
  setGetThemeCallback(callback: GetThemeCallback) {
    this.getThemeCallback = callback;
  }

  /**
   * Set the authentication configuration
   */
  setAuthConfig(config: WebAuthConfig) {
    this.authConfig = config;
    console.log(`Web server auth ${config.enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get the current authentication configuration
   */
  getAuthConfig(): WebAuthConfig {
    return { ...this.authConfig };
  }

  /**
   * Set the rate limiting configuration
   */
  setRateLimitConfig(config: Partial<RateLimitConfig>) {
    this.rateLimitConfig = { ...this.rateLimitConfig, ...config };
    console.log(`Web server rate limiting ${this.rateLimitConfig.enabled ? 'enabled' : 'disabled'} (max: ${this.rateLimitConfig.max}/min, maxPost: ${this.rateLimitConfig.maxPost}/min)`);
  }

  /**
   * Get the current rate limiting configuration
   */
  getRateLimitConfig(): RateLimitConfig {
    return { ...this.rateLimitConfig };
  }

  /**
   * Generate a new random authentication token
   */
  static generateToken(): string {
    // Generate a 6-character alphanumeric PIN (easy to type on mobile)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars like 0/O, 1/I/L
    let token = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
      token += chars[bytes[i] % chars.length];
    }
    return token;
  }

  /**
   * Validate an authentication token
   */
  validateToken(token: string): boolean {
    if (!this.authConfig.enabled || !this.authConfig.token) {
      return true; // Auth disabled, all tokens valid
    }
    return token.toUpperCase() === this.authConfig.token.toUpperCase();
  }

  /**
   * Authentication hook for protected REST API routes
   * Used as a preHandler for routes that require authentication
   *
   * Usage: this.server.get('/protected', { preHandler: this.authenticateRequest.bind(this) }, handler)
   */
  authenticateRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!this.authConfig.enabled || !this.authConfig.token) {
      return; // Auth disabled, allow all
    }

    // Check for token in Authorization header (Bearer token) or X-Auth-Token header
    const authHeader = request.headers.authorization;
    const xAuthToken = request.headers['x-auth-token'] as string | undefined;

    let token: string | null = null;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (xAuthToken) {
      token = xAuthToken;
    }

    if (!token || !this.validateToken(token)) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Valid authentication token required. Provide token via Authorization header (Bearer <token>) or X-Auth-Token header.'
      });
      return reply;
    }
  };

  private async setupMiddleware() {
    // Enable CORS for web access
    await this.server.register(cors, {
      origin: true,
    });

    // Enable WebSocket support
    await this.server.register(websocket);

    // Enable rate limiting for web interface endpoints to prevent abuse
    // Rate limiting is applied globally but can be overridden per-route
    await this.server.register(rateLimit, {
      global: false, // Don't apply to all routes by default (we'll apply selectively)
      max: this.rateLimitConfig.max,
      timeWindow: this.rateLimitConfig.timeWindow,
      // Custom error response
      errorResponseBuilder: (
        _request: FastifyRequest,
        context: { statusCode: number; ban: boolean; after: string; max: number; ttl: number }
      ) => {
        return {
          statusCode: 429,
          error: 'Too Many Requests',
          message: `Rate limit exceeded. You can make ${context.max} requests per ${context.after}. Try again later.`,
          retryAfter: context.after,
        };
      },
      // Allow list function to skip rate limiting for certain requests
      allowList: (request: FastifyRequest) => {
        // Skip rate limiting if disabled
        if (!this.rateLimitConfig.enabled) return true;
        // Allow health checks without rate limiting
        if (request.url === '/health') return true;
        return false;
      },
      // Use IP address as the rate limit key
      keyGenerator: (request: FastifyRequest) => {
        // Use X-Forwarded-For if available (for proxied requests), otherwise use IP
        const forwarded = request.headers['x-forwarded-for'];
        if (forwarded) {
          const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0].trim();
          return ip;
        }
        return request.ip;
      },
    });
  }

  private setupRoutes() {
    // Health check
    this.server.get('/health', async () => {
      return { status: 'ok', timestamp: Date.now() };
    });

    // WebSocket endpoint for real-time updates
    // NOTE: This is a placeholder implementation for Phase 6 (Remote Access & Tunneling)
    // Current behavior: Echoes messages back to test connectivity
    // Future implementation (Phase 6):
    // - Broadcast session state changes to all connected clients
    // - Stream process output in real-time
    // - Handle input commands from remote clients
    // - Implement authentication and authorization
    // - Support multiple simultaneous connections
    this.server.get('/ws', { websocket: true }, (connection) => {
      connection.socket.on('message', (message) => {
        // PLACEHOLDER: Echo back for testing connectivity only
        connection.socket.send(JSON.stringify({
          type: 'echo',
          data: message.toString(),
        }));
      });

      connection.socket.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to Maestro WebSocket',
      }));
    });

    // Session list endpoint - returns all sessions with their current states
    // Rate limited using GET rate limit config
    this.server.get('/api/sessions', {
      preHandler: this.authenticateRequest.bind(this),
      config: {
        rateLimit: {
          max: this.rateLimitConfig.max,
          timeWindow: this.rateLimitConfig.timeWindow,
        },
      },
    }, async () => {
      const sessions = this.getSessionsCallback ? this.getSessionsCallback() : [];
      return {
        sessions,
        count: sessions.length,
        timestamp: Date.now(),
      };
    });

    // Session detail endpoint - returns detailed information for a specific session
    // Rate limited using GET rate limit config
    this.server.get('/api/session/:id', {
      preHandler: this.authenticateRequest.bind(this),
      config: {
        rateLimit: {
          max: this.rateLimitConfig.max,
          timeWindow: this.rateLimitConfig.timeWindow,
        },
      },
    }, async (request, reply) => {
      const { id } = request.params as { id: string };

      if (!this.getSessionDetailCallback) {
        reply.code(503).send({
          error: 'Service Unavailable',
          message: 'Session detail service not configured',
          timestamp: Date.now(),
        });
        return;
      }

      const session = this.getSessionDetailCallback(id);

      if (!session) {
        reply.code(404).send({
          error: 'Not Found',
          message: `Session with id '${id}' not found`,
          timestamp: Date.now(),
        });
        return;
      }

      return {
        session,
        timestamp: Date.now(),
      };
    });

    // Setup web interface routes under /web/* namespace
    this.setupWebInterfaceRoutes();
  }

  /**
   * Setup routes for the web interface under /web/* namespace
   *
   * This namespace is dedicated to the new web interface that provides:
   * - Desktop Web: Full-featured collaborative interface for hackathons/team coding
   * - Mobile Web: Lightweight remote control for sending commands from phone
   *
   * Future routes planned:
   * - /web/desktop - Desktop web interface entry point
   * - /web/mobile - Mobile web interface entry point
   * - /web/api/* - REST API endpoints for web clients
   * - /ws/web - WebSocket endpoint for real-time updates to web clients
   *
   * Rate limiting is applied to all web interface endpoints to prevent abuse.
   */
  private setupWebInterfaceRoutes() {
    // Rate limit configuration for GET endpoints
    const getRateLimitConfig = {
      config: {
        rateLimit: {
          max: this.rateLimitConfig.max,
          timeWindow: this.rateLimitConfig.timeWindow,
        },
      },
    };

    // Rate limit configuration for POST endpoints (more restrictive)
    const postRateLimitConfig = {
      config: {
        rateLimit: {
          max: this.rateLimitConfig.maxPost,
          timeWindow: this.rateLimitConfig.timeWindow,
        },
      },
    };

    // Web interface root - returns info about available interfaces
    this.server.get('/web', getRateLimitConfig, async () => {
      return {
        name: 'Maestro Web Interface',
        version: '1.0.0',
        interfaces: {
          desktop: '/web/desktop',
          mobile: '/web/mobile',
        },
        api: '/web/api',
        websocket: '/ws/web',
        timestamp: Date.now(),
      };
    });

    // Desktop web interface entry point (placeholder)
    this.server.get('/web/desktop', getRateLimitConfig, async () => {
      return {
        message: 'Desktop web interface - Coming soon',
        description: 'Full-featured collaborative interface for hackathons/team coding',
      };
    });

    // Desktop web interface with wildcard for client-side routing
    this.server.get('/web/desktop/*', getRateLimitConfig, async () => {
      return {
        message: 'Desktop web interface - Coming soon',
        description: 'Full-featured collaborative interface for hackathons/team coding',
      };
    });

    // Mobile web interface entry point (placeholder)
    this.server.get('/web/mobile', getRateLimitConfig, async () => {
      return {
        message: 'Mobile web interface - Coming soon',
        description: 'Lightweight remote control for sending commands from your phone',
      };
    });

    // Mobile web interface with wildcard for client-side routing
    this.server.get('/web/mobile/*', getRateLimitConfig, async () => {
      return {
        message: 'Mobile web interface - Coming soon',
        description: 'Lightweight remote control for sending commands from your phone',
      };
    });

    // Web API namespace root
    this.server.get('/web/api', getRateLimitConfig, async () => {
      return {
        name: 'Maestro Web API',
        version: '1.0.0',
        endpoints: {
          sessions: '/web/api/sessions',
          theme: '/web/api/theme',
          rateLimit: '/web/api/rate-limit',
        },
        timestamp: Date.now(),
      };
    });

    // Rate limit status endpoint - allows clients to check current limits
    this.server.get('/web/api/rate-limit', getRateLimitConfig, async () => {
      return {
        enabled: this.rateLimitConfig.enabled,
        limits: {
          get: {
            max: this.rateLimitConfig.max,
            timeWindowMs: this.rateLimitConfig.timeWindow,
            timeWindowDescription: `${this.rateLimitConfig.timeWindow / 1000} seconds`,
          },
          post: {
            max: this.rateLimitConfig.maxPost,
            timeWindowMs: this.rateLimitConfig.timeWindow,
            timeWindowDescription: `${this.rateLimitConfig.timeWindow / 1000} seconds`,
          },
        },
        timestamp: Date.now(),
      };
    });

    // WebSocket endpoint for web interface clients
    // This provides real-time updates for session state, theme changes, and log streaming
    // Authentication: If auth is enabled, client must send { type: 'auth', token: '<token>' } first
    this.server.get('/ws/web', { websocket: true }, (connection, request) => {
      const clientId = `web-client-${++this.clientIdCounter}`;

      // Check if auth is required
      const authRequired = this.authConfig.enabled && this.authConfig.token;

      // Check for token in query string (allows direct connection with ?token=XXX)
      const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
      const queryToken = url.searchParams.get('token');
      const initiallyAuthenticated = queryToken ? this.validateToken(queryToken) : !authRequired;

      const client: WebClient = {
        socket: connection.socket,
        id: clientId,
        connectedAt: Date.now(),
        authenticated: initiallyAuthenticated,
      };

      this.webClients.set(clientId, client);
      console.log(`Web client connected: ${clientId} (authenticated: ${client.authenticated}, total: ${this.webClients.size})`);

      if (client.authenticated) {
        // Send connection confirmation with client ID
        connection.socket.send(JSON.stringify({
          type: 'connected',
          clientId,
          message: 'Connected to Maestro Web Interface',
          authenticated: true,
          timestamp: Date.now(),
        }));

        // Send initial sessions list to newly connected client
        if (this.getSessionsCallback) {
          const sessions = this.getSessionsCallback();
          connection.socket.send(JSON.stringify({
            type: 'sessions_list',
            sessions,
            timestamp: Date.now(),
          }));
        }

        // Send current theme to newly connected client
        if (this.getThemeCallback) {
          const theme = this.getThemeCallback();
          if (theme) {
            connection.socket.send(JSON.stringify({
              type: 'theme',
              theme,
              timestamp: Date.now(),
            }));
          }
        }
      } else {
        // Send auth required message
        connection.socket.send(JSON.stringify({
          type: 'auth_required',
          clientId,
          message: 'Authentication required. Send { type: "auth", token: "<token>" } to authenticate.',
          timestamp: Date.now(),
        }));
      }

      // Handle incoming messages from web clients
      connection.socket.on('message', (message) => {
        try {
          const data = JSON.parse(message.toString()) as WebClientMessage;

          // Handle authentication message
          if (data.type === 'auth') {
            const token = data.token as string;
            if (this.validateToken(token || '')) {
              client.authenticated = true;
              connection.socket.send(JSON.stringify({
                type: 'auth_success',
                clientId,
                message: 'Authentication successful',
                timestamp: Date.now(),
              }));
              console.log(`Web client authenticated: ${clientId}`);

              // Send initial sessions list to newly authenticated client
              if (this.getSessionsCallback) {
                const sessions = this.getSessionsCallback();
                connection.socket.send(JSON.stringify({
                  type: 'sessions_list',
                  sessions,
                  timestamp: Date.now(),
                }));
              }

              // Send current theme to newly authenticated client
              if (this.getThemeCallback) {
                const theme = this.getThemeCallback();
                if (theme) {
                  connection.socket.send(JSON.stringify({
                    type: 'theme',
                    theme,
                    timestamp: Date.now(),
                  }));
                }
              }
            } else {
              connection.socket.send(JSON.stringify({
                type: 'auth_failed',
                message: 'Invalid authentication token',
                timestamp: Date.now(),
              }));
              console.log(`Web client auth failed: ${clientId}`);
            }
            return;
          }

          // Reject messages from unauthenticated clients (except auth messages)
          if (!client.authenticated) {
            connection.socket.send(JSON.stringify({
              type: 'error',
              message: 'Not authenticated. Send { type: "auth", token: "<token>" } first.',
            }));
            return;
          }

          this.handleWebClientMessage(clientId, data);
        } catch {
          // Send error for invalid JSON
          connection.socket.send(JSON.stringify({
            type: 'error',
            message: 'Invalid message format',
          }));
        }
      });

      // Handle client disconnection
      connection.socket.on('close', () => {
        this.webClients.delete(clientId);
        console.log(`Web client disconnected: ${clientId} (total: ${this.webClients.size})`);
      });

      // Handle errors
      connection.socket.on('error', (error) => {
        console.error(`Web client error (${clientId}):`, error);
        this.webClients.delete(clientId);
      });
    });

    // Authentication status endpoint - allows checking if auth is enabled
    this.server.get('/web/api/auth/status', getRateLimitConfig, async () => {
      return {
        enabled: this.authConfig.enabled,
        timestamp: Date.now(),
      };
    });

    // Authentication verification endpoint - checks if a token is valid
    // Uses more restrictive POST rate limit to prevent brute force attacks
    this.server.post('/web/api/auth/verify', postRateLimitConfig, async (request) => {
      const body = request.body as { token?: string } | undefined;
      const token = body?.token;

      if (!token) {
        return {
          valid: false,
          message: 'No token provided',
        };
      }

      const valid = this.validateToken(token);
      return {
        valid,
        message: valid ? 'Token is valid' : 'Invalid token',
      };
    });
  }

  /**
   * Handle incoming messages from web clients
   */
  private handleWebClientMessage(clientId: string, message: WebClientMessage) {
    const client = this.webClients.get(clientId);
    if (!client) return;

    switch (message.type) {
      case 'ping':
        // Respond to ping with pong
        client.socket.send(JSON.stringify({
          type: 'pong',
          timestamp: Date.now(),
        }));
        break;

      case 'subscribe':
        // Placeholder for subscription handling (sessions, theme, etc.)
        // Will be implemented in future tasks
        client.socket.send(JSON.stringify({
          type: 'subscribed',
          topic: message.topic,
          timestamp: Date.now(),
        }));
        break;

      default:
        // Echo unknown message types for debugging
        client.socket.send(JSON.stringify({
          type: 'echo',
          originalType: message.type,
          data: message,
        }));
    }
  }

  /**
   * Broadcast a message to all connected web clients
   */
  broadcastToWebClients(message: object) {
    const data = JSON.stringify(message);
    for (const client of this.webClients.values()) {
      if (client.socket.readyState === WebSocket.OPEN && client.authenticated) {
        client.socket.send(data);
      }
    }
  }

  /**
   * Broadcast a session state change to all connected web clients
   * Called when any session's state changes (idle, busy, error, connecting)
   */
  broadcastSessionStateChange(sessionId: string, state: string, additionalData?: {
    name?: string;
    toolType?: string;
    inputMode?: string;
    cwd?: string;
  }) {
    this.broadcastToWebClients({
      type: 'session_state_change',
      sessionId,
      state,
      ...additionalData,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast when a session is added
   */
  broadcastSessionAdded(session: {
    id: string;
    name: string;
    toolType: string;
    state: string;
    inputMode: string;
    cwd: string;
  }) {
    this.broadcastToWebClients({
      type: 'session_added',
      session,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast when a session is removed
   */
  broadcastSessionRemoved(sessionId: string) {
    this.broadcastToWebClients({
      type: 'session_removed',
      sessionId,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast the full sessions list to all connected web clients
   * Used for initial sync or bulk updates
   */
  broadcastSessionsList(sessions: Array<{
    id: string;
    name: string;
    toolType: string;
    state: string;
    inputMode: string;
    cwd: string;
  }>) {
    this.broadcastToWebClients({
      type: 'sessions_list',
      sessions,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast theme change to all connected web clients
   * Called when the user changes the theme in the desktop app
   */
  broadcastThemeChange(theme: WebTheme) {
    this.broadcastToWebClients({
      type: 'theme',
      theme,
      timestamp: Date.now(),
    });
  }

  /**
   * Get the number of connected web clients
   */
  getWebClientCount(): number {
    return this.webClients.size;
  }

  async start() {
    if (this.isRunning) {
      console.log('Web server already running');
      return;
    }

    try {
      await this.server.listen({ port: this.port, host: '0.0.0.0' });
      this.isRunning = true;
      console.log(`Maestro web server running on http://localhost:${this.port}`);
    } catch (error) {
      console.error('Failed to start web server:', error);
      throw error;
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    try {
      await this.server.close();
      this.isRunning = false;
      console.log('Web server stopped');
    } catch (error) {
      console.error('Failed to stop web server:', error);
    }
  }

  getUrl(): string {
    return `http://localhost:${this.port}`;
  }

  getServer(): FastifyInstance {
    return this.server;
  }
}
