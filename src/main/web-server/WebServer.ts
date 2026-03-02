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
 * - Invalid/missing token redirects to website
 * - No access without knowing the token
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import path from 'path';
import { existsSync } from 'fs';
import { getLocalIpAddressSync } from '../utils/networkUtils';
import { logger } from '../utils/logger';
import { WebSocketMessageHandler } from './handlers';
import { BroadcastService } from './services';
import { ApiRoutes, StaticRoutes, WsRoute } from './routes';
import { LiveSessionManager, CallbackRegistry } from './managers';

// Import shared types from canonical location
import type {
	Theme,
	LiveSessionInfo,
	RateLimitConfig,
	AITabData,
	CustomAICommand,
	AutoRunState,
	CliActivity,
	SessionBroadcastData,
	WebClient,
	WebClientMessage,
	GetSessionsCallback,
	GetSessionDetailCallback,
	WriteToSessionCallback,
	ExecuteCommandCallback,
	InterruptSessionCallback,
	SwitchModeCallback,
	SelectSessionCallback,
	SelectTabCallback,
	NewTabCallback,
	CloseTabCallback,
	RenameTabCallback,
	StarTabCallback,
	ReorderTabCallback,
	ToggleBookmarkCallback,
	GetThemeCallback,
	GetCustomCommandsCallback,
	GetHistoryCallback,
} from './types';

