/**
 * Agent Dispatch Web Routes
 *
 * Exposes the Agent Dispatch runtime over HTTP so the mobile/web client can
 * reach the same data surfaces available via Electron IPC.
 *
 * All routes are gated by the `agentDispatch` encore feature flag.  When the
 * flag is off every endpoint returns HTTP 403 with a structured error body
 * that mirrors the IPC `FeatureDisabledError` shape:
 *
 *   { success: false, code: "FEATURE_DISABLED", feature: "agentDispatch" }
 *
 * Route map:
 *   GET  /$TOKEN/api/agent-dispatch/board            → agentDispatch:getBoard
 *   GET  /$TOKEN/api/agent-dispatch/fleet            → agentDispatch:getFleet
 *   POST /$TOKEN/api/agent-dispatch/claims           → agentDispatch:assignManually
 *   DELETE /$TOKEN/api/agent-dispatch/claims/:id     → agentDispatch:releaseClaim
 *   POST /$TOKEN/api/agent-dispatch/agents/:id/pause  → agentDispatch:pauseAgent
 *   POST /$TOKEN/api/agent-dispatch/agents/:id/resume → agentDispatch:resumeAgent
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import { getWorkGraphItemStore } from '../../work-graph';
import type { WorkItemFilters, WorkItemClaimReleaseInput } from '../../../shared/work-graph-types';
import type { ManualAssignmentInput } from '../../agent-dispatch/dispatch-engine';
import type { AgentDispatchRuntime } from '../../agent-dispatch/runtime';
import type { SettingsStoreInterface } from '../../stores/types';
import type { RateLimitConfig } from '../types';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = 'WebServer:AgentDispatch';

export interface AgentDispatchRouteDependencies {
	getRuntime: () => AgentDispatchRuntime | null;
	settingsStore: SettingsStoreInterface;
}

/**
 * Register Agent Dispatch HTTP routes on the Fastify server.
 *
 * @param server        - Fastify instance (already has middleware registered)
 * @param token         - Per-startup security token used as the URL prefix
 * @param rateLimitConfig - Shared rate-limit settings from WebServer
 * @param deps          - Runtime and settings dependencies
 */
