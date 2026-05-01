import type {
	AgentReadyWorkFilter,
	TagDefinition,
	WorkGraphBroadcastEnvelope,
	WorkGraphImportInput,
	WorkGraphImportSummary,
	WorkGraphListResult,
	WorkItem,
	WorkItemClaim,
	WorkItemClaimCompleteInput,
	WorkItemClaimInput,
	WorkItemClaimReleaseInput,
	WorkItemClaimRenewInput,
	WorkItemCreateInput,
	WorkItemEvent,
	WorkItemFilters,
	WorkItemSearchFilters,
	WorkItemUpdateInput,
} from '../../shared/work-graph-types';

type IpcResponse<T> = { success: true; data: T } | { success: false; error: string };

const unwrap = async <T>(response: Promise<IpcResponse<T>>): Promise<T> => {
	const result = await response;
	if (!result.success) {
		throw new Error(result.error);
	}
	return result.data;
};

export const workGraphService = {
	listItems: (filters?: WorkItemFilters): Promise<WorkGraphListResult> =>
		unwrap(window.maestro.workGraph.listItems(filters)),
	searchItems: (filters: WorkItemSearchFilters): Promise<WorkGraphListResult> =>
		unwrap(window.maestro.workGraph.searchItems(filters)),
	getItem: (id: string): Promise<WorkItem | undefined> =>
		unwrap(window.maestro.workGraph.getItem(id)),
	createItem: (input: WorkItemCreateInput): Promise<WorkItem> =>
		unwrap(window.maestro.workGraph.createItem(input)),
	updateItem: (input: WorkItemUpdateInput): Promise<WorkItem> =>
		unwrap(window.maestro.workGraph.updateItem(input)),
	deleteItem: (id: string): Promise<boolean> => unwrap(window.maestro.workGraph.deleteItem(id)),
	claimItem: (input: WorkItemClaimInput): Promise<WorkItemClaim> =>
		unwrap(window.maestro.workGraph.claimItem(input)),
	renewClaim: (input: WorkItemClaimRenewInput): Promise<WorkItemClaim> =>
		unwrap(window.maestro.workGraph.renewClaim(input)),
	releaseClaim: (input: WorkItemClaimReleaseInput): Promise<WorkItemClaim> =>
		unwrap(window.maestro.workGraph.releaseClaim(input)),
	completeClaim: (input: WorkItemClaimCompleteInput): Promise<WorkItemClaim> =>
		unwrap(window.maestro.workGraph.completeClaim(input)),
	listEvents: (workItemId: string): Promise<WorkItemEvent[]> =>
		unwrap(window.maestro.workGraph.listEvents(workItemId)),
	listTags: (): Promise<TagDefinition[]> => unwrap(window.maestro.workGraph.listTags()),
	upsertTag: (definition: TagDefinition): Promise<TagDefinition> =>
		unwrap(window.maestro.workGraph.upsertTag(definition)),
	importItems: (input: WorkGraphImportInput): Promise<WorkGraphImportSummary> =>
		unwrap(window.maestro.workGraph.importItems(input)),
	getUnblockedAgentReadyWork: (filters?: AgentReadyWorkFilter): Promise<WorkGraphListResult> =>
		unwrap(window.maestro.workGraph.getUnblockedAgentReadyWork(filters)),
	onChanged: (handler: (event: WorkGraphBroadcastEnvelope) => void): (() => void) =>
		window.maestro.workGraph.onChanged(handler),
};
