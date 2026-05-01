import type { WorkItem, WorkItemStatus } from '../../shared/work-graph-types';
import type { DeliveryPlannerWorkGraphStore } from './planner-service';

export interface DeliveryPlannerDashboardFilters {
	projectPath?: string;
	gitPath?: string;
}

export interface DeliveryPlannerStatusCount {
	status: WorkItemStatus;
	count: number;
}

export interface DeliveryPlannerDashboard {
	items: WorkItem[];
	statusCounts: DeliveryPlannerStatusCount[];
	readyItems: WorkItem[];
	blockedItems: WorkItem[];
	overdueItems: WorkItem[];
	updatedAt: string;
}

const DASHBOARD_STATUSES: WorkItemStatus[] = [
	'discovered',
	'planned',
	'ready',
	'claimed',
	'in_progress',
	'blocked',
	'review',
	'done',
	'canceled',
];

export async function listDeliveryPlannerDashboard(
	workGraph: DeliveryPlannerWorkGraphStore,
	filters: DeliveryPlannerDashboardFilters = {}
): Promise<DeliveryPlannerDashboard> {
	const result = await workGraph.listItems({
		...filters,
		source: 'delivery-planner',
	});
	const today = new Date().toISOString();
	const items = result.items;

	return {
		items,
		statusCounts: DASHBOARD_STATUSES.map((status) => ({
			status,
			count: items.filter((item) => item.status === status).length,
		})),
		readyItems: items.filter((item) => item.status === 'ready'),
		blockedItems: items.filter((item) => item.status === 'blocked'),
		overdueItems: items.filter(
			(item) =>
				Boolean(item.dueAt) && item.dueAt! < today && !['done', 'canceled'].includes(item.status)
		),
		updatedAt: today,
	};
}
