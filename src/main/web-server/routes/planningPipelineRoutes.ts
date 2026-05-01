/**
 * Planning Pipeline Web Routes
 *
 * Exposes the Planning Pipeline dashboard over HTTP so the mobile/web client
 * can reach the same data surface available via Electron IPC.
 *
 * All routes are gated by the `planningPipeline` encore feature flag.  When the
 * flag is off every endpoint returns HTTP 403 with a structured error body that
 * mirrors the IPC `FeatureDisabledError` shape:
 *
 *   { success: false, code: "FEATURE_DISABLED", feature: "planningPipeline" }
 *
 * Route map:
 *   GET  /$TOKEN/api/planning-pipeline/dashboard   → pipeline:getDashboard
 *   POST /$TOKEN/api/planning-pipeline/trigger      → 501 Not Implemented
 *                                                     (manual trigger registry is a future issue)
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import { getWorkGraphItemStore } from '../../work-graph';
import { detectCurrentStage } from '../../../shared/planning-pipeline-guards';
import {
	PIPELINE_STAGES,
	PIPELINE_FAILURE_STAGES,
	type AnyPipelineStage,
} from '../../../shared/planning-pipeline-types';
import type { WorkItem } from '../../../shared/work-graph-types';
import type { SettingsStoreInterface } from '../../stores/types';
import type { RateLimitConfig } from '../types';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = 'WebServer:PlanningPipeline';

/** Ordered list of all pipeline stage keys (normal + failure stages). */
const ALL_PIPELINE_STAGES: readonly AnyPipelineStage[] = [
	...PIPELINE_STAGES,
	...PIPELINE_FAILURE_STAGES,
];

export interface PlanningPipelineRouteDependencies {
	settingsStore: SettingsStoreInterface;
}

/**
 * Register Planning Pipeline HTTP routes on the Fastify server.
 *
 * @param server          - Fastify instance (already has middleware registered)
 * @param token           - Per-startup security token used as the URL prefix
 * @param rateLimitConfig - Shared rate-limit settings from WebServer
 * @param deps            - Settings dependencies
 */
export function registerPlanningPipelineRoutes(
	server: FastifyInstance,
	token: string,
	rateLimitConfig: RateLimitConfig,
	deps: PlanningPipelineRouteDependencies
): void {
	const workGraph = getWorkGraphItemStore();

	/** Return 403 with a feature-disabled body when the encore flag is off. */
	const replyFeatureDisabled = (reply: FastifyReply) => {
		return reply.code(403).send({
			success: false,
			code: 'FEATURE_DISABLED',
			feature: 'planningPipeline',
			timestamp: Date.now(),
		});
	};

	// ---------------------------------------------------------------------------
	// GET /api/planning-pipeline/dashboard
	// Returns a full pipeline dashboard snapshot: items grouped by stage, plus an
	// `unstaged` bucket for items that carry no pipeline label.
	// Mirrors the `pipeline:getDashboard` IPC channel.
	// ---------------------------------------------------------------------------
	server.get(
		`/${token}/api/planning-pipeline/dashboard`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.max,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (_request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'planningPipeline');
			if (gateError) {
				logger.debug('planningPipeline flag off — rejecting GET dashboard', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			try {
				const { items } = await workGraph.listItems({});

				// Seed empty buckets for every stage so callers don't need to guard
				// against missing keys (matches pipeline:getDashboard IPC behaviour).
				const stages = Object.fromEntries(
					ALL_PIPELINE_STAGES.map((s) => [s, [] as WorkItem[]])
				) as Record<AnyPipelineStage, WorkItem[]>;

				const unstaged: WorkItem[] = [];

				for (const item of items) {
					const stage = detectCurrentStage(item.tags);
					if (stage === null) {
						unstaged.push(item);
					} else {
						stages[stage].push(item);
					}
				}

				return {
					success: true,
					data: { stages, unstaged, total: items.length },
					timestamp: Date.now(),
				};
			} catch (err) {
				logger.error('GET dashboard error', LOG_CONTEXT, { error: String(err) });
				return reply.code(500).send({
					success: false,
					error: String(err),
					timestamp: Date.now(),
				});
			}
		}
	);

	// ---------------------------------------------------------------------------
	// POST /api/planning-pipeline/trigger
	// Manual stage trigger — not yet implemented.
	// A trigger-registry IPC surface is tracked in a future issue; this stub
	// returns 501 so clients can detect the gap without a silent 404.
	// ---------------------------------------------------------------------------
	server.post(
		`/${token}/api/planning-pipeline/trigger`,
		{
			config: {
				rateLimit: {
					max: rateLimitConfig.maxPost,
					timeWindow: rateLimitConfig.timeWindow,
				},
			},
		},
		async (_request, reply) => {
			const gateError = requireEncoreFeature(deps.settingsStore, 'planningPipeline');
			if (gateError) {
				logger.debug('planningPipeline flag off — rejecting POST trigger', LOG_CONTEXT);
				return replyFeatureDisabled(reply);
			}

			// TODO: wire to trigger-registry IPC once the manual-trigger surface
			// is exposed in src/main/ipc/handlers/planning-pipeline.ts.
			return reply.code(501).send({
				success: false,
				code: 'NOT_IMPLEMENTED',
				message:
					'Manual pipeline triggers are not yet supported via the HTTP surface. ' +
					'Track progress in the trigger-registry follow-up issue.',
				timestamp: Date.now(),
			});
		}
	);

	logger.debug('Planning Pipeline routes registered', LOG_CONTEXT);
}
