import { useState } from 'react';
import { Search, Database, RefreshCw, Trash2 } from 'lucide-react';
import { formatCount, formatSize } from '../../../../../shared/formatters';
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
import { ConfirmModal } from '../../../ConfirmModal';
import { CardButton } from './CardButton';
import { SemanticIndexExplorer } from './SemanticIndexExplorer';

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
		if (progress.reason && progress.state === 'idle') return 'No cached items.';
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
 * is not. Storage controls inspect or clear its derived cache; original source
 * documents are read through the same readers as semantic search.
 *
 * Cue runs are opt-in: they are most of History by volume and mostly the same
 * sentence every few minutes, so indexing them by default would spend the model
 * on noise and bury real work in the results.
 */
export function SemanticIndexSettings({ theme }: SemanticIndexSettingsProps) {
	const semanticIndexCue = useSettingsStore((s) => s.semanticIndexCue);
	const setSemanticIndexCue = useSettingsStore((s) => s.setSemanticIndexCue);
	const { progress, error, storage, storageError, clearing, refreshStorage, clearIndex } =
		useSemanticIndexStatus();
	const [exploring, setExploring] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);
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
								{progress.state === 'idle' && (progress.indexed < progress.total || progress.reason)
									? 'Waiting for next pass'
									: STATE_LABELS[progress.state]}
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

				<div className="space-y-2 border-t pt-3" style={{ borderColor: theme.colors.border }}>
					<div className="text-sm font-medium" data-testid="semantic-index-storage">
						{storage
							? `${formatSize(storage.diskBytes)} on disk · ${formatCount(storage.totalChunks)} searchable chunks`
							: 'Measuring index storage...'}
					</div>
					<div className="text-xs opacity-70">
						Includes all index files across all indexed models. Model downloads are stored
						separately.
					</div>
					{storageError && (
						<div className="text-xs select-text" role="alert" style={{ color: theme.colors.error }}>
							Index storage: {storageError}
						</div>
					)}
					<div className="flex flex-wrap gap-2">
						<CardButton
							theme={theme}
							icon={Database}
							label={exploring ? 'Hide index' : 'Explore index'}
							onClick={() => setExploring((value) => !value)}
							disabled={clearing || !storage?.totalChunks}
							testId="semantic-index-explore"
						/>
						<CardButton
							theme={theme}
							icon={RefreshCw}
							label="Refresh storage"
							onClick={() => void refreshStorage()}
							disabled={clearing}
							testId="semantic-index-refresh-storage"
						/>
						<CardButton
							theme={theme}
							icon={Trash2}
							label={clearing ? 'Clearing index...' : 'Clear index'}
							onClick={() => setConfirmClear(true)}
							disabled={clearing || !storage?.diskBytes}
							testId="semantic-index-clear"
						/>
					</div>
				</div>
				{exploring && storage && storage.totalChunks > 0 && !clearing && (
					<SemanticIndexExplorer
						theme={theme}
						storage={storage}
						activeModelId={progress?.modelId}
					/>
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
			{confirmClear && (
				<ConfirmModal
					theme={theme}
					title="Clear semantic index"
					confirmLabel="Clear index"
					message="Remove cached search vectors for every indexed model and reclaim their disk space? Original History entries, Director's Notes, and transcripts are kept. Automatic indexing rebuilds the cache on its next scheduled pass while Semantic search has a model assigned."
					onConfirm={() => void clearIndex()}
					onClose={() => setConfirmClear(false)}
					testId="semantic-index-clear-confirm"
				/>
			)}
		</div>
	);
}
