import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import path from 'path';
import { existsSync } from 'fs';
import type { Theme } from '../shared/theme-types';
import { HistoryEntry } from '../shared/types';
import { getLocalIpAddressSync } from './utils/networkUtils';
import { logger } from './utils/logger';
import { WebSocketMessageHandler, WebClient, WebClientMessage } from './web-server/handlers';
import {
	BroadcastService,
	AITabData as BroadcastAITabData,
	CustomAICommand as BroadcastCustomAICommand,
	AutoRunState,
	CliActivity,
	SessionBroadcastData,
} from './web-server/services';
import { ApiRoutes, StaticRoutes, WsRoute } from './web-server/routes';

// Logger context for all web server logs
const LOG_CONTEXT = 'WebServer';

// Live session info
interface LiveSessionInfo {
	sessionId: string;
	agentSessionId?: string;
	enabledAt: number;
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
 * Architecture:
 * - Single server on random port
 * - Security token (UUID) generated at startup, required in all URLs
 * - Routes: /$TOKEN/ (dashboard), /$TOKEN/session/:id (session view)
 * - Live sessions: Only sessions marked as "live" appear in dashboard
 * - WebSocket: Real-time updates for session state, logs, theme
 *
 * URL Structure:
 *   http://localhost:PORT/$TOKEN/                  → Dashboard (all live sessions)
 *   http://localhost:PORT/$TOKEN/session/$UUID     → Single session view
 *   http://localhost:PORT/$TOKEN/api/*             → REST API
 *   http://localhost:PORT/$TOKEN/ws                → WebSocket
 *
 * Security:
 * - Token regenerated on each app restart
 * - Invalid/missing token redirects to GitHub
 * - No access without knowing the token
 */
// Usage stats type for session cost/token tracking
export interface SessionUsageStats {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	totalCostUsd?: number;
	contextWindow?: number;
}

// Last response type for mobile preview (truncated to save bandwidth)
export interface LastResponsePreview {
	text: string; // First 3 lines or ~500 chars of the last AI response
	timestamp: number;
	source: 'stdout' | 'stderr' | 'system';
	fullLength: number; // Total length of the original response
}

// AI Tab type for multi-tab support within a Maestro session
export interface AITabData {
	id: string;
	agentSessionId: string | null;
	name: string | null;
	starred: boolean;
	inputValue: string;
	usageStats?: SessionUsageStats | null;
	createdAt: number;
	state: 'idle' | 'busy';
	thinkingStartTime?: number | null;
}

// Callback type for fetching sessions data
export type GetSessionsCallback = () => Array<{
	id: string;
	name: string;
	toolType: string;
	state: string;
	inputMode: string;
	cwd: string;
	groupId: string | null;
	groupName: string | null;
	groupEmoji: string | null;
	usageStats?: SessionUsageStats | null;
	lastResponse?: LastResponsePreview | null;
	agentSessionId?: string | null;
	thinkingStartTime?: number | null; // Timestamp when AI started thinking (for elapsed time display)
	aiTabs?: AITabData[];
	activeTabId?: string;
	bookmarked?: boolean; // Whether session is bookmarked (shows in Bookmarks group)
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
	agentSessionId?: string;
	isGitRepo?: boolean;
	activeTabId?: string;
}

// Callback type for fetching single session details
// Optional tabId allows fetching logs for a specific tab (avoids race conditions)
export type GetSessionDetailCallback = (sessionId: string, tabId?: string) => SessionDetail | null;

// Callback type for sending commands to a session
// Returns true if successful, false if session not found or write failed
export type WriteToSessionCallback = (sessionId: string, data: string) => boolean;

// Callback type for executing a command through the desktop's existing logic
// This forwards the command to the renderer which handles spawn, state, and broadcasts
// Returns true if command was accepted (session not busy)
// inputMode is optional - if provided, the renderer will use it instead of querying session state
export type ExecuteCommandCallback = (
	sessionId: string,
	command: string,
	inputMode?: 'ai' | 'terminal'
) => Promise<boolean>;

// Callback type for interrupting a session through the desktop's existing logic
// This forwards to the renderer which handles state updates and broadcasts
export type InterruptSessionCallback = (sessionId: string) => Promise<boolean>;

// Callback type for switching session input mode through the desktop's existing logic
// This forwards to the renderer which handles state updates and broadcasts
export type SwitchModeCallback = (sessionId: string, mode: 'ai' | 'terminal') => Promise<boolean>;

// Callback type for selecting/switching to a session in the desktop app
// This forwards to the renderer which handles state updates and broadcasts
// Optional tabId to also switch to a specific tab within the session
export type SelectSessionCallback = (sessionId: string, tabId?: string) => Promise<boolean>;

// Tab operation callbacks for multi-tab support
export type SelectTabCallback = (sessionId: string, tabId: string) => Promise<boolean>;
export type NewTabCallback = (sessionId: string) => Promise<{ tabId: string } | null>;
export type CloseTabCallback = (sessionId: string, tabId: string) => Promise<boolean>;
export type RenameTabCallback = (
	sessionId: string,
	tabId: string,
	newName: string
) => Promise<boolean>;

// Re-export Theme type from shared for backwards compatibility
export type { Theme } from '../shared/theme-types';

// Callback type for fetching current theme
export type GetThemeCallback = () => Theme | null;

// Custom AI command definition (matches renderer's CustomAICommand)
export interface CustomAICommand {
	id: string;
	command: string;
	description: string;
	prompt: string;
}

// Callback type for fetching custom AI commands
export type GetCustomCommandsCallback = () => CustomAICommand[];

// Callback type for fetching history entries
// Uses HistoryEntry from shared/types.ts as the canonical type
export type GetHistoryCallback = (projectPath?: string, sessionId?: string) => HistoryEntry[];

// Default rate limit configuration
const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
	max: 100, // 100 requests per minute for GET endpoints
	timeWindow: 60000, // 1 minute in milliseconds
	maxPost: 30, // 30 requests per minute for POST endpoints (more restrictive)
	enabled: true,
};

