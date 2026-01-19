/**
 * API Routes for Web Server
 *
 * This module contains all REST API route handlers extracted from web-server.ts.
 * Routes are under /$TOKEN/api/* and handle session data, theme, history, and commands.
 *
 * API Endpoints:
 * - GET /api/sessions - List all sessions with live info
 * - GET /api/session/:id - Get single session detail
 * - POST /api/session/:id/send - Send command to session
 * - GET /api/theme - Get current theme
 * - POST /api/session/:id/interrupt - Interrupt session
 * - GET /api/history - Get history entries
 */

import { FastifyInstance } from 'fastify';
import { HistoryEntry } from '../../../shared/types';
import { logger } from '../../utils/logger';

// Logger context for all API route logs
const LOG_CONTEXT = 'WebServer:API';

/**
 * Usage stats type for session cost/token tracking
 */
export interface SessionUsageStats {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	totalCostUsd?: number;
	contextWindow?: number;
}

/**
 * Last response type for mobile preview (truncated to save bandwidth)
 */
export interface LastResponsePreview {
	text: string; // First 3 lines or ~500 chars of the last AI response
	timestamp: number;
	source: 'stdout' | 'stderr' | 'system';
	fullLength: number; // Total length of the original response
}

/**
 * AI Tab type for multi-tab support within a Maestro session
 */
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

/**
 * Session data returned by getSessions callback
 */
export interface SessionData {
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
	thinkingStartTime?: number | null;
	aiTabs?: AITabData[];
	activeTabId?: string;
	bookmarked?: boolean;
}

/**
 * Session detail type for single session endpoint
 */
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

// HistoryEntry is imported from shared/types.ts as the canonical type

/**
 * Live session info for enriching sessions
 */
export interface LiveSessionInfo {
	sessionId: string;
	agentSessionId?: string;
	enabledAt: number;
}

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
	max: number;
	timeWindow: number;
	maxPost: number;
	enabled: boolean;
}

/**
 * Theme type (imported from shared, re-exported for convenience)
 */
export type { Theme } from '../../../shared/theme-types';
import type { Theme } from '../../../shared/theme-types';

/**
 * Callbacks required by API routes
 */
export interface ApiRouteCallbacks {
	getSessions: () => SessionData[];
	getSessionDetail: (sessionId: string, tabId?: string) => SessionDetail | null;
	getTheme: () => Theme | null;
	writeToSession: (sessionId: string, data: string) => boolean;
	interruptSession: (sessionId: string) => Promise<boolean>;
	getHistory: (projectPath?: string, sessionId?: string) => HistoryEntry[];
	getLiveSessionInfo: (sessionId: string) => LiveSessionInfo | undefined;
	isSessionLive: (sessionId: string) => boolean;
}

/**
 * API Routes Class
 *
 * Encapsulates all REST API route setup logic.
 * Uses dependency injection for callbacks to maintain separation from WebServer class.
 */
export class ApiRoutes {
	private callbacks: Partial<ApiRouteCallbacks> = {};
	private rateLimitConfig: RateLimitConfig;
	private securityToken: string;

	constructor(securityToken: string, rateLimitConfig: RateLimitConfig) {
		this.securityToken = securityToken;
		this.rateLimitConfig = rateLimitConfig;
	}

	/**
	 * Set the callbacks for API operations
	 */
	setCallbacks(callbacks: ApiRouteCallbacks): void {
		this.callbacks = callbacks;
	}

	/**
	 * Update rate limit configuration
	 */
	updateRateLimitConfig(config: RateLimitConfig): void {
		this.rateLimitConfig = config;
	}

