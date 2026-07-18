import { useEffect, useState } from 'react';
import type { GroupingContribution } from '../../shared/plugins/contributions';
import type { VirtualGrouping } from '../utils/pluginGroupings';

/** Merges declarative manifest groupings with live, presentation-only snapshots. */
export function usePluginGroupings(groupings: readonly GroupingContribution[]): VirtualGrouping[] {
	const [published, setPublished] = useState<VirtualGrouping[]>([]);

	useEffect(() => {
		const plugins = window.maestro?.plugins;
		if (!plugins) return;
		let cancelled = false;
		const load = async (): Promise<void> => {
			try {
				const snapshots = await plugins.getGroupings();
				if (!cancelled) setPublished([...snapshots]);
			} catch {
				if (!cancelled) setPublished([]);
			}
		};
		void load();
		const unsubscribe = plugins.onGroupingsChanged(() => void load());
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	const snapshotsById = new Map(published.map((grouping) => [grouping.id, grouping]));
	return groupings.map((grouping) => {
		const publishedGrouping = snapshotsById.get(grouping.id);
		return publishedGrouping
			? {
					...grouping,
					groups: publishedGrouping.groups,
					assignments: publishedGrouping.assignments,
				}
			: { ...grouping };
	});
}