export class WebServer {
	private server: FastifyInstance;
	private port: number;
	private isRunning: boolean = false;
	private webClients: Map<string, WebClient> = new Map();
	private rateLimitConfig: RateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG };
	private getSessionsCallback: GetSessionsCallback | null = null;
	private getSessionDetailCallback: GetSessionDetailCallback | null = null;
	private getThemeCallback: GetThemeCallback | null = null;
	private getCustomCommandsCallback: GetCustomCommandsCallback | null = null;
	private writeToSessionCallback: WriteToSessionCallback | null = null;
	private executeCommandCallback: ExecuteCommandCallback | null = null;
	private interruptSessionCallback: InterruptSessionCallback | null = null;
	private switchModeCallback: SwitchModeCallback | null = null;
	private selectSessionCallback: SelectSessionCallback | null = null;
	private selectTabCallback: SelectTabCallback | null = null;
	private newTabCallback: NewTabCallback | null = null;
	private closeTabCallback: CloseTabCallback | null = null;
	private renameTabCallback: RenameTabCallback | null = null;
	private getHistoryCallback: GetHistoryCallback | null = null;
	private webAssetsPath: string | null = null;

	// Security token - regenerated on each app startup
	private securityToken: string;

	// Local IP address for generating URLs (detected at startup)
	private localIpAddress: string = 'localhost';

	// Live sessions - only these appear in the web interface
	private liveSessions: Map<string, LiveSessionInfo> = new Map();

	// AutoRun states per session - tracks which sessions have active batch processing
	private autoRunStates: Map<string, AutoRunState> = new Map();

	// WebSocket message handler instance
	private messageHandler: WebSocketMessageHandler;

	// Broadcast service instance
	private broadcastService: BroadcastService;

	// Route instances (extracted from web-server.ts)
	private apiRoutes: ApiRoutes;
	private staticRoutes: StaticRoutes;
	private wsRoute: WsRoute;

	constructor(port: number = 0) {
		// Use port 0 to let OS assign a random available port
		this.port = port;
		this.server = Fastify({
			logger: {
				level: 'info',
			},
		});

		// Generate a new security token (UUID v4)
		this.securityToken = randomUUID();
		logger.debug('Security token generated', LOG_CONTEXT);

		// Determine web assets path (production vs development)
		this.webAssetsPath = this.resolveWebAssetsPath();

		// Initialize the WebSocket message handler
		this.messageHandler = new WebSocketMessageHandler();

		// Initialize the broadcast service
		this.broadcastService = new BroadcastService();
		this.broadcastService.setGetWebClientsCallback(() => this.webClients);

		// Initialize route handlers
		this.apiRoutes = new ApiRoutes(this.securityToken, this.rateLimitConfig);
		this.staticRoutes = new StaticRoutes(this.securityToken, this.webAssetsPath);
		this.wsRoute = new WsRoute(this.securityToken);

		// Note: setupMiddleware and setupRoutes are called in start() to handle async properly
	}

	/**
	 * Resolve the path to web assets
	 * In production: dist/web relative to app root
	 * In development: same location but might not exist until built
	 */
	private resolveWebAssetsPath(): string | null {
		// Try multiple locations for the web assets
		const possiblePaths = [
			// Production: relative to the compiled main process
			path.join(__dirname, '..', 'web'),
			// Development: from project root
			path.join(process.cwd(), 'dist', 'web'),
			// Alternative: relative to __dirname going up to dist
			path.join(__dirname, 'web'),
		];

		for (const p of possiblePaths) {
			if (existsSync(path.join(p, 'index.html'))) {
				logger.debug(`Web assets found at: ${p}`, LOG_CONTEXT);
				return p;
			}
		}

		logger.warn(
			'Web assets not found. Web interface will not be served. Run "npm run build:web" to build web assets.',
			LOG_CONTEXT
		);
		return null;
	}

	// ============ Live Session Management ============

	/**
	 * Mark a session as live (visible in web interface)
	 */
	setSessionLive(sessionId: string, agentSessionId?: string): void {
		this.liveSessions.set(sessionId, {
			sessionId,
			agentSessionId,
			enabledAt: Date.now(),
		});
		logger.info(
			`Session ${sessionId} marked as live (total: ${this.liveSessions.size})`,
			LOG_CONTEXT
		);

		// Broadcast to all connected clients
		this.broadcastService.broadcastSessionLive(sessionId, agentSessionId);
	}

	/**
	 * Mark a session as offline (no longer visible in web interface)
	 */
	setSessionOffline(sessionId: string): void {
		const wasLive = this.liveSessions.delete(sessionId);
		if (wasLive) {
			logger.info(
				`Session ${sessionId} marked as offline (remaining: ${this.liveSessions.size})`,
				LOG_CONTEXT
			);

			// Broadcast to all connected clients
			this.broadcastService.broadcastSessionOffline(sessionId);
		}
	}

	/**
	 * Check if a session is currently live
	 */
	isSessionLive(sessionId: string): boolean {
		return this.liveSessions.has(sessionId);
	}

	/**
	 * Get all live session IDs
	 */
	getLiveSessions(): LiveSessionInfo[] {
		return Array.from(this.liveSessions.values());
	}

	/**
	 * Get the security token (for constructing URLs)
	 */
	getSecurityToken(): string {
		return this.securityToken;
	}

	/**
	 * Get the full secure URL (with token)
	 * Uses the detected local IP address for LAN accessibility
	 */
	getSecureUrl(): string {
		return `http://${this.localIpAddress}:${this.port}/${this.securityToken}`;
	}

	/**
	 * Get URL for a specific session
	 * Uses the detected local IP address for LAN accessibility
	 */
	getSessionUrl(sessionId: string): string {
		return `http://${this.localIpAddress}:${this.port}/${this.securityToken}/session/${sessionId}`;
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
	 * Set the callback function for fetching custom AI commands
	 * This is called when a new client connects to send the initial custom commands
	 */
	setGetCustomCommandsCallback(callback: GetCustomCommandsCallback) {
		this.getCustomCommandsCallback = callback;
	}

	/**
	 * Set the callback function for writing commands to a session
	 * This is called by the /api/session/:id/send endpoint
	 */
	setWriteToSessionCallback(callback: WriteToSessionCallback) {
		this.writeToSessionCallback = callback;
	}

	/**
	 * Set the callback function for executing commands through the desktop
	 * This forwards commands to the renderer which handles spawn, state management, and broadcasts
	 */
	setExecuteCommandCallback(callback: ExecuteCommandCallback) {
		this.executeCommandCallback = callback;
	}

	/**
	 * Set the callback function for interrupting a session through the desktop
	 * This forwards to the renderer which handles state updates and broadcasts
	 */
	setInterruptSessionCallback(callback: InterruptSessionCallback) {
		this.interruptSessionCallback = callback;
	}

	/**
	 * Set the callback function for switching session mode through the desktop
	 * This forwards to the renderer which handles state updates and broadcasts
	 */
	setSwitchModeCallback(callback: SwitchModeCallback) {
		logger.info('[WebServer] setSwitchModeCallback called', LOG_CONTEXT);
		this.switchModeCallback = callback;
	}

	/**
	 * Set the callback function for selecting/switching to a session in the desktop
	 * This forwards to the renderer which handles state updates and broadcasts
	 */
	setSelectSessionCallback(callback: SelectSessionCallback) {
		logger.info('[WebServer] setSelectSessionCallback called', LOG_CONTEXT);
		this.selectSessionCallback = callback;
	}

	/**
	 * Set the callback function for selecting a tab within a session
	 * This forwards to the renderer which handles tab state updates and broadcasts
	 */
	setSelectTabCallback(callback: SelectTabCallback) {
		logger.info('[WebServer] setSelectTabCallback called', LOG_CONTEXT);
		this.selectTabCallback = callback;
	}

	/**
	 * Set the callback function for creating a new tab within a session
	 * This forwards to the renderer which handles tab creation and broadcasts
	 */
	setNewTabCallback(callback: NewTabCallback) {
		logger.info('[WebServer] setNewTabCallback called', LOG_CONTEXT);
		this.newTabCallback = callback;
	}

	/**
	 * Set the callback function for closing a tab within a session
	 * This forwards to the renderer which handles tab removal and broadcasts
	 */
	setCloseTabCallback(callback: CloseTabCallback) {
		logger.info('[WebServer] setCloseTabCallback called', LOG_CONTEXT);
		this.closeTabCallback = callback;
	}

	/**
	 * Set the callback function for renaming a tab within a session
	 * This forwards to the renderer which handles tab rename and broadcasts
	 */
	setRenameTabCallback(callback: RenameTabCallback) {
		logger.info('[WebServer] setRenameTabCallback called', LOG_CONTEXT);
		this.renameTabCallback = callback;
	}

	/**
	 * Set the callback function for fetching history entries
	 * This is called by the /api/history endpoint
	 */
	setGetHistoryCallback(callback: GetHistoryCallback) {
		this.getHistoryCallback = callback;
	}

	/**
	 * Set the rate limiting configuration
	 */
	setRateLimitConfig(config: Partial<RateLimitConfig>) {
		this.rateLimitConfig = { ...this.rateLimitConfig, ...config };
		logger.info(
			`Rate limiting ${this.rateLimitConfig.enabled ? 'enabled' : 'disabled'} (max: ${this.rateLimitConfig.max}/min, maxPost: ${this.rateLimitConfig.maxPost}/min)`,
			LOG_CONTEXT
		);
	}

	/**
	 * Get the current rate limiting configuration
	 */
	getRateLimitConfig(): RateLimitConfig {
		return { ...this.rateLimitConfig };
	}

	private async setupMiddleware() {
		// Enable CORS for web access
		await this.server.register(cors, {
			origin: true,
		});

		// Enable WebSocket support
		await this.server.register(websocket);

		// Enable rate limiting for web interface endpoints to prevent abuse
		await this.server.register(rateLimit, {
			global: false,
			max: this.rateLimitConfig.max,
			timeWindow: this.rateLimitConfig.timeWindow,
			errorResponseBuilder: (_request: FastifyRequest, context) => {
				return {
					statusCode: 429,
					error: 'Too Many Requests',
					message: `Rate limit exceeded. Try again later.`,
					retryAfter: context.after,
				};
			},
			allowList: (request: FastifyRequest) => {
				if (!this.rateLimitConfig.enabled) return true;
				if (request.url === '/health') return true;
				return false;
			},
			keyGenerator: (request: FastifyRequest) => {
				return request.ip;
			},
		});

		// Register static file serving for web assets
		if (this.webAssetsPath) {
			const assetsPath = path.join(this.webAssetsPath, 'assets');
			if (existsSync(assetsPath)) {
				await this.server.register(fastifyStatic, {
					root: assetsPath,
					prefix: `/${this.securityToken}/assets/`,
					decorateReply: false,
				});
			}

			// Register icons directory
			const iconsPath = path.join(this.webAssetsPath, 'icons');
			if (existsSync(iconsPath)) {
				await this.server.register(fastifyStatic, {
					root: iconsPath,
					prefix: `/${this.securityToken}/icons/`,
					decorateReply: false,
				});
			}
		}
	}

	/**
	 * Setup all routes by delegating to extracted route classes
	 */
	private setupRoutes() {
		// Setup static routes (dashboard, PWA files, health check)
		this.staticRoutes.registerRoutes(this.server);

		// Setup API routes callbacks and register routes
		this.apiRoutes.setCallbacks({
			getSessions: () => this.getSessionsCallback?.() ?? [],
			getSessionDetail: (sessionId, tabId) =>
				this.getSessionDetailCallback?.(sessionId, tabId) ?? null,
			getTheme: () => this.getThemeCallback?.() ?? null,
			writeToSession: (sessionId, data) => this.writeToSessionCallback?.(sessionId, data) ?? false,
			interruptSession: async (sessionId) => this.interruptSessionCallback?.(sessionId) ?? false,
			getHistory: (projectPath, sessionId) =>
				this.getHistoryCallback?.(projectPath, sessionId) ?? [],
			getLiveSessionInfo: (sessionId) => this.liveSessions.get(sessionId),
			isSessionLive: (sessionId) => this.liveSessions.has(sessionId),
		});
		this.apiRoutes.registerRoutes(this.server);

		// Setup WebSocket route callbacks and register route
		this.wsRoute.setCallbacks({
			getSessions: () => this.getSessionsCallback?.() ?? [],
			getTheme: () => this.getThemeCallback?.() ?? null,
			getCustomCommands: () => this.getCustomCommandsCallback?.() ?? [],
			getAutoRunStates: () => this.autoRunStates,
			getLiveSessionInfo: (sessionId) => this.liveSessions.get(sessionId),
			isSessionLive: (sessionId) => this.liveSessions.has(sessionId),
			onClientConnect: (client) => {
				this.webClients.set(client.id, client);
				logger.info(`Client connected: ${client.id} (total: ${this.webClients.size})`, LOG_CONTEXT);
			},
			onClientDisconnect: (clientId) => {
				this.webClients.delete(clientId);
				logger.info(
					`Client disconnected: ${clientId} (total: ${this.webClients.size})`,
					LOG_CONTEXT
				);
			},
			onClientError: (clientId) => {
				this.webClients.delete(clientId);
			},
			handleMessage: (clientId, message) => {
				this.handleWebClientMessage(clientId, message);
			},
		});
		this.wsRoute.registerRoute(this.server);
	}

	/**
	 * Handle incoming messages from web clients
	 * Delegates to the WebSocketMessageHandler for all message processing
	 */
	private handleWebClientMessage(clientId: string, message: WebClientMessage) {
		const client = this.webClients.get(clientId);
		if (!client) return;

		// Delegate to the message handler
		this.messageHandler.handleMessage(client, message);
	}

	/**
	 * Broadcast a message to all connected web clients
	 */
	broadcastToWebClients(message: object): void {
		this.broadcastService.broadcastToAll(message);
	}

	/**
	 * Broadcast a message to clients subscribed to a specific session
	 */
	broadcastToSessionClients(sessionId: string, message: object): void {
		this.broadcastService.broadcastToSession(sessionId, message);
	}

	/**
	 * Broadcast a session state change to all connected web clients
	 * Called when any session's state changes (idle, busy, error, connecting)
	 */
	broadcastSessionStateChange(
		sessionId: string,
		state: string,
		additionalData?: {
			name?: string;
			toolType?: string;
			inputMode?: string;
			cwd?: string;
			cliActivity?: CliActivity;
		}
	): void {
		this.broadcastService.broadcastSessionStateChange(sessionId, state, additionalData);
	}

	/**
	 * Broadcast when a session is added
	 */
	broadcastSessionAdded(session: SessionBroadcastData): void {
		this.broadcastService.broadcastSessionAdded(session);
	}

	/**
	 * Broadcast when a session is removed
	 */
	broadcastSessionRemoved(sessionId: string): void {
		this.broadcastService.broadcastSessionRemoved(sessionId);
	}

	/**
	 * Broadcast the full sessions list to all connected web clients
	 * Used for initial sync or bulk updates
	 */
	broadcastSessionsList(sessions: SessionBroadcastData[]): void {
		this.broadcastService.broadcastSessionsList(sessions);
	}

	/**
	 * Broadcast active session change to all connected web clients
	 * Called when the user switches sessions in the desktop app
	 */
	broadcastActiveSessionChange(sessionId: string): void {
		this.broadcastService.broadcastActiveSessionChange(sessionId);
	}

	/**
	 * Broadcast tab change to all connected web clients
	 * Called when the tabs array or active tab changes in a session
	 */
	broadcastTabsChange(sessionId: string, aiTabs: BroadcastAITabData[], activeTabId: string): void {
		this.broadcastService.broadcastTabsChange(sessionId, aiTabs, activeTabId);
	}

	/**
	 * Broadcast theme change to all connected web clients
	 * Called when the user changes the theme in the desktop app
	 */
	broadcastThemeChange(theme: Theme): void {
		this.broadcastService.broadcastThemeChange(theme);
	}

	/**
	 * Broadcast custom commands update to all connected web clients
	 * Called when the user modifies custom AI commands in the desktop app
	 */
	broadcastCustomCommands(commands: BroadcastCustomAICommand[]): void {
		this.broadcastService.broadcastCustomCommands(commands);
	}

	/**
	 * Broadcast AutoRun state to all connected web clients
	 * Called when batch processing starts, progresses, or stops
	 * Also stores state locally so new clients can receive it on connect
	 */
	broadcastAutoRunState(sessionId: string, state: AutoRunState | null): void {
		// Store state locally for new clients connecting later
		if (state && state.isRunning) {
			this.autoRunStates.set(sessionId, state);
			logger.info(
				`AutoRun state stored for session ${sessionId}: tasks=${state.completedTasks}/${state.totalTasks} (total stored: ${this.autoRunStates.size})`,
				LOG_CONTEXT
			);
		} else {
			const wasStored = this.autoRunStates.has(sessionId);
			this.autoRunStates.delete(sessionId);
			if (wasStored) {
				logger.info(
					`AutoRun state removed for session ${sessionId} (total stored: ${this.autoRunStates.size})`,
					LOG_CONTEXT
				);
			}
		}
		this.broadcastService.broadcastAutoRunState(sessionId, state);
	}

	/**
	 * Broadcast user input to web clients subscribed to a session
	 * Called when a command is sent from the desktop app so web clients stay in sync
	 */
	broadcastUserInput(sessionId: string, command: string, inputMode: 'ai' | 'terminal'): void {
		this.broadcastService.broadcastUserInput(sessionId, command, inputMode);
	}

	/**
	 * Get the number of connected web clients
	 */
	getWebClientCount(): number {
		return this.webClients.size;
	}

	/**
	 * Wire up the message handler callbacks
	 * Called during start() to ensure all callbacks are set before accepting connections
	 */
	private setupMessageHandlerCallbacks(): void {
		this.messageHandler.setCallbacks({
			getSessionDetail: (sessionId: string) => {
				return this.getSessionDetailCallback?.(sessionId) ?? null;
			},
			executeCommand: async (sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => {
				if (!this.executeCommandCallback) return false;
				return this.executeCommandCallback(sessionId, command, inputMode);
			},
			switchMode: async (sessionId: string, mode: 'ai' | 'terminal') => {
				if (!this.switchModeCallback) return false;
				return this.switchModeCallback(sessionId, mode);
			},
			selectSession: async (sessionId: string, tabId?: string) => {
				if (!this.selectSessionCallback) return false;
				return this.selectSessionCallback(sessionId, tabId);
			},
			selectTab: async (sessionId: string, tabId: string) => {
				if (!this.selectTabCallback) return false;
				return this.selectTabCallback(sessionId, tabId);
			},
			newTab: async (sessionId: string) => {
				if (!this.newTabCallback) return null;
				return this.newTabCallback(sessionId);
			},
			closeTab: async (sessionId: string, tabId: string) => {
				if (!this.closeTabCallback) return false;
				return this.closeTabCallback(sessionId, tabId);
			},
			renameTab: async (sessionId: string, tabId: string, newName: string) => {
				if (!this.renameTabCallback) return false;
				return this.renameTabCallback(sessionId, tabId, newName);
			},
			getSessions: () => {
				return this.getSessionsCallback?.() ?? [];
			},
			getLiveSessionInfo: (sessionId: string) => {
				return this.liveSessions.get(sessionId);
			},
			isSessionLive: (sessionId: string) => {
				return this.liveSessions.has(sessionId);
			},
		});
	}

	async start(): Promise<{ port: number; token: string; url: string }> {
		if (this.isRunning) {
			return {
				port: this.port,
				token: this.securityToken,
				url: this.getSecureUrl(),
			};
		}

		try {
			// Detect local IP address for LAN accessibility (sync - no network delay)
			this.localIpAddress = getLocalIpAddressSync();
			logger.info(`Using IP address: ${this.localIpAddress}`, LOG_CONTEXT);

			// Setup middleware and routes (must be done before listen)
			await this.setupMiddleware();
			this.setupRoutes();

			// Wire up message handler callbacks
			this.setupMessageHandlerCallbacks();

			await this.server.listen({ port: this.port, host: '0.0.0.0' });

			// Get the actual port (important when using port 0 for random assignment)
			const address = this.server.server.address();
			if (address && typeof address === 'object') {
				this.port = address.port;
			}

			this.isRunning = true;

			return {
				port: this.port,
				token: this.securityToken,
				url: this.getSecureUrl(),
			};
		} catch (error) {
			logger.error('Failed to start server', LOG_CONTEXT, error);
			throw error;
		}
	}

	async stop() {
		if (!this.isRunning) {
			return;
		}

		// Mark all live sessions as offline
		for (const sessionId of this.liveSessions.keys()) {
			this.setSessionOffline(sessionId);
		}

		try {
			await this.server.close();
			this.isRunning = false;
			logger.info('Server stopped', LOG_CONTEXT);
		} catch (error) {
			logger.error('Failed to stop server', LOG_CONTEXT, error);
		}
	}

	getUrl(): string {
		return `http://${this.localIpAddress}:${this.port}`;
	}

	getPort(): number {
		return this.port;
	}

	isActive(): boolean {
		return this.isRunning;
	}

	getServer(): FastifyInstance {
		return this.server;
	}
}
