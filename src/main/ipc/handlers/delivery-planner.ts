import path from 'path';
import { BrowserWindow, ipcMain } from 'electron';
import type {
	DeliveryPlannerBugFollowUpRequest,
	DeliveryPlannerCreatePrdRequest,
	DeliveryPlannerDashboardSnapshot,
	DeliveryPlannerDecomposeEpicRequest,
	DeliveryPlannerDecomposePrdRequest,
	DeliveryPlannerPathResolutionRequest,
	DeliveryPlannerPathResolutionResult,
	DeliveryPlannerProgressCommentRequest,
	DeliveryPlannerPromoteDocGapRequest,
	DeliveryPlannerSyncRequest,
} from '../../../shared/delivery-planner-types';
import { WORK_GRAPH_READY_TAG } from '../../../shared/work-graph-types';
import type { WorkItem } from '../../../shared/work-graph-types';
import {
	DeliveryPlannerDecomposer,
	DeliveryPlannerGithubSync,
	DeliveryPlannerService,
	StructuredDeliveryPlannerDecompositionGateway,
	indexPlanningArtifacts,
	type DeliveryPlannerWorkGraphStore,
} from '../../delivery-planner';
import {
	PlannerMirrorConflictError,
	writeCcpmMirror,
	type CcpmMirrorResult,
} from '../../delivery-planner/ccpm-mirror';
import { InMemoryDeliveryPlannerProgressStore } from '../../delivery-planner/progress';
import { createIpcDataHandler } from '../../utils/ipcHandler';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { getWorkGraphItemStore, publishWorkGraphEvent } from '../../work-graph';

const LOG_CONTEXT = '[DeliveryPlanner]';

export interface DeliveryPlannerHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
}

export function registerDeliveryPlannerHandlers(
	deps: DeliveryPlannerHandlerDependencies
): DeliveryPlannerService {
	const workGraph = getWorkGraphItemStore();
	const service = createDeliveryPlannerService(deps, workGraph);

	ipcMain.handle(
		'deliveryPlanner:createPrd',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'createPrd' },
			(input: DeliveryPlannerCreatePrdRequest) => service.createPrd(input)
		)
	);

	ipcMain.handle(
		'deliveryPlanner:decomposePrd',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'decomposePrd' },
			(input: DeliveryPlannerDecomposePrdRequest) =>
				service.convertPrdToEpic({
					prdId: input.prdId,
					title: input.title,
					description: input.description,
					actor: input.actor,
				})
		)
	);

	ipcMain.handle(
		'deliveryPlanner:decomposeEpic',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'decomposeEpic' },
			(input: DeliveryPlannerDecomposeEpicRequest) => service.decomposeEpicToTasks(input)
		)
	);

	ipcMain.handle(
		'deliveryPlanner:dashboard',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'dashboard', logSuccess: false },
			async (filters: { projectPath?: string; gitPath?: string } = {}) => {
				if (filters.projectPath) {
					await indexPlanningArtifacts({
						workGraph,
						projectPath: filters.projectPath,
						gitPath: filters.gitPath,
						actor: { type: 'system', id: 'delivery-planner', name: 'Delivery Planner' },
						publish: (operation, payload) => {
							publishWorkGraphEvent(deps.getMainWindow, operation, payload);
						},
					});
				}
				const dashboard = await service.listDashboard(filters);
				return {
					...dashboard,
					filters,
					githubSync: undefined,
					readyTag: WORK_GRAPH_READY_TAG,
				} satisfies DeliveryPlannerDashboardSnapshot & typeof dashboard;
			}
		)
	);

	ipcMain.handle(
		'deliveryPlanner:sync',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'sync' },
			async (input: DeliveryPlannerSyncRequest) => {
				const target = input.target ?? 'all';
				let item =
					target === 'github'
						? await service.syncGithubIssue(input.workItemId)
						: await service.syncCcpmMirror(input.workItemId);
				if (target === 'all') {
					item = await service.syncGithubIssue(item.id);
					item = await service.syncCcpmMirror(item.id);
				}
				return item;
			}
		)
	);

	ipcMain.handle(
		'deliveryPlanner:createBugFollowUp',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'createBugFollowUp' },
			(input: DeliveryPlannerBugFollowUpRequest) => service.createBugFollowUp(input)
		)
	);

	ipcMain.handle(
		'deliveryPlanner:addProgressComment',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'addProgressComment' },
			(input: DeliveryPlannerProgressCommentRequest) =>
				service.addProgressComment(input.workItemId, input.body, input.actor)
		)
	);

	ipcMain.handle(
		'deliveryPlanner:resolvePaths',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'resolvePaths', logSuccess: false },
			async (
				input: DeliveryPlannerPathResolutionRequest = {}
			): Promise<DeliveryPlannerPathResolutionResult> => {
				const projectPath = path.resolve(input.projectPath ?? process.cwd());
				return {
					projectPath,
					gitPath: path.resolve(input.gitPath ?? projectPath),
				};
			}
		)
	);

	ipcMain.handle(
		'deliveryPlanner:getProgress',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'getProgress', logSuccess: false },
			(id: string) => Promise.resolve(service.getProgress(id))
		)
	);

	ipcMain.handle(
		'deliveryPlanner:listProgress',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'listProgress', logSuccess: false },
			() => Promise.resolve(service.listProgress())
		)
	);

	ipcMain.handle(
		'deliveryPlanner:promoteDocGap',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'promoteDocGap' },
			(input: DeliveryPlannerPromoteDocGapRequest) => service.promoteDocGap(input)
		)
	);
	return service;
}

function createDeliveryPlannerService(
	deps: DeliveryPlannerHandlerDependencies,
	workGraph: DeliveryPlannerWorkGraphStore = getWorkGraphItemStore()
): DeliveryPlannerService {
	const progress = new InMemoryDeliveryPlannerProgressStore((operation) => {
		const mainWindow = deps.getMainWindow();
		if (isWebContentsAvailable(mainWindow)) {
			mainWindow.webContents.send('deliveryPlanner:progress', operation);
		}
	});

	return new DeliveryPlannerService({
		workGraph,
		decomposer: new DeliveryPlannerDecomposer(new StructuredDeliveryPlannerDecompositionGateway()),
		progress,
		githubSync: new DeliveryPlannerGithubSync(),
		ccpmMirror: {
			syncPrd: (item) => syncCcpmItem(item, 'prd'),
			syncEpic: (item) => syncCcpmItem(item, 'epic'),
			syncTask: (item) => syncCcpmItem(item, 'task'),
		},
		events: {
			publish: (operation, payload) => {
				publishWorkGraphEvent(deps.getMainWindow, operation, payload);
			},
		},
	});
}

async function syncCcpmItem(
	item: WorkItem,
	kind: 'prd' | 'epic' | 'task'
): Promise<{ mirrorHash?: string }> {
	const result = await writeCcpmMirror({
		item,
		kind,
		projectPath: item.projectPath,
		slug: item.metadata?.ccpmSlug?.toString(),
	});
	throwIfMirrorConflict(result);
	return { mirrorHash: result.mirrorHash };
}

function throwIfMirrorConflict(result: CcpmMirrorResult): void {
	if (result.status !== 'conflict' || !result.error) {
		return;
	}

	throw new PlannerMirrorConflictError(
		result.error.message,
		result.error.filePath,
		result.error.expectedMirrorHash,
		result.error.actualMirrorHash
	);
}
