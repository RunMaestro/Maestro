/**
 * WebSocket Route for Web Server
 *
 * This module contains the WebSocket route setup extracted from web-server.ts.
 * Handles WebSocket connections, initial state sync, and message delegation.
 *
 * Route: /:token/ws
 *
 * Authentication:
 * 1. If URL token matches securityToken, connection proceeds (browser auth)
 * 2. If URL token doesn't match, validate as mobile token via mobile-pairing module
 * 3. If mobile token is valid, update lastUsedAt and proceed
 * 4. If neither matches, reject with auth failure
 *
 * Connection Flow (after auth):
 * 1. Client connects with optional ?sessionId= query param
 * 2. Server sends 'connected' message with client ID
 * 3. Server sends 'sessions_list' with all sessions (enriched with live info)
 * 4. Server sends 'theme' with current theme
 * 5. Server sends 'custom_commands' with available commands
 * 6. Client can send messages which are delegated to WebSocketMessageHandler
 */

import { FastifyInstance } from 'fastify';
import { logger } from '../../utils/logger';
import { validateMobileToken, updateDeviceLastUsed } from '../../mobile-pairing';
import type {
	Theme,
	WebClient,
	WebClientMessage,
	LiveSessionInfo,
	CustomAICommand,
	AutoRunState,
	SessionData,
} from '../types';

// Re-export types for backwards compatibility
export type { LiveSessionInfo, CustomAICommand } from '../types';

// Logger context for all WebSocket route logs
const LOG_CONTEXT = 'WebServer:WS';

/**
 * Session data for WebSocket initial sync.
 * Uses SessionData as the base type.
 */
export type WsSessionData = SessionData;

/**
 * Callbacks required by WebSocket route
 */
export interface WsRouteCallbacks {
	getSessions: () => SessionData[];
	getTheme: () => Theme | null;
	getBionifyReadingMode: () => boolean;
	getCustomCommands: () => CustomAICommand[];
	getAutoRunStates: () => Map<string, AutoRunState>;
	getLiveSessionInfo: (sessionId: string) => LiveSessionInfo | undefined;
	isSessionLive: (sessionId: string) => boolean;
	onClientConnect: (client: WebClient) => void;
	onClientDisconnect: (clientId: string) => void;
	onClientError: (clientId: string, error: Error) => void;
	handleMessage: (clientId: string, message: WebClientMessage) => void;
}

/**
 * WebSocket Route Class
 *
 * Encapsulates WebSocket route setup and connection handling.
 * Delegates message handling to WebSocketMessageHandler via callbacks.
 */
export class WsRoute {
	private securityToken: string;
	private callbacks: Partial<WsRouteCallbacks> = {};
	private clientIdCounter: number = 0;

	constructor(securityToken: string) {
		this.securityToken = securityToken;
	}

	/**
	 * Set the callbacks for WebSocket operations
	 */
	setCallbacks(callbacks: WsRouteCallbacks): void {
		this.callbacks = callbacks;
	}

