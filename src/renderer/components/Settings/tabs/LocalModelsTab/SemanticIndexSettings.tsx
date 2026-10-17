import { Search } from 'lucide-react';
import type {
	SemanticIndexProgress,
	SemanticIndexState,
} from '../../../../../shared/local-models/embedding-index';
import { useSemanticIndexStatus } from '../../../../hooks/localModels';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Theme } from '../../../../types';
import { ProgressBar } from '../../../ui/ProgressBar';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { ToggleSettingRow } from '../DisplayTab/components/ToggleSettingRow';

export interface SemanticIndexSettingsProps {
	theme: Theme;
}

/** What each indexer state reads as. `off` and `unavailable` carry their own sentence. */
const STATE_LABELS: Record<SemanticIndexState, string> = {
	off: 'Off',
	idle: 'Up to date',
	indexing: 'Indexing',
	paused: 'Paused while another task uses the model',
	unavailable: 'Unavailable',
};

/** "1,204 of 3,400 items indexed", or what to say before a pass has counted anything. */
export function semanticIndexSummary(progress: SemanticIndexProgress): string {
	if (progress.state === 'off') {
		return 'Assign Semantic search a source above to start indexing.';
	}
	if (progress.total === 0) {
		return progress.lastPassAt === undefined
			? 'The first pass starts about a minute after launch.'
			: 'Nothing to index yet.';
	}
	return `${progress.indexed.toLocaleString()} of ${progress.total.toLocaleString()} items indexed`;
}

/**
 * The semantic index: what the Semantic search assignment builds in the
 * background, and the one choice about what goes into it.
 *
 * It sits under the assignments because it has no switch of its own. The
 * indexer runs whenever Semantic search is assigned a source and stops when it
 * is not, so this card only REPORTS (the same record `maestro-cli models index`
 * prints) and offers the Cue toggle.
 *
 * Cue runs are opt-in: they are most of History by volume and mostly the same
 * sentence every few minutes, so indexing them by default would spend the model
 * on noise and bury real work in the results.
 */
export function SemanticIndexSettings({ theme }: SemanticIndexSettingsProps) {
	const semanticIndexCue = useSettingsStore((s) => s.semanticIndexCue);
	const setSemanticIndexCue = useSettingsStore((s) => s.setSemanticIndexCue);
	const { progress, error } = useSemanticIndexStatus();
	const working = progress?.state === 'indexing' || progress?.state === 'paused';

	return (
		<div data-setting-id="local-models-semantic-index" data-testid="semantic-index-settings">
			<SectionCard theme={theme}>
				<div
					className="flex items-center gap-2 font-medium"
					style={{ color: theme.colors.textMain }}
				>
					<Search className="w-4 h-4" />
					Semantic index
				</div>
				<div className="text-xs opacity-70">
					History entries, Director's Notes, and tab transcripts are indexed in the background so
					they can be found by meaning. Indexing waits while another task is using the model.
				</div>

				{error && (
					<div className="text-xs select-text" style={{ color: theme.colors.error }}>
						Could not read the index status: {error}
					</div>
				)}

				{progress && (
					<div className="space-y-1.5" data-testid="semantic-index-status">
						<div className="flex items-baseline justify-between gap-3 text-sm">
							<span
								style={{
									color:
										progress.state === 'unavailable' ? theme.colors.warning : theme.colors.textMain,
								}}
							>
								{STATE_LABELS[progress.state]}
							</span>
							<span className="text-xs opacity-70">{semanticIndexSummary(progress)}</span>
						</div>
						{working && progress.total > 0 && (
							<ProgressBar
								value={progress.indexed}
								total={progress.total}
								theme={theme}
								label="Semantic index progress"
								testId="semantic-index-progress"
							/>
						)}
						{progress.reason && (
							<div className="text-xs select-text" style={{ color: theme.colors.warning }}>
								{progress.reason}
							</div>
						)}
					</div>
				)}

				<ToggleSettingRow
					theme={theme}
					title="Index Cue runs"
					description="Cue runs are most of History and mostly repeat, so they are left out unless you turn this on. Turning it off removes them from the index at the next pass."
					checked={semanticIndexCue}
					onChange={setSemanticIndexCue}
					ariaLabel="Index Cue runs"
					borderTop
					clickableRow
				/>
			</SectionCard>
		</div>
	);
}
