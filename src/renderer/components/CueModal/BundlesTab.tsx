/**
 * BundlesTab - Cue modal "Bundles" tab.
 *
 * Export a pipeline to a portable zip, and import any bundle into this app.
 * The same operations are `maestro-cli bundle export|import`, which go
 * through this app while it runs (see `src/main/cue-bundle-service.ts`).
 * One agent is exported and imported from the Left Bar's right-click menus.
 */

import { useMemo } from 'react';
import { PackagePlus } from 'lucide-react';
import type { Theme } from '../../types';
import { BundleExportSection } from './bundles/BundleExportSection';
import { BundleImportPanel } from '../Bundles/BundleImportPanel';
import { BundleSection } from '../Bundles/bundleUi';

export interface BundlesTabProps {
	theme: Theme;
	pipelines: ReadonlyArray<{ id: string; name: string }>;
	/** Refresh the modal's pipelines after an import lands. */
	onImported?: () => void;
}

export function BundlesTab({ theme, pipelines, onImported }: BundlesTabProps) {
	const sortedPipelines = useMemo(
		() =>
			[...pipelines]
				.map((p) => ({ id: p.id, name: p.name }))
				.sort((a, b) => a.name.localeCompare(b.name)),
		[pipelines]
	);

	return (
		<div className="flex-1 overflow-auto px-5 py-4 space-y-4">
			<BundleExportSection theme={theme} pipelines={sortedPipelines} />
			<BundleSection theme={theme} title="Import" icon={PackagePlus}>
				<BundleImportPanel theme={theme} onImported={() => onImported?.()} />
			</BundleSection>
		</div>
	);
}
