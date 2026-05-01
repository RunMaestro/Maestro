/**
 * Delivery Planner Web Routes
 *
 * Exposes the Delivery Planner (PRD / epic / task CRUD) over HTTP so the
 * mobile/web client can reach the same data surfaces available via Electron IPC.
 *
 * All routes are gated by the `deliveryPlanner` encore feature flag.  When the
 * flag is off every endpoint returns HTTP 403 with a structured error body that
 * mirrors the IPC `FeatureDisabledError` shape:
 *
 *   { success: false, code: "FEATURE_DISABLED", feature: "deliveryPlanner" }
 *
 * Mirror writes that detect an on-disk hash conflict return HTTP 409 with:
 *
 *   { success: false, code: "MIRROR_CONFLICT", filePath, expectedMirrorHash, actualMirrorHash }
 *
 * Route map:
 *   GET  /$TOKEN/api/delivery-planner/dashboard               → deliveryPlanner:dashboard
 *   GET  /$TOKEN/api/delivery-planner/prds                    → deliveryPlanner:dashboard (list PRDs)
 *   POST /$TOKEN/api/delivery-planner/prd                     → deliveryPlanner:createPrd
 *   GET  /$TOKEN/api/delivery-planner/prd/:id                 → deliveryPlanner:dashboard (single PRD)
 *   POST /$TOKEN/api/delivery-planner/prd/:id/decompose       → deliveryPlanner:decomposePrd
 *   POST /$TOKEN/api/delivery-planner/epic/:id/decompose      → deliveryPlanner:decomposeEpic
 *   POST /$TOKEN/api/delivery-planner/sync-github             → deliveryPlanner:sync (github target)
 *   POST /$TOKEN/api/delivery-planner/sync-mirror             → deliveryPlanner:sync (mirror target)
 *   POST /$TOKEN/api/delivery-planner/sync                    → deliveryPlanner:sync (all targets)
 *   POST /$TOKEN/api/delivery-planner/bug-follow-up           → deliveryPlanner:createBugFollowUp
 *   POST /$TOKEN/api/delivery-planner/progress-comment        → deliveryPlanner:addProgressComment
 *   GET  /$TOKEN/api/delivery-planner/progress                → deliveryPlanner:listProgress
 *   GET  /$TOKEN/api/delivery-planner/progress/:id            → deliveryPlanner:getProgress
 *   POST /$TOKEN/api/delivery-planner/resolve-paths           → deliveryPlanner:resolvePaths
 *   POST /$TOKEN/api/delivery-planner/promote-doc-gap         → deliveryPlanner:promoteDocGap
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import { PlannerMirrorConflictError } from '../../delivery-planner/external-mirror';
import type { DeliveryPlannerService } from '../../delivery-planner';
import type {
	DeliveryPlannerCreatePrdRequest,
	DeliveryPlannerDecomposeEpicRequest,
	DeliveryPlannerDecomposePrdRequest,
	DeliveryPlannerBugFollowUpRequest,
	DeliveryPlannerProgressCommentRequest,
	DeliveryPlannerPathResolutionRequest,
	DeliveryPlannerPromoteDocGapRequest,
	DeliveryPlannerSyncRequest,
} from '../../../shared/delivery-planner-types';
import { WORK_GRAPH_READY_TAG } from '../../../shared/work-graph-types';
import { indexPlanningArtifacts } from '../../delivery-planner';
import { getWorkGraphItemStore, publishWorkGraphEvent } from '../../work-graph';
import type { SettingsStoreInterface } from '../../stores/types';
import type { RateLimitConfig } from '../types';
import { logger } from '../../utils/logger';
import path from 'path';
import type { BrowserWindow } from 'electron';

const LOG_CONTEXT = 'WebServer:DeliveryPlanner';

export interface DeliveryPlannerRouteDependencies {
	getService: () => DeliveryPlannerService | null;
	getMainWindow: () => BrowserWindow | null;
	settingsStore: SettingsStoreInterface;
}

/**
 * Register Delivery Planner HTTP routes on the Fastify server.
 *
 * @param server          - Fastify instance (already has middleware registered)
 * @param token           - Per-startup security token used as the URL prefix
 * @param rateLimitConfig - Shared rate-limit settings from WebServer
 * @param deps            - Service and settings dependencies
 */
