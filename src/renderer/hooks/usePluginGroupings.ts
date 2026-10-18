import { useEffect, useState } from 'react';
import { usePluginContributions } from './usePluginContributions';
import { useSettingsStore } from '../stores/settingsStore';
import type { VirtualGrouping } from '../utils/pluginGroupings';

/** Merges declarative manifest groupings with live, presentation-only snapshots. */
export function usePluginGroupings(): VirtualGrouping[] {
	const { groupings } = usePluginContributions();
	const [published, setPublished] = useState<VirtualGrouping[]>([]);
	const pluginsEnabled = useSettingsStore((s) => s.encoreFeatures?.plugins === true);

	useEffect(() => {
		// No snapshot read and no subscription while the plugins feature is off.
		const plugins = window.maestro?.plugins;
		if (!pluginsEnabled || !plugins) {
			setPublished((prev) => (prev.length === 0 ? prev : []));
			return;
		}
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
	}, [pluginsEnabled]);

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
