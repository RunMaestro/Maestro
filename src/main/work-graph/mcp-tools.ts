// Work Graph MCP tool builders.
//
// These factory functions translate Work Graph storage operations into MCP
// tool definitions that the internal registry (see ../mcp) can expose to
// agents and orchestrators. They intentionally do not register themselves;
// callers control registration ordering.

import type { McpTool } from '../mcp';
import type {
	AgentReadyWorkFilter,
	WorkGraphActor,
	WorkGraphListResult,
	WorkItem,
	WorkItemClaim,
	WorkItemClaimInput,
	WorkItemCreateInput,
	WorkItemSearchFilters,
	WorkItemUpdateInput,
} from '../../shared/work-graph-types';
import { WORK_GRAPH_READY_TAG } from '../../shared/work-graph-types';
import type { WorkGraphStorage } from './storage';

export interface WorkGraphMcpDependencies {
	store: WorkGraphStorage;
}

interface SearchInput extends Partial<WorkItemSearchFilters> {
	query: string;
}

interface GetInput {
	id: string;
}

interface ReleaseInput {
	workItemId: string;
	note?: string;
	actor?: WorkGraphActor;
}

type AgentReadyInput = AgentReadyWorkFilter;

/**
 * Build all Work Graph MCP tools bound to a storage instance.
 *
 * Tool names are intentionally PascalCase (e.g. `SearchWorkGraph`, not
 * `workspace.search`) and never overlap with the public docs MCP server's
 * `SearchMaestro` tool — these are an internal Work Graph surface.
 */
