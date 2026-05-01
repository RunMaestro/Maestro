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
	writeExternalMirror,
	type ExternalMirrorResult,
} from '../../delivery-planner/external-mirror';
import { InMemoryDeliveryPlannerProgressStore } from '../../delivery-planner/progress';
import { createIpcDataHandler } from '../../utils/ipcHandler';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { getWorkGraphItemStore, publishWorkGraphEvent } from '../../work-graph';
import type { SettingsStoreInterface } from '../../stores/types';

const LOG_CONTEXT = '[DeliveryPlanner]';

export interface DeliveryPlannerHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
	settingsStore: SettingsStoreInterface;
}

export function registerDeliveryPlannerHandlers(
	deps: DeliveryPlannerHandlerDependencies
): DeliveryPlannerService {
	const workGraph = getWorkGraphItemStore();
	const service = createDeliveryPlannerService(deps, workGraph);

	/** Check the deliveryPlanner encore feature flag. Returns structured error or null. */
	const gate = () => requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');

	ipcMain.handle(
		'deliveryPlanner:createPrd',
		async (_event, input: DeliveryPlannerCreatePrdRequest) => {
			const gateError = gate();
			if (gateError) return gateError;
			return createIpcDataHandler(
				{ context: LOG_CONTEXT, operation: 'createPrd' },
				(i: DeliveryPlannerCreatePrdRequest) => service.createPrd(i)
			)(_event, input);
		}
	);

	ipcMain.handle(
		'deliveryPlanner:decomposePrd',
		async (_event, input: DeliveryPlannerDecomposePrdRequest) => {
			const gateError = gate();
			if (gateError) return gateError;
			return createIpcDataHandler(
				{ context: LOG_CONTEXT, operation: 'decomposePrd' },
				(i: DeliveryPlannerDecomposePrdRequest) =>
					service.convertPrdToEpic({
						prdId: i.prdId,
						title: i.title,
						description: i.description,
						actor: i.actor,
					})
			)(_event, input);
		}
	);

	ipcMain.handle(
		'deliveryPlanner:decomposeEpic',
		async (_event, input: DeliveryPlannerDecomposeEpicRequest) => {
			const gateError = gate();
			if (gateError) return gateError;
			return createIpcDataHandler(
				{ context: LOG_CONTEXT, operation: 'decomposeEpic' },
				(i: DeliveryPlannerDecomposeEpicRequest) => service.decomposeEpicToTasks(i)
			)(_event, input);
		}
	);

	ipcMain.handle(
		'deliveryPlanner:dashboard',
		async (_event, filters: { projectPath?: string; gitPath?: string } = {}) => {
			const gateError = gate();
			if (gateError) return gateError;
			return createIpcDataHandler(
				{ context: LOG_CONTEXT, operation: 'dashboard', logSuccess: false },
				async (f: { projectPath?: string; gitPath?: string } = {}) => {
					if (f.projectPath) {
						await indexPlanningArtifacts({
							workGraph,
							projectPath: f.projectPath,
							gitPath: f.gitPath,
							actor: { type: 'system', id: 'delivery-planner', name: 'Delivery Planner' },
							publish: (operation, payload) => {
								publishWorkGraphEvent(deps.getMainWindow, operation, payload);
							},
						});
					}
					const dashboard = await service.listDashboard(f);
					return {
						...dashboard,
						filters: f,
						githubSync: undefined,
						readyTag: WORK_GRAPH_READY_TAG,
					} satisfies DeliveryPlannerDashboardSnapshot & typeof dashboard;
				}
			)(_event, filters);
		}
	);

	ipcMain.handle('deliveryPlanner:sync', async (_event, input: DeliveryPlannerSyncRequest) => {
		const gateError = gate();
		if (gateError) return gateError;
		return createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'sync' },
			async (i: DeliveryPlannerSyncRequest) => {
				const target = i.target ?? 'all';
				let item =
					target === 'github'
						? await service.syncGithubIssue(i.workItemId)
						: await service.syncExternalMirror(i.workItemId);
				if (target === 'all') {
					item = await service.syncGithubIssue(item.id);
					item = await service.syncExternalMirror(item.id);
				}
				return item;
			}
		)(_event, input);
	});

	ipcMain.handle(
		'deliveryPlanner:createBugFollowUp',
		async (_event, input: DeliveryPlannerBugFollowUpRequest) => {
			const gateError = gate();
			if (gateError) return gateError;
			return createIpcDataHandler(
				{ context: LOG_CONTEXT, operation: 'createBugFollowUp' },
				(i: DeliveryPlannerBugFollowUpRequest) => service.createBugFollowUp(i)
			)(_event, input);
		}
	);

	ipcMain.handle(
		'deliveryPlanner:addProgressComment',
		async (_event, input: DeliveryPlannerProgressCommentRequest) => {
			const gateError = gate();
			if (gateError) return gateError;
			return createIpcDataHandler(
				{ context: LOG_CONTEXT, operation: 'addProgressComment' },
				(i: DeliveryPlannerProgressCommentRequest) =>
					service.addProgressComment(i.workItemId, i.body, i.actor)
			)(_event, input);
		}
	);

	ipcMain.handle(
		'deliveryPlanner:resolvePaths',
		async (_event, input: DeliveryPlannerPathResolutionRequest = {}) => {
			const gateError = gate();
			if (gateError) return gateError;
			return createIpcDataHandler(
				{ context: LOG_CONTEXT, operation: 'resolvePaths', logSuccess: false },
				async (
					i: DeliveryPlannerPathResolutionRequest = {}
				): Promise<DeliveryPlannerPathResolutionResult> => {
					const projectPath = path.resolve(i.projectPath ?? process.cwd());
					return {
						projectPath,
						gitPath: path.resolve(i.gitPath ?? projectPath),
					};
				}
			)(_event, input);
		}
	);

	ipcMain.handle('deliveryPlanner:getProgress', async (_event, id: string) => {
		const gateError = gate();
		if (gateError) return gateError;
		return createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'getProgress', logSuccess: false },
			(i: string) => Promise.resolve(service.getProgress(i))
		)(_event, id);
	});

	ipcMain.handle('deliveryPlanner:listProgress', async (_event) => {
		const gateError = gate();
		if (gateError) return gateError;
		return createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'listProgress', logSuccess: false },
			() => Promise.resolve(service.listProgress())
		)(_event);
	});

	ipcMain.handle(
		'deliveryPlanner:promoteDocGap',
		async (_event, input: DeliveryPlannerPromoteDocGapRequest) => {
			const gateError = gate();
			if (gateError) return gateError;
			return createIpcDataHandler(
				{ context: LOG_CONTEXT, operation: 'promoteDocGap' },
				(i: DeliveryPlannerPromoteDocGapRequest) => service.promoteDocGap(i)
			)(_event, input);
		}
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
		externalMirror: {
			syncPrd: (item) => syncExternalMirrorItem(item, 'prd'),
			syncEpic: (item) => syncExternalMirrorItem(item, 'epic'),
			syncTask: (item) => syncExternalMirrorItem(item, 'task'),
		},
		events: {
			publish: (operation, payload) => {
				publishWorkGraphEvent(deps.getMainWindow, operation, payload);
			},
		},
	});
}

async function syncExternalMirrorItem(
	item: WorkItem,
	kind: 'prd' | 'epic' | 'task'
): Promise<{ mirrorHash?: string }> {
	const result = await writeExternalMirror({
		item,
		kind,
		projectPath: item.projectPath,
		slug: item.metadata?.mirrorSlug?.toString(),
	});
	throwIfMirrorConflict(result);
	return { mirrorHash: result.mirrorHash };
}

function throwIfMirrorConflict(result: ExternalMirrorResult): void {
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
