/**
 * WebServer - HTTP and WebSocket server for remote access
 *
 * Architecture:
 * - Single server on random port
 * - Security token (UUID) per startup or persistent across restarts, required in all URLs
 * - Routes: /$TOKEN/ (dashboard), /$TOKEN/session/:id (session view)
 * - Live sessions: Only sessions marked as "live" appear in dashboard
 * - WebSocket: Real-time updates for session state, logs, theme
 *
 * URL Structure:
 *   http://LAN_IP:PORT/$TOKEN/                  → Dashboard (all live sessions)
 *   http://LAN_IP:PORT/$TOKEN/session/$UUID     → Single session view
 *   http://LAN_IP:PORT/$TOKEN/api/*             → REST API
 *   http://LAN_IP:PORT/$TOKEN/ws                → WebSocket
 *
 * Security:
 * - Token regenerated on each app restart (unless Persistent Web Link is enabled)
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
import { existsSync, readFileSync } from 'fs';
import { logger } from '../utils/logger';
import { getLocalIpAddress } from '../utils/networkUtils';
import { captureException } from '../utils/sentry';
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
	AutoRunDocument,
	CliActivity,
	NotificationEvent,
	SessionBroadcastData,
	WebClient,
	WebClientMessage,
	WebSettings,
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
	OpenFileTabCallback,
	RefreshFileTreeCallback,
	RefreshAutoRunDocsCallback,
	ConfigureAutoRunCallback,
	GetThemeCallback,
	GetCustomCommandsCallback,
	GetHistoryCallback,
	GetAutoRunDocsCallback,
	GetAutoRunDocContentCallback,
	SaveAutoRunDocCallback,
	StopAutoRunCallback,
	GetSettingsCallback,
	SetSettingCallback,
	GetGroupsCallback,
	CreateGroupCallback,
	RenameGroupCallback,
	DeleteGroupCallback,
	MoveSessionToGroupCallback,
	CreateSessionCallback,
	DeleteSessionCallback,
	RenameSessionCallback,
	GetGitStatusCallback,
	GetGitDiffCallback,
	GroupData,
	GetGroupChatsCallback,
	StartGroupChatCallback,
	GetGroupChatStateCallback,
	StopGroupChatCallback,
	SendGroupChatMessageCallback,
	GroupChatMessage,
	GroupChatState,
	MergeContextCallback,
	TransferContextCallback,
	SummarizeContextCallback,
	GetCueSubscriptionsCallback,
	ToggleCueSubscriptionCallback,
	TriggerCueSubscriptionCallback,
	GetCueActivityCallback,
	CueActivityEntry,
	CueSubscriptionInfo,
	GetUsageDashboardCallback,
	GetAchievementsCallback,
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

	// Security token - persistent or regenerated per startup
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

	constructor(port: number = 0, securityToken?: string) {
		// Use port 0 to let OS assign a random available port
		this.port = port;
		this.server = Fastify({
			logger: {
				level: 'info',
			},
		});

		// Use provided token (persistent mode) or generate a new one (ephemeral mode)
		if (securityToken) {
			this.securityToken = securityToken;
			logger.debug('Using persistent security token', LOG_CONTEXT);
		} else {
			this.securityToken = randomUUID();
			logger.debug('Security token generated', LOG_CONTEXT);
		}

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
			// Development: from project root
			path.join(process.cwd(), 'dist', 'web'),
			// Production: relative to the compiled main process
			path.join(__dirname, '..', '..', 'web'),
			// Alternative: relative to __dirname going up to dist
			path.join(__dirname, '..', 'web'),
		];

		for (const p of possiblePaths) {
			if (this.isServableWebAssetsPath(p)) {
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

	/**
	 * Only serve built web assets. Source `src/web/index.html` references `/main.tsx`,
	 * which the embedded Fastify server cannot compile or serve.
	 */
	private isServableWebAssetsPath(candidatePath: string): boolean {
		const indexPath = path.join(candidatePath, 'index.html');
		if (!existsSync(indexPath)) {
			return false;
		}

		const assetsPath = path.join(candidatePath, 'assets');

		try {
			const html = readFileSync(indexPath, 'utf-8');
			const referencesDevEntrypoint =
				html.includes('src="/main.tsx"') || html.includes("src='/main.tsx'");
			return !referencesDevEntrypoint && existsSync(assetsPath);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === 'ENOENT') {
				logger.warn(`Web assets disappeared while inspecting ${candidatePath}`, LOG_CONTEXT);
				return false;
			}

			logger.error(`Failed to inspect web assets at ${candidatePath}`, LOG_CONTEXT, error);
			captureException(error, {
				operation: 'webServer:isServableWebAssetsPath',
				candidatePath,
				indexPath,
			});
			throw error;
		}
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
	 */
	getSecureUrl(): string {
		return `http://${this.localIpAddress}:${this.port}/${this.securityToken}`;
	}

	/**
	 * Get URL for a specific session
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

	private writeToTerminalCallback: ((sessionId: string, data: string) => boolean) | null = null;
	private resizeTerminalCallback:
		| ((sessionId: string, cols: number, rows: number) => boolean)
		| null = null;
	private spawnTerminalForWebCallback:
		| ((
				sessionId: string,
				config: { cwd: string; cols?: number; rows?: number }
		  ) => Promise<{ success: boolean; pid: number }>)
		| null = null;
	private killTerminalForWebCallback: ((sessionId: string) => boolean) | null = null;

	setWriteToTerminalCallback(callback: (sessionId: string, data: string) => boolean): void {
		this.writeToTerminalCallback = callback;
	}

	setResizeTerminalCallback(
		callback: (sessionId: string, cols: number, rows: number) => boolean
	): void {
		this.resizeTerminalCallback = callback;
	}

	setSpawnTerminalForWebCallback(
		callback: (
			sessionId: string,
			config: { cwd: string; cols?: number; rows?: number }
		) => Promise<{ success: boolean; pid: number }>
	): void {
		this.spawnTerminalForWebCallback = callback;
	}

	setKillTerminalForWebCallback(callback: (sessionId: string) => boolean): void {
		this.killTerminalForWebCallback = callback;
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

	setOpenFileTabCallback(callback: OpenFileTabCallback): void {
		this.callbackRegistry.setOpenFileTabCallback(callback);
	}

	setRefreshFileTreeCallback(callback: RefreshFileTreeCallback): void {
		this.callbackRegistry.setRefreshFileTreeCallback(callback);
	}

	setRefreshAutoRunDocsCallback(callback: RefreshAutoRunDocsCallback): void {
		this.callbackRegistry.setRefreshAutoRunDocsCallback(callback);
	}

	setConfigureAutoRunCallback(callback: ConfigureAutoRunCallback): void {
		this.callbackRegistry.setConfigureAutoRunCallback(callback);
	}

	setGetHistoryCallback(callback: GetHistoryCallback): void {
		this.callbackRegistry.setGetHistoryCallback(callback);
	}

	setGetAutoRunDocsCallback(callback: GetAutoRunDocsCallback): void {
		this.callbackRegistry.setGetAutoRunDocsCallback(callback);
	}

	setGetAutoRunDocContentCallback(callback: GetAutoRunDocContentCallback): void {
		this.callbackRegistry.setGetAutoRunDocContentCallback(callback);
	}

	setSaveAutoRunDocCallback(callback: SaveAutoRunDocCallback): void {
		this.callbackRegistry.setSaveAutoRunDocCallback(callback);
	}

	setStopAutoRunCallback(callback: StopAutoRunCallback): void {
		this.callbackRegistry.setStopAutoRunCallback(callback);
	}

	setGetSettingsCallback(callback: GetSettingsCallback): void {
		this.callbackRegistry.setGetSettingsCallback(callback);
	}

	setSetSettingCallback(callback: SetSettingCallback): void {
		this.callbackRegistry.setSetSettingCallback(callback);
	}

	setGetGroupsCallback(callback: GetGroupsCallback): void {
		this.callbackRegistry.setGetGroupsCallback(callback);
	}

	setCreateGroupCallback(callback: CreateGroupCallback): void {
		this.callbackRegistry.setCreateGroupCallback(callback);
	}

	setRenameGroupCallback(callback: RenameGroupCallback): void {
		this.callbackRegistry.setRenameGroupCallback(callback);
	}

	setDeleteGroupCallback(callback: DeleteGroupCallback): void {
		this.callbackRegistry.setDeleteGroupCallback(callback);
	}

	setMoveSessionToGroupCallback(callback: MoveSessionToGroupCallback): void {
		this.callbackRegistry.setMoveSessionToGroupCallback(callback);
	}

	setCreateSessionCallback(callback: CreateSessionCallback): void {
		this.callbackRegistry.setCreateSessionCallback(callback);
	}

	setDeleteSessionCallback(callback: DeleteSessionCallback): void {
		this.callbackRegistry.setDeleteSessionCallback(callback);
	}

	setRenameSessionCallback(callback: RenameSessionCallback): void {
		this.callbackRegistry.setRenameSessionCallback(callback);
	}

	setGetGitStatusCallback(callback: GetGitStatusCallback): void {
		this.callbackRegistry.setGetGitStatusCallback(callback);
	}

	setGetGitDiffCallback(callback: GetGitDiffCallback): void {
		this.callbackRegistry.setGetGitDiffCallback(callback);
	}

	setGetGroupChatsCallback(callback: GetGroupChatsCallback): void {
		this.callbackRegistry.setGetGroupChatsCallback(callback);
	}

	setStartGroupChatCallback(callback: StartGroupChatCallback): void {
		this.callbackRegistry.setStartGroupChatCallback(callback);
	}

	setGetGroupChatStateCallback(callback: GetGroupChatStateCallback): void {
		this.callbackRegistry.setGetGroupChatStateCallback(callback);
	}

	setStopGroupChatCallback(callback: StopGroupChatCallback): void {
		this.callbackRegistry.setStopGroupChatCallback(callback);
	}

	setSendGroupChatMessageCallback(callback: SendGroupChatMessageCallback): void {
		this.callbackRegistry.setSendGroupChatMessageCallback(callback);
	}

	setMergeContextCallback(callback: MergeContextCallback): void {
		this.callbackRegistry.setMergeContextCallback(callback);
	}

	setTransferContextCallback(callback: TransferContextCallback): void {
		this.callbackRegistry.setTransferContextCallback(callback);
	}

	setSummarizeContextCallback(callback: SummarizeContextCallback): void {
		this.callbackRegistry.setSummarizeContextCallback(callback);
	}

	setGetCueSubscriptionsCallback(callback: GetCueSubscriptionsCallback): void {
		this.callbackRegistry.setGetCueSubscriptionsCallback(callback);
	}

	setToggleCueSubscriptionCallback(callback: ToggleCueSubscriptionCallback): void {
		this.callbackRegistry.setToggleCueSubscriptionCallback(callback);
	}

	setTriggerCueSubscriptionCallback(callback: TriggerCueSubscriptionCallback): void {
		this.callbackRegistry.setTriggerCueSubscriptionCallback(callback);
	}

	setGetCueActivityCallback(callback: GetCueActivityCallback): void {
		this.callbackRegistry.setGetCueActivityCallback(callback);
	}

	setGetUsageDashboardCallback(callback: GetUsageDashboardCallback): void {
		this.callbackRegistry.setGetUsageDashboardCallback(callback);
	}

	setGetAchievementsCallback(callback: GetAchievementsCallback): void {
		this.callbackRegistry.setGetAchievementsCallback(callback);
	}

	broadcastGroupsChanged(groups: GroupData[]): void {
		this.broadcastService.broadcastGroupsChanged(groups);
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
				const client = this.webClients.get(clientId);
				if (client?.subscribedSessionId) {
					// Kill any terminal PTY spawned for this web client's session
					const killed = this.killTerminalForWebCallback?.(client.subscribedSessionId);
					if (killed) {
						logger.info(
							`Killed terminal PTY for disconnected client ${clientId} (session: ${client.subscribedSessionId})`,
							LOG_CONTEXT
						);
					}
				}
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
			selectSession: async (sessionId: string, tabId?: string, focus?: boolean) =>
				this.callbackRegistry.selectSession(sessionId, tabId, focus),
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
			openFileTab: async (sessionId: string, filePath: string) =>
				this.callbackRegistry.openFileTab(sessionId, filePath),
			refreshFileTree: async (sessionId: string) =>
				this.callbackRegistry.refreshFileTree(sessionId),
			refreshAutoRunDocs: async (sessionId: string) =>
				this.callbackRegistry.refreshAutoRunDocs(sessionId),
			configureAutoRun: async (
				sessionId: string,
				config: Parameters<CallbackRegistry['configureAutoRun']>[1]
			) => this.callbackRegistry.configureAutoRun(sessionId, config),
			getSessions: () => this.callbackRegistry.getSessions(),
			getLiveSessionInfo: (sessionId: string) =>
				this.liveSessionManager.getLiveSessionInfo(sessionId),
			isSessionLive: (sessionId: string) => this.liveSessionManager.isSessionLive(sessionId),
			getAutoRunDocs: async (sessionId: string) => this.callbackRegistry.getAutoRunDocs(sessionId),
			getAutoRunDocContent: async (sessionId: string, filename: string) =>
				this.callbackRegistry.getAutoRunDocContent(sessionId, filename),
			saveAutoRunDoc: async (sessionId: string, filename: string, content: string) =>
				this.callbackRegistry.saveAutoRunDoc(sessionId, filename, content),
			stopAutoRun: async (sessionId: string) => this.callbackRegistry.stopAutoRun(sessionId),
			getSettings: () => this.callbackRegistry.getSettings(),
			setSetting: async (key: string, value: any) => this.callbackRegistry.setSetting(key, value),
			getGroups: () => this.callbackRegistry.getGroups(),
			createGroup: async (name: string, emoji?: string) =>
				this.callbackRegistry.createGroup(name, emoji),
			renameGroup: async (groupId: string, name: string) =>
				this.callbackRegistry.renameGroup(groupId, name),
			deleteGroup: async (groupId: string) => this.callbackRegistry.deleteGroup(groupId),
			moveSessionToGroup: async (sessionId: string, groupId: string | null) =>
				this.callbackRegistry.moveSessionToGroup(sessionId, groupId),
			createSession: async (name: string, toolType: string, cwd: string, groupId?: string) =>
				this.callbackRegistry.createSession(name, toolType, cwd, groupId),
			deleteSession: async (sessionId: string) => this.callbackRegistry.deleteSession(sessionId),
			renameSession: async (sessionId: string, newName: string) =>
				this.callbackRegistry.renameSession(sessionId, newName),
			getGitStatus: async (sessionId: string) => this.callbackRegistry.getGitStatus(sessionId),
			getGitDiff: async (sessionId: string, filePath?: string) =>
				this.callbackRegistry.getGitDiff(sessionId, filePath),
			getGroupChats: async () => this.callbackRegistry.getGroupChats(),
			startGroupChat: async (topic: string, participantIds: string[]) =>
				this.callbackRegistry.startGroupChat(topic, participantIds),
			getGroupChatState: async (chatId: string) => this.callbackRegistry.getGroupChatState(chatId),
			stopGroupChat: async (chatId: string) => this.callbackRegistry.stopGroupChat(chatId),
			sendGroupChatMessage: async (chatId: string, message: string) =>
				this.callbackRegistry.sendGroupChatMessage(chatId, message),
			mergeContext: async (sourceSessionId: string, targetSessionId: string) =>
				this.callbackRegistry.mergeContext(sourceSessionId, targetSessionId),
			transferContext: async (sourceSessionId: string, targetSessionId: string) =>
				this.callbackRegistry.transferContext(sourceSessionId, targetSessionId),
			summarizeContext: async (sessionId: string) =>
				this.callbackRegistry.summarizeContext(sessionId),
			getCueSubscriptions: async (sessionId?: string) =>
				this.callbackRegistry.getCueSubscriptions(sessionId),
			toggleCueSubscription: async (subscriptionId: string, enabled: boolean) =>
				this.callbackRegistry.toggleCueSubscription(subscriptionId, enabled),
			getCueActivity: async (sessionId?: string, limit?: number) =>
				this.callbackRegistry.getCueActivity(sessionId, limit),
			getUsageDashboard: async (timeRange: 'day' | 'week' | 'month' | 'all') =>
				this.callbackRegistry.getUsageDashboard(timeRange),
			getAchievements: async () => this.callbackRegistry.getAchievements(),
			writeToTerminal: (sessionId: string, data: string) =>
				this.writeToTerminalCallback?.(sessionId, data) ?? false,
			resizeTerminal: (sessionId: string, cols: number, rows: number) =>
				this.resizeTerminalCallback?.(sessionId, cols, rows) ?? false,
			spawnTerminalForWeb: (
				sessionId: string,
				config: { cwd: string; cols?: number; rows?: number }
			) =>
				this.spawnTerminalForWebCallback?.(sessionId, config) ??
				Promise.resolve({ success: false, pid: 0 }),
			killTerminalForWeb: (sessionId: string) =>
				this.killTerminalForWebCallback?.(sessionId) ?? false,
		});
	}

	// ============ Broadcast Methods (Delegated to BroadcastService) ============

	broadcastToWebClients(message: object): void {
		this.broadcastService.broadcastToAll(message);
	}

	broadcastNotificationEvent(event: NotificationEvent): void {
		this.broadcastService.broadcastNotificationEvent(event);
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

	broadcastSettingsChanged(settings: WebSettings): void {
		this.broadcastService.broadcastSettingsChanged(settings);
	}

	broadcastAutoRunState(sessionId: string, state: AutoRunState | null): void {
		this.liveSessionManager.setAutoRunState(sessionId, state);
	}

	broadcastAutoRunDocsChanged(sessionId: string, documents: AutoRunDocument[]): void {
		this.broadcastService.broadcastAutoRunDocsChanged(sessionId, documents);
	}

	broadcastUserInput(sessionId: string, command: string, inputMode: 'ai' | 'terminal'): void {
		this.broadcastService.broadcastUserInput(sessionId, command, inputMode);
	}

	broadcastGroupChatMessage(chatId: string, message: GroupChatMessage): void {
		this.broadcastService.broadcastGroupChatMessage(chatId, message);
	}

	broadcastGroupChatStateChange(chatId: string, state: Partial<GroupChatState>): void {
		this.broadcastService.broadcastGroupChatStateChange(chatId, state);
	}

	broadcastContextOperationProgress(sessionId: string, operation: string, progress: number): void {
		this.broadcastService.broadcastContextOperationProgress(sessionId, operation, progress);
	}

	broadcastContextOperationComplete(sessionId: string, operation: string, success: boolean): void {
		this.broadcastService.broadcastContextOperationComplete(sessionId, operation, success);
	}

	broadcastCueActivity(entry: CueActivityEntry): void {
		this.broadcastService.broadcastCueActivity(entry);
	}

	broadcastCueSubscriptionsChanged(subscriptions: CueSubscriptionInfo[]): void {
		this.broadcastService.broadcastCueSubscriptionsChanged(subscriptions);
	}

	broadcastToolEvent(
		sessionId: string,
		tabId: string,
		toolLog: {
			id: string;
			timestamp: number;
			source: 'tool';
			text: string;
			metadata?: {
				toolState?: {
					name: string;
					status: 'running' | 'completed' | 'error';
					input?: Record<string, unknown>;
				};
			};
		}
	): void {
		this.broadcastService.broadcastToolEvent(sessionId, tabId, toolLog);
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
			// Detect LAN IP for display URLs, bind to 0.0.0.0 for LAN accessibility
			// Security token (UUID) prevents unauthorized access
			this.localIpAddress = await getLocalIpAddress();
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