	/**
	 * Register the WebSocket route on the Fastify server.
	 * Uses wildcard route to validate both browser security tokens and mobile tokens.
	 */
	registerRoute(server: FastifyInstance): void {
		// Use wildcard route to capture any token for validation
		server.get('/:token/ws', { websocket: true }, async (connection, request) => {
			// Extract token from URL path
			const urlPath = request.url || '';
			const tokenMatch = urlPath.match(/^\/([^/]+)\/ws/);
			const urlToken = tokenMatch ? tokenMatch[1] : '';

			// Validate token: first check browser security token, then mobile token
			let isMobileClient = false;
			let mobileDeviceId: string | undefined;

			if (urlToken !== this.securityToken) {
				// Not the browser token - try mobile token validation
				const device = await validateMobileToken(urlToken);
				if (!device) {
					// Neither browser nor mobile token - reject
					logger.warn(`Auth failed: invalid token from ${request.ip}`, LOG_CONTEXT);
					connection.socket.send(
						JSON.stringify({
							type: 'error',
							message: 'Authentication failed: invalid token',
							code: 'AUTH_FAILED',
						})
					);
					connection.socket.close(4001, 'Authentication failed');
					return;
				}
				// Valid mobile token
				isMobileClient = true;
				mobileDeviceId = device.id;
				// Update lastUsedAt in background (don't await)
				updateDeviceLastUsed(device.id).catch((err) => {
					logger.warn(`Failed to update device lastUsedAt: ${err}`, LOG_CONTEXT);
				});
				logger.info(`Mobile client authenticated: ${device.deviceName}`, LOG_CONTEXT);
			}

			const clientId = `${isMobileClient ? 'mobile' : 'web'}-client-${++this.clientIdCounter}`;

			// Extract sessionId from query string if provided (for session-specific subscriptions)
			const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
			const sessionId = url.searchParams.get('sessionId') || undefined;

			const client: WebClient = {
				socket: connection.socket,
				id: clientId,
				connectedAt: Date.now(),
				subscribedSessionId: sessionId,
				isMobileClient,
				mobileDeviceId,
			};

			// Notify parent about connection
			this.callbacks.onClientConnect?.(client);
			logger.info(
				`Client connected: ${clientId} (session: ${sessionId || 'dashboard'})`,
				LOG_CONTEXT
			);

			// Send connection confirmation
			connection.socket.send(
				JSON.stringify({
					type: 'connected',
					clientId,
					message: 'Connected to Maestro Web Interface',
					subscribedSessionId: sessionId,
					timestamp: Date.now(),
				})
			);

			// Send initial sessions list (all sessions, not just "live" ones)
			if (this.callbacks.getSessions) {
				const allSessions = this.callbacks.getSessions();
				const sessionsWithLiveInfo = allSessions.map((s) => {
					const liveInfo = this.callbacks.getLiveSessionInfo?.(s.id);
					return {
						...s,
						agentSessionId: liveInfo?.agentSessionId || s.agentSessionId,
						liveEnabledAt: liveInfo?.enabledAt,
						isLive: this.callbacks.isSessionLive?.(s.id) || false,
					};
				});
				connection.socket.send(
					JSON.stringify({
						type: 'sessions_list',
						sessions: sessionsWithLiveInfo,
						timestamp: Date.now(),
					})
				);
			}

			// Send current theme
			if (this.callbacks.getTheme) {
				const theme = this.callbacks.getTheme();
				if (theme) {
					connection.socket.send(
						JSON.stringify({
							type: 'theme',
							theme,
							timestamp: Date.now(),
						})
					);
				}
			}

			// Send current global Bionify reading-mode setting
			if (this.callbacks.getBionifyReadingMode) {
				connection.socket.send(
					JSON.stringify({
						type: 'bionify_reading_mode',
						enabled: this.callbacks.getBionifyReadingMode(),
						timestamp: Date.now(),
					})
				);
			}

			// Send custom AI commands
			if (this.callbacks.getCustomCommands) {
				const customCommands = this.callbacks.getCustomCommands();
				connection.socket.send(
					JSON.stringify({
						type: 'custom_commands',
						commands: customCommands,
						timestamp: Date.now(),
					})
				);
			}

			// Send current AutoRun states for all sessions
			if (this.callbacks.getAutoRunStates) {
				const autoRunStates = this.callbacks.getAutoRunStates();
				logger.info(
					`Sending initial AutoRun states to new client: ${autoRunStates.size} active sessions`,
					LOG_CONTEXT
				);
				autoRunStates.forEach((state, sid) => {
					if (state.isRunning) {
						logger.info(
							`Sending initial AutoRun state for session ${sid}: tasks=${state.completedTasks}/${state.totalTasks}`,
							LOG_CONTEXT
						);
						connection.socket.send(
							JSON.stringify({
								type: 'autorun_state',
								sessionId: sid,
								state,
								timestamp: Date.now(),
							})
						);
					}
				});
			}

			// Handle incoming messages
			connection.socket.on('message', (message) => {
				try {
					const data = JSON.parse(message.toString()) as WebClientMessage;
					this.callbacks.handleMessage?.(clientId, data);
				} catch {
					connection.socket.send(
						JSON.stringify({
							type: 'error',
							message: 'Invalid message format',
						})
					);
				}
			});

			// Handle disconnection
			connection.socket.on('close', () => {
				this.callbacks.onClientDisconnect?.(clientId);
				logger.info(`Client disconnected: ${clientId}`, LOG_CONTEXT);
			});

			// Handle errors
			connection.socket.on('error', (error) => {
				logger.error(`Client error (${clientId})`, LOG_CONTEXT, error);
				this.callbacks.onClientError?.(clientId, error);
			});
		});

		logger.debug('WebSocket route registered', LOG_CONTEXT);
	}
}
