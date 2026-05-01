/**
 * Conversational PRD Planner Web Routes
 *
 * Exposes the Conversational PRD Planner over HTTP so the mobile/web client
 * can reach the same data surfaces available via Electron IPC.
 *
 * All routes are gated by the `conversationalPrd` encore feature flag.  When
 * the flag is off every endpoint returns HTTP 403 with a structured error body
 * that mirrors the IPC `FeatureDisabledError` shape:
 *
 *   { success: false, code: "FEATURE_DISABLED", feature: "conversationalPrd" }
 *
 * Route map:
 *   GET    /$TOKEN/api/conversational-prd/sessions            → conversationalPrd:listSessions
 *   POST   /$TOKEN/api/conversational-prd/sessions            → conversationalPrd:createSession
 *   GET    /$TOKEN/api/conversational-prd/sessions/:id        → conversationalPrd:getSession
 *   POST   /$TOKEN/api/conversational-prd/sessions/:id/messages  → conversationalPrd:sendMessage
 *   POST   /$TOKEN/api/conversational-prd/sessions/:id/finalize  → conversationalPrd:finalizeSession
 *   DELETE /$TOKEN/api/conversational-prd/sessions/:id        → conversationalPrd:archiveSession
 *
 * Streaming note (v1): `sendMessage` settles the full assistant response before
 * returning a single JSON body.  The structured-gateway latency has not been
 * measured at web-client scale; if it proves unacceptable, replace this route
 * with an SSE or WebSocket stream in a follow-up issue.
 * TODO: evaluate SSE streaming for sendMessage once mobile client benchmarks
 *       are available.
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import type {
	ConversationalPrdFinalizeRequest,
	ConversationalPrdStartRequest,
	ConversationalPrdTurnRequest,
} from '../../../shared/conversational-prd-types';
import type { WorkGraphActor } from '../../../shared/work-graph-types';
import type { ConversationalPrdService } from '../../conversational-prd/service';
import type { SettingsStoreInterface } from '../../stores/types';
import type { RateLimitConfig } from '../types';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = 'WebServer:ConversationalPrd';

export interface ConversationalPrdRouteDependencies {
	getService: () => ConversationalPrdService | null;
	settingsStore: SettingsStoreInterface;
}

/**
 * Register Conversational PRD HTTP routes on the Fastify server.
 *
 * @param server          - Fastify instance (already has middleware registered)
 * @param token           - Per-startup security token used as the URL prefix
 * @param rateLimitConfig - Shared rate-limit settings from WebServer
 * @param deps            - Service and settings dependencies
 */