export function registerDeliveryPlannerRoutes(
	server: FastifyInstance,
	token: string,
	rateLimitConfig: RateLimitConfig,
	deps: DeliveryPlannerRouteDependencies
): void {
	const workGraph = getWorkGraphItemStore();

	/** Return 403 with a feature-disabled body when the encore flag is off. */
	const replyFeatureDisabled = (reply: FastifyReply) => {
		return reply.code(403).send({
			success: false,
			code: 'FEATURE_DISABLED',
			feature: 'deliveryPlanner',
			timestamp: Date.now(),
		});
	};

	/** Translate a PlannerMirrorConflictError into a 409 response. */
	const replyMirrorConflict = (reply: FastifyReply, err: PlannerMirrorConflictError) => {
		return reply.code(409).send({
			success: false,
			code: 'MIRROR_CONFLICT',
			filePath: err.filePath,
			expectedMirrorHash: err.expectedMirrorHash,
			actualMirrorHash: err.actualMirrorHash,
			message: err.message,
			timestamp: Date.now(),
		});
	};

	/** Shared error handler that distinguishes conflict from unexpected errors. */
	const handleRouteError = (reply: FastifyReply, operation: string, err: unknown) => {
		if (err instanceof PlannerMirrorConflictError) {
			logger.debug(`${operation} mirror conflict`, LOG_CONTEXT, { file: err.filePath });
			return replyMirrorConflict(reply, err);
		}
		logger.error(`${operation} error`, LOG_CONTEXT, { error: String(err) });
		return reply.code(500).send({
			success: false,
			error: String(err),
			timestamp: Date.now(),
		});
	};

	// ---------------------------------------------------------------------------
	// GET /api/delivery-planner/dashboard
	// Returns the full dashboard snapshot (PRDs, epics, tasks, progress).
	// Accepts optional query params: projectPath, gitPath.
	// ---------------------------------------------------------------------------
	server.get(
		`/${token}/api/delivery-planner/dashboard`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.max,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting GET dashboard', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const { projectPath, gitPath } =
				(request.query as { projectPath?: string; gitPath?: string }) ?? {};

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');

				if (projectPath) {
					await indexPlanningArtifacts({
						workGraph,
						projectPath,
						gitPath,
						actor: { type: 'system', id: 'delivery-planner', name: 'Delivery Planner' },
						publish: (operation, payload) => {
							publishWorkGraphEvent(deps.getMainWindow, operation, payload);
						},
					});
				}

				const dashboard = await service.listDashboard({ projectPath, gitPath });
				return {
					success: true,
					data: {
						...dashboard,
						filters: { projectPath, gitPath },
						githubSync: undefined,
						readyTag: WORK_GRAPH_READY_TAG,
					},
					timestamp: Date.now(),
				};
			} catch (err) {
				return handleRouteError(reply, 'GET dashboard', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// GET /api/delivery-planner/prds
	// Lists PRDs in the active (or specified) project.  Alias for dashboard with
	// a PRD-focused response shape so mobile clients have a simple list endpoint.
	// ---------------------------------------------------------------------------
	server.get(
		`/${token}/api/delivery-planner/prds`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.max,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting GET prds', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const { projectPath, gitPath } =
				(request.query as { projectPath?: string; gitPath?: string }) ?? {};

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');

				const dashboard = await service.listDashboard({ projectPath, gitPath });
				// PRDs are stored with WorkItem type 'feature' per DELIVERY_PLANNER_CONCEPT_TO_WORK_ITEM_TYPE
				const prds = dashboard.items.filter((item) => item.type === 'feature');
				return {
					success: true,
					data: prds,
					timestamp: Date.now(),
				};
			} catch (err) {
				return handleRouteError(reply, 'GET prds', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/delivery-planner/prd
	// Create a new PRD.  Body must be a valid DeliveryPlannerCreatePrdRequest.
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/delivery-planner/prd`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting POST prd', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const input = request.body as DeliveryPlannerCreatePrdRequest | undefined;
			if (!input || !input.title) {
				return reply.code(400).send({
					success: false,
					error: 'Request body must include title',
					timestamp: Date.now(),
				});
			}

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');
				const data = await service.createPrd(input);
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				return handleRouteError(reply, 'POST prd', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// GET /api/delivery-planner/prd/:id
	// Fetch a single PRD with its epics and tasks.
	// ---------------------------------------------------------------------------
	server.get(
		`/${token}/api/delivery-planner/prd/:id`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.max,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting GET prd/:id', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const { id } = request.params as { id: string };

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');
				const item = await workGraph.getItem(id);
				if (!item) {
					return reply.code(404).send({
						success: false,
						error: `PRD not found: ${id}`,
						timestamp: Date.now(),
					});
				}
				return { success: true, data: item, timestamp: Date.now() };
			} catch (err) {
				return handleRouteError(reply, 'GET prd/:id', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/delivery-planner/prd/:id/decompose
	// Trigger PRD-to-epic decomposition.
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/delivery-planner/prd/:id/decompose`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting POST prd/:id/decompose', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const { id } = request.params as { id: string };
			const body = (request.body as Partial<DeliveryPlannerDecomposePrdRequest>) ?? {};
			const input: DeliveryPlannerDecomposePrdRequest = { prdId: id, ...body };

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');
				const data = await service.convertPrdToEpic({
					prdId: input.prdId,
					title: input.title,
					description: input.description,
					actor: input.actor,
				});
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				return handleRouteError(reply, 'POST prd/:id/decompose', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/delivery-planner/epic/:id/decompose
	// Trigger epic-to-tasks decomposition.
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/delivery-planner/epic/:id/decompose`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting POST epic/:id/decompose', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const { id } = request.params as { id: string };
			const body = (request.body as Partial<DeliveryPlannerDecomposeEpicRequest>) ?? {};
			const input: DeliveryPlannerDecomposeEpicRequest = { epicId: id, ...body };

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');
				const data = await service.decomposeEpicToTasks(input);
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				return handleRouteError(reply, 'POST epic/:id/decompose', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/delivery-planner/sync-github
	// Trigger GitHub issue sync for a work item.  Body: { workItemId }.
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/delivery-planner/sync-github`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting POST sync-github', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const { workItemId } = (request.body as { workItemId?: string }) ?? {};
			if (!workItemId) {
				return reply.code(400).send({
					success: false,
					error: 'Request body must include workItemId',
					timestamp: Date.now(),
				});
			}

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');
				const data = await service.syncGithubIssue(workItemId);
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				return handleRouteError(reply, 'POST sync-github', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/delivery-planner/sync-mirror
	// Trigger external mirror (markdown) sync for a work item.  Body: { workItemId }.
	// Returns 409 Conflict with hash info if the on-disk file was externally modified.
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/delivery-planner/sync-mirror`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting POST sync-mirror', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const { workItemId } = (request.body as { workItemId?: string }) ?? {};
			if (!workItemId) {
				return reply.code(400).send({
					success: false,
					error: 'Request body must include workItemId',
					timestamp: Date.now(),
				});
			}

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');
				const data = await service.syncExternalMirror(workItemId);
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				return handleRouteError(reply, 'POST sync-mirror', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/delivery-planner/sync
	// Trigger combined sync (github + mirror) for a work item.
	// Body: DeliveryPlannerSyncRequest — must include workItemId; optional target.
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/delivery-planner/sync`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting POST sync', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const input = request.body as DeliveryPlannerSyncRequest | undefined;
			if (!input || !input.workItemId) {
				return reply.code(400).send({
					success: false,
					error: 'Request body must include workItemId',
					timestamp: Date.now(),
				});
			}

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');

				const target = input.target ?? 'all';
				let item =
					target === 'github'
						? await service.syncGithubIssue(input.workItemId)
						: await service.syncExternalMirror(input.workItemId);
				if (target === 'all') {
					item = await service.syncGithubIssue(item.id);
					item = await service.syncExternalMirror(item.id);
				}
				return { success: true, data: item, timestamp: Date.now() };
			} catch (err) {
				return handleRouteError(reply, 'POST sync', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/delivery-planner/bug-follow-up
	// Create a bug follow-up work item.  Body: DeliveryPlannerBugFollowUpRequest.
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/delivery-planner/bug-follow-up`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting POST bug-follow-up', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const input = request.body as DeliveryPlannerBugFollowUpRequest | undefined;
			if (!input) {
				return reply.code(400).send({
					success: false,
					error: 'Request body is required',
					timestamp: Date.now(),
				});
			}

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');
				const data = await service.createBugFollowUp(input);
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				return handleRouteError(reply, 'POST bug-follow-up', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/delivery-planner/progress-comment
	// Add a progress comment to a work item.  Body: DeliveryPlannerProgressCommentRequest.
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/delivery-planner/progress-comment`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting POST progress-comment', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const input = request.body as DeliveryPlannerProgressCommentRequest | undefined;
			if (!input || !input.workItemId || !input.body) {
				return reply.code(400).send({
					success: false,
					error: 'Request body must include workItemId and body',
					timestamp: Date.now(),
				});
			}

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');
				const data = await service.addProgressComment(input.workItemId, input.body, input.actor);
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				return handleRouteError(reply, 'POST progress-comment', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// GET /api/delivery-planner/progress
	// List all in-flight progress snapshots.
	// ---------------------------------------------------------------------------
	server.get(
		`/${token}/api/delivery-planner/progress`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.max,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (_request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting GET progress', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');
				const data = service.listProgress();
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				return handleRouteError(reply, 'GET progress', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// GET /api/delivery-planner/progress/:id
	// Get a single progress snapshot by work-item ID.
	// ---------------------------------------------------------------------------
	server.get(
		`/${token}/api/delivery-planner/progress/:id`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.max,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting GET progress/:id', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const { id } = request.params as { id: string };

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');
				const snapshot = service.getProgress(id);
				if (!snapshot) {
					return reply.code(404).send({
						success: false,
						error: `Progress snapshot not found: ${id}`,
						timestamp: Date.now(),
					});
				}
				return { success: true, data: snapshot, timestamp: Date.now() };
			} catch (err) {
				return handleRouteError(reply, 'GET progress/:id', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/delivery-planner/resolve-paths
	// Resolve project/git paths relative to the running server's cwd.
	// Body: DeliveryPlannerPathResolutionRequest (all fields optional).
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/delivery-planner/resolve-paths`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting POST resolve-paths', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const input = (request.body as DeliveryPlannerPathResolutionRequest | undefined) ?? {};

			try {
				const projectPath = path.resolve(input.projectPath ?? process.cwd());
				const data = {
					projectPath,
					gitPath: path.resolve(input.gitPath ?? projectPath),
				};
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				return handleRouteError(reply, 'POST resolve-paths', err);
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/delivery-planner/promote-doc-gap
	// Promote a documentation gap into a deliverable work item.
	// Body: DeliveryPlannerPromoteDocGapRequest.
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/delivery-planner/promote-doc-gap`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');
			if (gateError) {
				logger.debug('deliveryPlanner flag off — rejecting POST promote-doc-gap', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			const input = request.body as DeliveryPlannerPromoteDocGapRequest | undefined;
			if (!input) {
				return reply.code(400).send({
					success: false,
					error: 'Request body is required',
					timestamp: Date.now(),
				});
			}

			try {
				const service = deps.getService();
				if (!service) throw new Error('Delivery Planner service is not running');
				const data = await service.promoteDocGap(input);
				return { success: true, data, timestamp: Date.now() };
			} catch (err) {
				return handleRouteError(reply, 'POST promote-doc-gap', err);
			}
		}
	);

	logger.debug('Delivery Planner routes registered', LOG_CONTEXT);
}
