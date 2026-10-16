/**
 * BundlesTab - Cue modal "Bundles" tab.
 *
 * Export a pipeline or an agent to a portable zip, and import one into this
 * app. The same operations are `maestro-cli bundle export|import`, which go
 * through this app while it runs (see `src/main/cue-bundle-service.ts`).
 */

import { useMemo } from 'react';
import type { Theme } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { BundleExportSection } from './bundles/BundleExportSection';
import { BundleImportSection } from './bundles/BundleImportSection';

export interface BundlesTabProps {
	theme: Theme;
	pipelines: ReadonlyArray<{ id: string; name: string }>;
	/** Refresh the modal's pipelines after an import lands. */
	onImported?: () => void;
}

export function BundlesTab({ theme, pipelines, onImported }: BundlesTabProps) {
	const sessions = useSessionStore((s) => s.sessions);
	const agents = useMemo(
		() =>
			sessions
				.filter((s) => s.toolType !== 'terminal')
				.map((s) => ({ id: s.id, name: s.name, toolType: s.toolType }))
				.sort((a, b) => a.name.localeCompare(b.name)),
		[sessions]
	);
	const sortedPipelines = useMemo(
		() =>
			[...pipelines]
				.map((p) => ({ id: p.id, name: p.name }))
				.sort((a, b) => a.name.localeCompare(b.name)),
		[pipelines]
	);

	return (
		<div className="flex-1 overflow-auto px-5 py-4 space-y-4">
			<BundleExportSection theme={theme} pipelines={sortedPipelines} agents={agents} />
			<BundleImportSection theme={theme} onImported={onImported} />
		</div>
	);
}