export function registerConversationalPrdRoutes(
	server: FastifyInstance,
	token: string,
	rateLimitConfig: RateLimitConfig,
	deps: ConversationalPrdRouteDependencies
): void {
	/** Return 403 with a feature-disabled body when the encore flag is off. */
	const replyFeatureDisabled = (reply: FastifyReply) => {
		return reply.code(403).send({
			success: false,
			code: 'FEATURE_DISABLED',
			feature: 'conversationalPrd',
			timestamp: Date.now(),
		});
	};

	/** Return 503 when the service singleton is not yet initialised. */
	const replyServiceUnavailable = (reply: FastifyReply) => {
		return reply.code(503).send({
			success: false,
			error: 'Conversational PRD service is not available',
			timestamp: Date.now(),
		});
	};

	// ---------------------------------------------------------------------------
	// GET /api/conversational-prd/sessions
	// List sessions; optional query params: projectPath, includeArchived.
	// ---------------------------------------------------------------------------
	server.get(
		`/${token}/api/conversational-prd/sessions`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.max,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'conversationalPrd');
			if (gateError) {
				logger.debug('conversationalPrd flag off — rejecting GET sessions', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const svc = deps.getService();
			if (!svc) return replyServiceUnavailable(reply);

			try {
				const query = request.query as {
					projectPath?: string;
					includeArchived?: string;
				};
				const filters: { projectPath?: string; includeArchived?: boolean } = {};
				if (query.projectPath) filters.projectPath = query.projectPath;
				if (query.includeArchived !== undefined)
					filters.includeArchived = query.includeArchived === 'true';

				const data = svc.listSessions(filters);
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				logger.error('GET sessions error', LOG_CONTEXT, { error: String(err) });
				return reply.code(500).send({
					success: false,
					error: String(err),
					timestamp: Date.now(),
				});
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/conversational-prd/sessions
	// Start a new planning conversation.
	// Body: ConversationalPrdStartRequest (projectPath?, gitPath?, greeting?, actor?)
	// Returns: { conversationId, greeting }
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/conversational-prd/sessions`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'conversationalPrd');
			if (gateError) {
				logger.debug('conversationalPrd flag off — rejecting POST sessions', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const svc = deps.getService();
			if (!svc) return replyServiceUnavailable(reply);

			try {
				const input = (request.body ?? {}) as ConversationalPrdStartRequest;
				const data = await svc.createSession(input);
				return reply.code(201).send({ success: true, data, timestamp: Date.now() });
			} catch (err) {
				logger.error('POST sessions error', LOG_CONTEXT, { error: String(err) });
				return reply.code(500).send({
					success: false,
					error: String(err),
					timestamp: Date.now(),
				});
			}
		}
	);

	// ---------------------------------------------------------------------------
	// GET /api/conversational-prd/sessions/:id
	// Fetch a single session by conversationId.
	// Returns 404 when the session does not exist.
	// ---------------------------------------------------------------------------
	server.get(
		`/${token}/api/conversational-prd/sessions/:id`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.max,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'conversationalPrd');
			if (gateError) {
				logger.debug('conversationalPrd flag off — rejecting GET sessions/:id', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const svc = deps.getService();
			if (!svc) return replyServiceUnavailable(reply);

			const { id } = request.params as { id: string };

			try {
				const data = svc.getSession(id) ?? null;
				if (!data) {
					return reply.code(404).send({
						success: false,
						error: `Session "${id}" not found`,
						timestamp: Date.now(),
					});
				}
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				logger.error('GET sessions/:id error', LOG_CONTEXT, { error: String(err) });
				return reply.code(500).send({
					success: false,
					error: String(err),
					timestamp: Date.now(),
				});
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/conversational-prd/sessions/:id/messages
	// Submit a user turn and receive the next assistant response.
	// Body: { message: string, actor?: WorkGraphActor }
	// Returns full turn response (settle-then-return; see streaming TODO above).
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/conversational-prd/sessions/:id/messages`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'conversationalPrd');
			if (gateError) {
				logger.debug(
					'conversationalPrd flag off — rejecting POST sessions/:id/messages',
					LOG_CONTEXT
				);
				return replyFeatureDisabled(reply);
			}

			const svc = deps.getService();
			if (!svc) return replyServiceUnavailable(reply);

			const { id } = request.params as { id: string };
			const body = (request.body ?? {}) as { message?: string; actor?: WorkGraphActor };

			if (!body.message || typeof body.message !== 'string') {
				return reply.code(400).send({
					success: false,
					error: 'Request body must include a non-empty "message" string',
					timestamp: Date.now(),
				});
			}

			const input: ConversationalPrdTurnRequest = {
				conversationId: id,
				message: body.message,
				...(body.actor ? { actor: body.actor } : {}),
			};

			try {
				const data = await svc.sendMessage(input);
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				logger.error('POST sessions/:id/messages error', LOG_CONTEXT, { error: String(err) });
				return reply.code(500).send({
					success: false,
					error: String(err),
					timestamp: Date.now(),
				});
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/conversational-prd/sessions/:id/finalize
	// Commit draft as a Delivery Planner PRD Work Graph item.
	// Body: Partial<ConversationalPrdFinalizeRequest> (handoffToPlanner?, actor?)
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/conversational-prd/sessions/:id/finalize`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'conversationalPrd');
			if (gateError) {
				logger.debug(
					'conversationalPrd flag off — rejecting POST sessions/:id/finalize',
					LOG_CONTEXT
				);
				return replyFeatureDisabled(reply);
			}

			const svc = deps.getService();
			if (!svc) return replyServiceUnavailable(reply);

			const { id } = request.params as { id: string };
			const body = (request.body ?? {}) as { actor?: WorkGraphActor };

			const input: ConversationalPrdFinalizeRequest = {
				conversationId: id,
				...(body.actor ? { actor: body.actor } : {}),
			};

			try {
				const data = await svc.finalizeSession(input);
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				logger.error('POST sessions/:id/finalize error', LOG_CONTEXT, { error: String(err) });
				return reply.code(500).send({
					success: false,
					error: String(err),
					timestamp: Date.now(),
				});
			}
		}
	);

	// ---------------------------------------------------------------------------
	// DELETE /api/conversational-prd/sessions/:id
	// Archive a session (hides from default list without deleting data).
	// Optional body: { actor?: WorkGraphActor }
	// ---------------------------------------------------------------------------
	server.delete(
		`/${token}/api/conversational-prd/sessions/:id`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'conversationalPrd');
			if (gateError) {
				logger.debug('conversationalPrd flag off — rejecting DELETE sessions/:id', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const svc = deps.getService();
			if (!svc) return replyServiceUnavailable(reply);

			const { id } = request.params as { id: string };
			const body = (request.body ?? {}) as { actor?: WorkGraphActor };

			try {
				const data = await svc.archiveSession({ sessionId: id, actor: body.actor });
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				logger.error('DELETE sessions/:id error', LOG_CONTEXT, { error: String(err) });
				return reply.code(500).send({
					success: false,
					error: String(err),
					timestamp: Date.now(),
				});
			}
		}
	);

	logger.debug('Conversational PRD routes registered', LOG_CONTEXT);
}