export function registerAgentDispatchRoutes(
	server: FastifyInstance,
	token: string,
	rateLimitConfig: RateLimitConfig,
	deps: AgentDispatchRouteDependencies
): void {
	const workGraph = getWorkGraphItemStore();

	/** Return 403 with a feature-disabled body when the encore flag is off. */
	const replyFeatureDisabled = (reply: FastifyReply) => {
		return reply.code(403).send({
			success: false,
			code: 'FEATURE_DISABLED',
			feature: 'agentDispatch',
			timestamp: Date.now(),
		});
	};

	// ---------------------------------------------------------------------------
	// GET /api/agent-dispatch/board
	// Returns work-graph items suitable for a kanban board.
	// Query params are forwarded as WorkItemFilters (JSON-encoded or flat strings).
	// ---------------------------------------------------------------------------
	server.get(
		`/${token}/api/agent-dispatch/board`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.max,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'agentDispatch');
			if (gateError) {
				logger.debug('agentDispatch flag off — rejecting GET board', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			try {
				// Accept optional filters as a JSON body or ignore if not provided
				const filters = (request.body as WorkItemFilters | undefined) ?? {};
				const result = await workGraph.listItems(filters);
				return { success: true, data: result, timestamp: Date.now() };
			} catch (err) {
				logger.error('GET board error', LOG_CONTEXT, { error: String(err) });
				return reply.code(500).send({
					success: false,
					error: String(err),
					timestamp: Date.now(),
				});
			}
		}
	);

	// ---------------------------------------------------------------------------
	// GET /api/agent-dispatch/fleet
	// Returns all fleet entries from the in-memory FleetRegistry.
	// ---------------------------------------------------------------------------
	server.get(
		`/${token}/api/agent-dispatch/fleet`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.max,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (_request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'agentDispatch');
			if (gateError) {
				logger.debug('agentDispatch flag off — rejecting GET fleet', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			try {
				const runtime = deps.getRuntime();
				const data = runtime ? runtime.fleetRegistry.getEntries() : [];
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				logger.error('GET fleet error', LOG_CONTEXT, { error: String(err) });
				return reply.code(500).send({
					success: false,
					error: String(err),
					timestamp: Date.now(),
				});
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/agent-dispatch/claims
	// Manual assignment — body must be a valid ManualAssignmentInput.
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/agent-dispatch/claims`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'agentDispatch');
			if (gateError) {
				logger.debug('agentDispatch flag off — rejecting POST claims', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const input = request.body as ManualAssignmentInput | undefined;
			if (!input || !input.workItemId || !input.agent) {
				return reply.code(400).send({
					success: false,
					error: 'Request body must include workItemId and agent',
					timestamp: Date.now(),
				});
			}

			try {
				const runtime = deps.getRuntime();
				if (!runtime) throw new Error('Agent Dispatch runtime is not running');
				const data = await runtime.engine.assignManually(input);
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				logger.error('POST claims error', LOG_CONTEXT, { error: String(err) });
				return reply.code(500).send({
					success: false,
					error: String(err),
					timestamp: Date.now(),
				});
			}
		}
	);

	// ---------------------------------------------------------------------------
	// DELETE /api/agent-dispatch/claims/:id
	// Releases an active claim. :id is the workItemId.
	// An optional JSON body may carry additional WorkItemClaimReleaseInput fields.
	// ---------------------------------------------------------------------------
	server.delete(
		`/${token}/api/agent-dispatch/claims/:id`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'agentDispatch');
			if (gateError) {
				logger.debug('agentDispatch flag off — rejecting DELETE claims/:id', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const { id } = request.params as { id: string };
			const body = (request.body as Partial<WorkItemClaimReleaseInput>) ?? {};
			const input: WorkItemClaimReleaseInput = { workItemId: id, ...body };

			try {
				const data = await workGraph.releaseClaim(input);
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				logger.error('DELETE claims/:id error', LOG_CONTEXT, { error: String(err) });
				return reply.code(500).send({
					success: false,
					error: String(err),
					timestamp: Date.now(),
				});
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/agent-dispatch/agents/:id/pause
	// Pauses auto-pickup for an agent (in-memory, resets on restart).
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/agent-dispatch/agents/:id/pause`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'agentDispatch');
			if (gateError) {
				logger.debug('agentDispatch flag off — rejecting POST agents/:id/pause', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const { id } = request.params as { id: string };

			try {
				const runtime = deps.getRuntime();
				if (!runtime) throw new Error('Agent Dispatch runtime is not running');
				runtime.fleetRegistry.pause(id);
				return { success: true, data: { paused: true }, timestamp: Date.now() };
			} catch (err) {
				logger.error('POST agents/:id/pause error', LOG_CONTEXT, { error: String(err) });
				return reply.code(500).send({
					success: false,
					error: String(err),
					timestamp: Date.now(),
				});
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/agent-dispatch/agents/:id/resume
	// Resumes auto-pickup for a previously-paused agent.
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/agent-dispatch/agents/:id/resume`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'agentDispatch');
			if (gateError) {
				logger.debug('agentDispatch flag off — rejecting POST agents/:id/resume', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const { id } = request.params as { id: string };

			try {
				const runtime = deps.getRuntime();
				if (!runtime) throw new Error('Agent Dispatch runtime is not running');
				runtime.fleetRegistry.resume(id);
				return { success: true, data: { paused: false }, timestamp: Date.now() };
			} catch (err) {
				logger.error('POST agents/:id/resume error', LOG_CONTEXT, { error: String(err) });
				return reply.code(500).send({
					success: false,
					error: String(err),
					timestamp: Date.now(),
				});
			}
		}
	);

	logger.debug('Agent Dispatch routes registered', LOG_CONTEXT);
}