export function buildWorkGraphMcpTools(deps: WorkGraphMcpDependencies): McpTool[] {
	const { store } = deps;

	const searchTool: McpTool<SearchInput, WorkGraphListResult> = {
		name: 'SearchWorkGraph',
		description:
			'Full-text search Work Graph items. Supports the same filters as ListWorkItems (tags, statuses, project path, etc.).',
		inputSchema: {
			type: 'object',
			required: ['query'],
			properties: {
				query: { type: 'string', description: 'FTS5 query string.' },
				projectPath: { type: 'string' },
				gitPath: { type: 'string' },
				tags: { type: 'array', items: { type: 'string' } },
				anyTags: { type: 'array', items: { type: 'string' } },
				excludeTags: { type: 'array', items: { type: 'string' } },
				statuses: { type: 'array', items: { type: 'string' } },
				types: { type: 'array', items: { type: 'string' } },
				limit: { type: 'number' },
				cursor: { type: 'string' },
			},
			additionalProperties: false,
		},
		handler: (input) => store.searchItems(input as WorkItemSearchFilters),
	};

	const getTool: McpTool<GetInput, WorkItem | undefined> = {
		name: 'GetWorkItem',
		description: 'Fetch a single Work Graph item by id, including tags and active claim.',
		inputSchema: {
			type: 'object',
			required: ['id'],
			properties: {
				id: { type: 'string' },
			},
			additionalProperties: false,
		},
		handler: (input) => store.getItem(input.id),
	};

	const createTool: McpTool<WorkItemCreateInput, WorkItem> = {
		name: 'CreateWorkItem',
		description:
			'Create a Work Graph item. Caller is responsible for ensuring projectPath and gitPath match the target workspace.',
		inputSchema: {
			type: 'object',
			required: ['type', 'title', 'projectPath', 'gitPath', 'source'],
			properties: {
				type: { type: 'string' },
				title: { type: 'string' },
				description: { type: 'string' },
				status: { type: 'string' },
				projectPath: { type: 'string' },
				gitPath: { type: 'string' },
				source: { type: 'string' },
				readonly: { type: 'boolean' },
				tags: { type: 'array', items: { type: 'string' } },
				priority: { type: 'number' },
				dueAt: { type: 'string' },
				parentWorkItemId: { type: 'string' },
				owner: { type: 'object' },
				github: { type: 'object' },
				capabilities: { type: 'array', items: { type: 'string' } },
				dependencies: { type: 'array' },
				metadata: { type: 'object' },
				mirrorHash: { type: 'string' },
			},
			additionalProperties: true,
		},
		handler: (input) => store.createItem(input),
	};

	const updateTool: McpTool<WorkItemUpdateInput, WorkItem> = {
		name: 'UpdateWorkItem',
		description:
			'Update a Work Graph item. Pass the optional `expectedUpdatedAt` to enforce optimistic concurrency.',
		inputSchema: {
			type: 'object',
			required: ['id', 'patch'],
			properties: {
				id: { type: 'string' },
				patch: { type: 'object' },
				expectedUpdatedAt: { type: 'string' },
				actor: { type: 'object' },
			},
			additionalProperties: false,
		},
		handler: (input) => store.updateItem(input),
	};

	const claimTool: McpTool<WorkItemClaimInput, WorkItemClaim> = {
		name: 'ClaimWorkItem',
		description:
			'Claim an unblocked Work Graph item for an owner. Fails if another active claim exists.',
		inputSchema: {
			type: 'object',
			required: ['workItemId', 'owner'],
			properties: {
				workItemId: { type: 'string' },
				owner: { type: 'object' },
				expiresAt: { type: 'string' },
				note: { type: 'string' },
			},
			additionalProperties: true,
		},
		handler: (input) => store.claimItem(input),
	};

	const releaseTool: McpTool<ReleaseInput, WorkItemClaim | undefined> = {
		name: 'ReleaseWorkItem',
		description:
			'Release the active claim on a Work Graph item, if any. Returns the released claim row, or undefined when nothing was claimed.',
		inputSchema: {
			type: 'object',
			required: ['workItemId'],
			properties: {
				workItemId: { type: 'string' },
				note: { type: 'string' },
				actor: { type: 'object' },
			},
			additionalProperties: false,
		},
		handler: (input) =>
			store.releaseClaim(input.workItemId, { note: input.note, actor: input.actor }),
	};

	const unblockedTool: McpTool<AgentReadyInput, WorkGraphListResult> = {
		name: 'ListUnblockedWorkItems',
		description:
			'List Work Graph items whose dependencies are all resolved. Does not require the agent-ready tag.',
		inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				statuses: { type: 'array', items: { type: 'string' } },
				excludeClaimed: { type: 'boolean' },
				capabilityTags: { type: 'array', items: { type: 'string' } },
				agentId: { type: 'string' },
				limit: { type: 'number' },
				cursor: { type: 'string' },
			},
			additionalProperties: true,
		},
		handler: (input) => {
			const filters: AgentReadyWorkFilter = {
				...input,
				requireUnblocked: true,
				capabilityRouting: {
					...input.capabilityRouting,
					requireReadyTag: false,
					agentCapabilities: input.capabilityTags ?? input.capabilityRouting?.agentCapabilities,
				},
			};
			return store.listItems({
				...filters,
				statuses: filters.statuses ?? ['ready', 'planned', 'discovered'],
			});
		},
	};

	const agentReadyTool: McpTool<AgentReadyInput, WorkGraphListResult> = {
		name: 'ListAgentReadyWorkItems',
		description: `List unblocked Work Graph items tagged \`${WORK_GRAPH_READY_TAG}\` and eligible for agent auto-pickup.`,
		inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				statuses: { type: 'array', items: { type: 'string' } },
				excludeClaimed: { type: 'boolean' },
				capabilityTags: { type: 'array', items: { type: 'string' } },
				agentId: { type: 'string' },
				limit: { type: 'number' },
				cursor: { type: 'string' },
			},
			additionalProperties: true,
		},
		handler: (input) => store.getUnblockedWorkItems(input),
	};

	const tagsTool: McpTool<Record<string, never>, unknown> = {
		name: 'ListWorkGraphTags',
		description: 'List all known Work Graph tag definitions, including capability routing tags.',
		inputSchema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		handler: () => store.listTags(),
	};

	return [
		searchTool as McpTool,
		getTool as McpTool,
		createTool as McpTool,
		updateTool as McpTool,
		claimTool as McpTool,
		releaseTool as McpTool,
		unblockedTool as McpTool,
		agentReadyTool as McpTool,
		tagsTool as McpTool,
	];
}