	/**
	 * Register all API routes on the Fastify server
	 */
	registerRoutes(server: FastifyInstance): void {
		const token = this.securityToken;

		// Get all sessions (not just "live" ones - security token protects access)
		server.get(
			`/${token}/api/sessions`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async () => {
				const sessions = this.callbacks.getSessions ? this.callbacks.getSessions() : [];

				// Enrich all sessions with live info if available
				const sessionData = sessions.map((s) => {
					const liveInfo = this.callbacks.getLiveSessionInfo?.(s.id);
					return {
						...s,
						agentSessionId: liveInfo?.agentSessionId || s.agentSessionId,
						liveEnabledAt: liveInfo?.enabledAt,
						isLive: this.callbacks.isSessionLive?.(s.id) || false,
					};
				});

				return {
					sessions: sessionData,
					count: sessionData.length,
					timestamp: Date.now(),
				};
			}
		);

		// Session detail endpoint - works for any valid session (security token protects access)
		// Optional ?tabId= query param to fetch logs for a specific tab (avoids race conditions)
		server.get(
			`/${token}/api/session/:id`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };
				const { tabId } = request.query as { tabId?: string };

				if (!this.callbacks.getSessionDetail) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Session detail service not configured',
						timestamp: Date.now(),
					});
				}

				const session = this.callbacks.getSessionDetail(id, tabId);
				if (!session) {
					return reply.code(404).send({
						error: 'Not Found',
						message: `Session with id '${id}' not found`,
						timestamp: Date.now(),
					});
				}

				const liveInfo = this.callbacks.getLiveSessionInfo?.(id);
				return {
					session: {
						...session,
						agentSessionId: liveInfo?.agentSessionId || session.agentSessionId,
						liveEnabledAt: liveInfo?.enabledAt,
						isLive: this.callbacks.isSessionLive?.(id) || false,
					},
					timestamp: Date.now(),
				};
			}
		);

		// Send command to session - works for any valid session (security token protects access)
		server.post(
			`/${token}/api/session/:id/send`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };
				const body = request.body as { command?: string } | undefined;
				const command = body?.command;

				if (!command || typeof command !== 'string') {
					return reply.code(400).send({
						error: 'Bad Request',
						message: 'Command is required and must be a string',
						timestamp: Date.now(),
					});
				}

				if (!this.callbacks.writeToSession) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Session write service not configured',
						timestamp: Date.now(),
					});
				}

				const success = this.callbacks.writeToSession(id, command + '\n');
				if (!success) {
					return reply.code(500).send({
						error: 'Internal Server Error',
						message: 'Failed to send command to session',
						timestamp: Date.now(),
					});
				}

				return {
					success: true,
					message: 'Command sent successfully',
					sessionId: id,
					timestamp: Date.now(),
				};
			}
		);

		// Theme endpoint
		server.get(
			`/${token}/api/theme`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (_request, reply) => {
				if (!this.callbacks.getTheme) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Theme service not configured',
						timestamp: Date.now(),
					});
				}

				const theme = this.callbacks.getTheme();
				if (!theme) {
					return reply.code(404).send({
						error: 'Not Found',
						message: 'No theme currently configured',
						timestamp: Date.now(),
					});
				}

				return {
					theme,
					timestamp: Date.now(),
				};
			}
		);

		// Interrupt session - works for any valid session (security token protects access)
		server.post(
			`/${token}/api/session/:id/interrupt`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };

				if (!this.callbacks.interruptSession) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Session interrupt service not configured',
						timestamp: Date.now(),
					});
				}

				try {
					// Forward to desktop's interrupt logic - handles state updates and broadcasts
					const success = await this.callbacks.interruptSession(id);
					if (!success) {
						return reply.code(500).send({
							error: 'Internal Server Error',
							message: 'Failed to interrupt session',
							timestamp: Date.now(),
						});
					}

					return {
						success: true,
						message: 'Interrupt signal sent successfully',
						sessionId: id,
						timestamp: Date.now(),
					};
				} catch (error: any) {
					return reply.code(500).send({
						error: 'Internal Server Error',
						message: `Failed to interrupt session: ${error.message}`,
						timestamp: Date.now(),
					});
				}
			}
		);

		// History endpoint - returns history entries filtered by project/session
		server.get(
			`/${token}/api/history`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				if (!this.callbacks.getHistory) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'History service not configured',
						timestamp: Date.now(),
					});
				}

				// Extract optional projectPath and sessionId from query params
				const { projectPath, sessionId } = request.query as {
					projectPath?: string;
					sessionId?: string;
				};

				try {
					const entries = this.callbacks.getHistory(projectPath, sessionId);
					return {
						entries,
						count: entries.length,
						timestamp: Date.now(),
					};
				} catch (error: any) {
					return reply.code(500).send({
						error: 'Internal Server Error',
						message: `Failed to fetch history: ${error.message}`,
						timestamp: Date.now(),
					});
				}
			}
		);

		logger.debug('API routes registered', LOG_CONTEXT);
	}
}
