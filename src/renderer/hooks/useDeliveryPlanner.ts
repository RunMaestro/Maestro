import { useCallback, useEffect, useState } from 'react';
import type {
	DeliveryPlannerProgressEvent,
	DeliveryPlannerProgressSnapshot,
} from '../../shared/delivery-planner-types';
import type { WorkGraphListResult, WorkItemFilters } from '../../shared/work-graph-types';
import { deliveryPlannerService } from '../services/deliveryPlanner';
import { workGraphService } from '../services/workGraph';

export function useDeliveryPlanner(filters?: WorkItemFilters) {
	const [items, setItems] = useState<WorkGraphListResult>({ items: [] });
	const [progress, setProgress] = useState<Record<string, DeliveryPlannerProgressSnapshot>>({});
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setItems(await workGraphService.listItems(filters));
		} catch (refreshError) {
			setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
		} finally {
			setLoading(false);
		}
	}, [filters]);

	useEffect(() => {
		void refresh();
		return workGraphService.onChanged(() => {
			void refresh();
		});
	}, [refresh]);

	useEffect(() => {
		void deliveryPlannerService.listProgress().then((operations) => {
			setProgress(Object.fromEntries(operations.map((operation) => [operation.id, operation])));
		});

		return deliveryPlannerService.onProgress((event: DeliveryPlannerProgressEvent) => {
			setProgress((current) => ({
				...current,
				[event.id]: event,
			}));
		});
	}, []);

	return {
		items: items.items,
		total: items.total,
		nextCursor: items.nextCursor,
		progress,
		loading,
		error,
		refresh,
		workGraph: workGraphService,
		deliveryPlanner: deliveryPlannerService,
	};
}
