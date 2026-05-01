import type {
	DeliveryPlannerBugFollowUpRequest,
	DeliveryPlannerCreatePrdRequest,
	DeliveryPlannerDashboardSnapshot,
	DeliveryPlannerDecomposeEpicRequest,
	DeliveryPlannerDecomposePrdRequest,
	DeliveryPlannerPathResolutionRequest,
	DeliveryPlannerPrdFields,
	DeliveryPlannerPrdSaveRequest,
	DeliveryPlannerPrdSaveResult,
	DeliveryPlannerPathResolutionResult,
	DeliveryPlannerProgressComment,
	DeliveryPlannerProgressCommentRequest,
	DeliveryPlannerProgressEvent,
	DeliveryPlannerProgressSnapshot,
	DeliveryPlannerPromoteDocGapRequest,
	DeliveryPlannerPromoteDocGapResult,
	DeliveryPlannerSyncRequest,
} from '../../shared/delivery-planner-types';
import type { WorkItem } from '../../shared/work-graph-types';
import { workGraphService } from './workGraph';

type IpcResponse<T> = { success: true; data: T } | { success: false; error: string };

const unwrap = async <T>(response: Promise<IpcResponse<T>>): Promise<T> => {
	const result = await response;
	if (!result.success) {
		throw new Error(result.error);
	}
	return result.data;
};

export const deliveryPlannerService = {
	createPrd: (input: DeliveryPlannerCreatePrdRequest): Promise<WorkItem> =>
		unwrap(window.maestro.deliveryPlanner.createPrd(input)),
	decomposePrd: (input: DeliveryPlannerDecomposePrdRequest): Promise<WorkItem> =>
		unwrap(window.maestro.deliveryPlanner.decomposePrd(input)),
	decomposeEpic: (input: DeliveryPlannerDecomposeEpicRequest) =>
		unwrap(window.maestro.deliveryPlanner.decomposeEpic(input)),
	dashboard: (filters?: { projectPath?: string; gitPath?: string }) =>
		unwrap(window.maestro.deliveryPlanner.dashboard(filters)),
	list: (filters?: { projectPath?: string; gitPath?: string }) =>
		unwrap(
			window.maestro.deliveryPlanner.dashboard(filters)
		) as Promise<DeliveryPlannerDashboardSnapshot>,
	savePrd: async (
		request: DeliveryPlannerPrdSaveRequest
	): Promise<DeliveryPlannerPrdSaveResult> => {
		const description = renderPrdBody(request.fields);
		const tags = uniqueTags(['delivery-planner', 'prd', ...(request.tags ?? [])]);
		const metadata = {
			kind: 'prd',
			mirrorSlug: request.slug,
			deliveryPlannerConcept: 'prd',
			prdFields: request.fields,
		};
		const actor = { type: 'user' as const, id: 'desktop', name: 'Desktop UI' };
		const prd = request.id
			? await workGraphService.updateItem({
					id: request.id,
					actor,
					patch: {
						title: request.title,
						description,
						tags,
						metadata,
					},
				})
			: await deliveryPlannerService.createPrd({
					title: request.title,
					description,
					projectPath: request.projectPath,
					gitPath: request.gitPath,
					tags: request.tags,
					metadata,
					actor,
				});
		const syncedPrd = await deliveryPlannerService.sync({ workItemId: prd.id });
		return { prd: syncedPrd as DeliveryPlannerPrdSaveResult['prd'] };
	},
	convertPrdToEpic: (prdId: string): Promise<WorkItem> =>
		deliveryPlannerService.decomposePrd({
			prdId,
			actor: { type: 'user', id: 'desktop', name: 'Desktop UI' },
		}),
	sync: (input: DeliveryPlannerSyncRequest): Promise<WorkItem> =>
		unwrap(window.maestro.deliveryPlanner.sync(input)),
	createBugFollowUp: (input: DeliveryPlannerBugFollowUpRequest): Promise<WorkItem> =>
		unwrap(window.maestro.deliveryPlanner.createBugFollowUp(input)),
	addProgressComment: (
		input: DeliveryPlannerProgressCommentRequest
	): Promise<{ item: WorkItem; comment: DeliveryPlannerProgressComment }> =>
		unwrap(window.maestro.deliveryPlanner.addProgressComment(input)),
	resolvePaths: (
		input?: DeliveryPlannerPathResolutionRequest
	): Promise<DeliveryPlannerPathResolutionResult> =>
		unwrap(window.maestro.deliveryPlanner.resolvePaths(input)),
	getProgress: (id: string): Promise<DeliveryPlannerProgressSnapshot | undefined> =>
		unwrap(window.maestro.deliveryPlanner.getProgress(id)),
	listProgress: (): Promise<DeliveryPlannerProgressSnapshot[]> =>
		unwrap(window.maestro.deliveryPlanner.listProgress()),
	promoteDocGap: (
		input: DeliveryPlannerPromoteDocGapRequest
	): Promise<DeliveryPlannerPromoteDocGapResult> =>
		unwrap(window.maestro.deliveryPlanner.promoteDocGap(input)),
	onProgress: (handler: (event: DeliveryPlannerProgressEvent) => void): (() => void) =>
		window.maestro.deliveryPlanner.onProgress(handler),
};

function renderPrdBody(fields: DeliveryPlannerPrdFields): string {
	return [
		['Problem', fields.problem],
		['Users', fields.users],
		['Success Criteria', fields.successCriteria],
		['Scope', fields.scope],
		['Constraints', fields.constraints],
		['Dependencies', fields.dependencies],
		['Out of Scope', fields.outOfScope],
	]
		.map(([heading, value]) => `## ${heading}\n\n${value.trim()}`)
		.join('\n\n');
}

function uniqueTags(tags: string[]): string[] {
	return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}