// Logger context for all web server logs
const LOG_CONTEXT = 'WebServer';

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
	private webAssetsPath: string | null = null;

	// Security token - regenerated on each app startup
	private securityToken: string;

	// Local IP address for generating URLs (detected at startup)
	private localIpAddress: string = 'localhost';

	// Extracted managers
	private liveSessionManager: LiveSessionManager;
	private callbackRegistry: CallbackRegistry;

	// WebSocket message handler instance
	private messageHandler: WebSocketMessageHandler;

	// Broadcast service instance
	private broadcastService: BroadcastService;

	// Route instances
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

		// Initialize managers
		this.liveSessionManager = new LiveSessionManager();
		this.callbackRegistry = new CallbackRegistry();

		// Initialize the WebSocket message handler
		this.messageHandler = new WebSocketMessageHandler();

		// Initialize the broadcast service
		this.broadcastService = new BroadcastService();
		this.broadcastService.setGetWebClientsCallback(() => this.webClients);

		// Wire up live session manager to broadcast service
		this.liveSessionManager.setBroadcastCallbacks({
			broadcastSessionLive: (sessionId, agentSessionId) =>
				this.broadcastService.broadcastSessionLive(sessionId, agentSessionId),
			broadcastSessionOffline: (sessionId) =>
				this.broadcastService.broadcastSessionOffline(sessionId),
			broadcastAutoRunState: (sessionId, state) =>
				this.broadcastService.broadcastAutoRunState(sessionId, state),
		});

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
			path.join(__dirname, '..', '..', 'web'),
			// Development: from project root
			path.join(process.cwd(), 'dist', 'web'),
			// Alternative: relative to __dirname going up to dist
			path.join(__dirname, '..', 'web'),
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

	// ============ Live Session Management (Delegated to LiveSessionManager) ============

	/**
	 * Mark a session as live (visible in web interface)
	 */
	setSessionLive(sessionId: string, agentSessionId?: string): void {
		this.liveSessionManager.setSessionLive(sessionId, agentSessionId);
	}

	/**
	 * Mark a session as offline (no longer visible in web interface)
	 */
	setSessionOffline(sessionId: string): void {
		this.liveSessionManager.setSessionOffline(sessionId);
	}

	/**
	 * Check if a session is currently live
	 */
	isSessionLive(sessionId: string): boolean {
		return this.liveSessionManager.isSessionLive(sessionId);
	}

	/**
	 * Get all live session IDs
	 */
	getLiveSessions(): LiveSessionInfo[] {
		return this.liveSessionManager.getLiveSessions();
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

	// ============ Callback Setters (Delegated to CallbackRegistry) ============

	setGetSessionsCallback(callback: GetSessionsCallback): void {
		this.callbackRegistry.setGetSessionsCallback(callback);
	}

	setGetSessionDetailCallback(callback: GetSessionDetailCallback): void {
		this.callbackRegistry.setGetSessionDetailCallback(callback);
	}

	setGetThemeCallback(callback: GetThemeCallback): void {
		this.callbackRegistry.setGetThemeCallback(callback);
	}

	setGetCustomCommandsCallback(callback: GetCustomCommandsCallback): void {
		this.callbackRegistry.setGetCustomCommandsCallback(callback);
	}

	setWriteToSessionCallback(callback: WriteToSessionCallback): void {
		this.callbackRegistry.setWriteToSessionCallback(callback);
	}

	setExecuteCommandCallback(callback: ExecuteCommandCallback): void {
		this.callbackRegistry.setExecuteCommandCallback(callback);
	}

	setInterruptSessionCallback(callback: InterruptSessionCallback): void {
		this.callbackRegistry.setInterruptSessionCallback(callback);
	}

	setSwitchModeCallback(callback: SwitchModeCallback): void {
		this.callbackRegistry.setSwitchModeCallback(callback);
	}

	setSelectSessionCallback(callback: SelectSessionCallback): void {
		this.callbackRegistry.setSelectSessionCallback(callback);
	}

	setSelectTabCallback(callback: SelectTabCallback): void {
		this.callbackRegistry.setSelectTabCallback(callback);
	}

	setNewTabCallback(callback: NewTabCallback): void {
		this.callbackRegistry.setNewTabCallback(callback);
	}

	setCloseTabCallback(callback: CloseTabCallback): void {
		this.callbackRegistry.setCloseTabCallback(callback);
	}

	setRenameTabCallback(callback: RenameTabCallback): void {
		this.callbackRegistry.setRenameTabCallback(callback);
	}

	setStarTabCallback(callback: StarTabCallback): void {
		this.callbackRegistry.setStarTabCallback(callback);
	}

	setReorderTabCallback(callback: ReorderTabCallback): void {
		this.callbackRegistry.setReorderTabCallback(callback);
	}

	setToggleBookmarkCallback(callback: ToggleBookmarkCallback): void {
		this.callbackRegistry.setToggleBookmarkCallback(callback);
	}

	setGetHistoryCallback(callback: GetHistoryCallback): void {
		this.callbackRegistry.setGetHistoryCallback(callback);
	}

	// ============ Rate Limiting ============

	setRateLimitConfig(config: Partial<RateLimitConfig>): void {
		this.rateLimitConfig = { ...this.rateLimitConfig, ...config };
		logger.info(
			`Rate limiting ${this.rateLimitConfig.enabled ? 'enabled' : 'disabled'} (max: ${this.rateLimitConfig.max}/min, maxPost: ${this.rateLimitConfig.maxPost}/min)`,
			LOG_CONTEXT
		);
	}

	getRateLimitConfig(): RateLimitConfig {
		return { ...this.rateLimitConfig };
	}

	// ============ Server Setup ============

	private async setupMiddleware(): Promise<void> {
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

	private setupRoutes(): void {
		// Setup static routes (dashboard, PWA files, health check)
		this.staticRoutes.registerRoutes(this.server);

		// Setup API routes callbacks and register routes
		this.apiRoutes.setCallbacks({
			getSessions: () => this.callbackRegistry.getSessions(),
			getSessionDetail: (sessionId, tabId) =>
				this.callbackRegistry.getSessionDetail(sessionId, tabId),
			getTheme: () => this.callbackRegistry.getTheme(),
			writeToSession: (sessionId, data) => this.callbackRegistry.writeToSession(sessionId, data),
			interruptSession: async (sessionId) => this.callbackRegistry.interruptSession(sessionId),
			getHistory: (projectPath, sessionId) =>
				this.callbackRegistry.getHistory(projectPath, sessionId),
			getLiveSessionInfo: (sessionId) => this.liveSessionManager.getLiveSessionInfo(sessionId),
			isSessionLive: (sessionId) => this.liveSessionManager.isSessionLive(sessionId),
		});
		this.apiRoutes.registerRoutes(this.server);

		// Setup WebSocket route callbacks and register route
		this.wsRoute.setCallbacks({
			getSessions: () => this.callbackRegistry.getSessions(),
			getTheme: () => this.callbackRegistry.getTheme(),
			getCustomCommands: () => this.callbackRegistry.getCustomCommands(),
			getAutoRunStates: () => this.liveSessionManager.getAutoRunStates(),
			getLiveSessionInfo: (sessionId) => this.liveSessionManager.getLiveSessionInfo(sessionId),
			isSessionLive: (sessionId) => this.liveSessionManager.isSessionLive(sessionId),
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

	private handleWebClientMessage(clientId: string, message: WebClientMessage): void {
		const client = this.webClients.get(clientId);
		if (!client) return;
		this.messageHandler.handleMessage(client, message);
	}

	private setupMessageHandlerCallbacks(): void {
		this.messageHandler.setCallbacks({
			getSessionDetail: (sessionId: string) => this.callbackRegistry.getSessionDetail(sessionId),
			executeCommand: async (sessionId: string, command: string, inputMode?: 'ai' | 'terminal') =>
				this.callbackRegistry.executeCommand(sessionId, command, inputMode),
			switchMode: async (sessionId: string, mode: 'ai' | 'terminal') =>
				this.callbackRegistry.switchMode(sessionId, mode),
			selectSession: async (sessionId: string, tabId?: string) =>
				this.callbackRegistry.selectSession(sessionId, tabId),
			selectTab: async (sessionId: string, tabId: string) =>
				this.callbackRegistry.selectTab(sessionId, tabId),
			newTab: async (sessionId: string) => this.callbackRegistry.newTab(sessionId),
			closeTab: async (sessionId: string, tabId: string) =>
				this.callbackRegistry.closeTab(sessionId, tabId),
			renameTab: async (sessionId: string, tabId: string, newName: string) =>
				this.callbackRegistry.renameTab(sessionId, tabId, newName),
			starTab: async (sessionId: string, tabId: string, starred: boolean) =>
				this.callbackRegistry.starTab(sessionId, tabId, starred),
			reorderTab: async (sessionId: string, fromIndex: number, toIndex: number) =>
				this.callbackRegistry.reorderTab(sessionId, fromIndex, toIndex),
			toggleBookmark: async (sessionId: string) => this.callbackRegistry.toggleBookmark(sessionId),
			getSessions: () => this.callbackRegistry.getSessions(),
			getLiveSessionInfo: (sessionId: string) =>
				this.liveSessionManager.getLiveSessionInfo(sessionId),
			isSessionLive: (sessionId: string) => this.liveSessionManager.isSessionLive(sessionId),
		});
	}

	// ============ Broadcast Methods (Delegated to BroadcastService) ============

	broadcastToWebClients(message: object): void {
		this.broadcastService.broadcastToAll(message);
	}

	broadcastToSessionClients(sessionId: string, message: object): void {
		this.broadcastService.broadcastToSession(sessionId, message);
	}

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

	broadcastSessionAdded(session: SessionBroadcastData): void {
		this.broadcastService.broadcastSessionAdded(session);
	}

	broadcastSessionRemoved(sessionId: string): void {
		this.broadcastService.broadcastSessionRemoved(sessionId);
	}

	broadcastSessionsList(sessions: SessionBroadcastData[]): void {
		this.broadcastService.broadcastSessionsList(sessions);
	}

	broadcastActiveSessionChange(sessionId: string): void {
		this.broadcastService.broadcastActiveSessionChange(sessionId);
	}

	broadcastTabsChange(sessionId: string, aiTabs: AITabData[], activeTabId: string): void {
		this.broadcastService.broadcastTabsChange(sessionId, aiTabs, activeTabId);
	}

	broadcastThemeChange(theme: Theme): void {
		this.broadcastService.broadcastThemeChange(theme);
	}

	broadcastCustomCommands(commands: CustomAICommand[]): void {
		this.broadcastService.broadcastCustomCommands(commands);
	}

	broadcastAutoRunState(sessionId: string, state: AutoRunState | null): void {
		this.liveSessionManager.setAutoRunState(sessionId, state);
	}

	broadcastUserInput(sessionId: string, command: string, inputMode: 'ai' | 'terminal'): void {
		this.broadcastService.broadcastUserInput(sessionId, command, inputMode);
	}

	// ============ Server Lifecycle ============

	getWebClientCount(): number {
		return this.webClients.size;
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

	async stop(): Promise<void> {
		if (!this.isRunning) {
			return;
		}

		// Clear all session state (handles live sessions and autorun states)
		this.liveSessionManager.clearAll();

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
