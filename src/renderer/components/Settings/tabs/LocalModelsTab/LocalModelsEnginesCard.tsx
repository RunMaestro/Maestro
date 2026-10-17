/**
 * LocalModelsEnginesCard - the native runtimes ("engines") local models run on.
 *
 * The card of Models > Library > Engines.
 *
 * A model is a file of weights; an engine is the native library that reads it
 * (ONNX Runtime for speech, embeddings and classifiers; llama.cpp for text).
 * Engines are downloaded, not bundled, so a model can be installed and verified
 * and still not run. This card is where the Models tab says so and fixes
 * it: before it existed the only Install button for an engine lived in Voice
 * Setup, so a text model fetched here reported "engine not installed" with
 * nothing in the tab that could act on it.
 *
 * A model's own Download button installs its engine alongside it, so most users
 * never press anything here. The card is for the three cases that leaves: an
 * engine that failed to install, one a newer build has replaced (`stale`), and
 * a platform with no published build, which is an answer no download changes.
 */

import { Download, RefreshCw } from 'lucide-react';

import type { LocalRuntimeListing } from '../../../../../main/local-models/service';
import type {
	RuntimeInstallPhase,
	RuntimeInstallProgress,
} from '../../../../../main/local-models/runtime/runtime-installer';
import { getLocalModel } from '../../../../../shared/local-models/model-catalog';
import { formatSize } from '../../../../../shared/formatters';
import type { LocalRuntimesState } from '../../../../hooks/localModels';
import type { Theme } from '../../../../types';
import { SectionCard } from '../DisplayTab/components/SectionCard';

const PHASE_LABELS: Readonly<Record<RuntimeInstallPhase, string>> = Object.freeze({
	downloading: 'Downloading',
	verifying: 'Verifying',
	extracting: 'Installing',
	done: 'Installed',
});

export type EngineState = 'installed' | 'stale' | 'not-installed' | 'unavailable' | 'installing';

/** One engine's state in the words the card shows. Pure, so the rule is testable without a render. */
export function engineState(
	listing: LocalRuntimeListing,
	progress?: RuntimeInstallProgress
): EngineState {
	if (progress && progress.phase !== 'done') return 'installing';
	if (!listing.downloadable) return listing.installed ? 'installed' : 'unavailable';
	if (!listing.installed) return 'not-installed';
	return listing.stale ? 'stale' : 'installed';
}

/** The catalog models an engine reads, by display name. */
function modelNames(listing: LocalRuntimeListing): string {
	return listing.models
		.map((id) => getLocalModel(id)?.displayName)
		.filter((name): name is string => !!name)
		.join(', ');
}

export interface LocalModelsEnginesCardProps {
	theme: Theme;
	/** The tab's one `useLocalRuntimes()` instance, shared with the model rows. */
	runtimes: LocalRuntimesState;
}

/** The card body. Its heading and description are the Engines section's, above it. */
export function LocalModelsEnginesCard({ theme, runtimes }: LocalModelsEnginesCardProps) {
	if (runtimes.listings.length === 0 && !runtimes.error) return null;
	return (
		<SectionCard theme={theme} testId="local-models-engines">
			{runtimes.error && (
				<p className="text-xs select-text" style={{ color: theme.colors.error }}>
					{runtimes.error}
				</p>
			)}
			{runtimes.listings.map((listing) => {
				const progress = runtimes.progress[listing.id];
				const state = engineState(listing, progress);
				return (
					<div
						key={listing.id}
						className="rounded border p-3 flex items-start justify-between gap-3"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
						data-testid={`local-models-engine-${listing.id}`}
					>
						<div className="min-w-0">
							<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
								{listing.label}
							</div>
							<p className="text-xs opacity-70 mt-0.5">Runs {modelNames(listing)}.</p>
							{state === 'unavailable' && (
								<p className="text-xs-plus mt-0.5" style={{ color: theme.colors.warning }}>
									No build is published for this platform, so these models cannot run here.
								</p>
							)}
							{state === 'stale' && (
								<p className="text-xs-plus mt-0.5" style={{ color: theme.colors.warning }}>
									This build expects a newer version. Update it before these models will load.
								</p>
							)}
						</div>
						<div className="flex-shrink-0 flex items-center gap-2">
							{state === 'installing' && progress && (
								<span className="text-xs-plus opacity-70">
									{PHASE_LABELS[progress.phase]}
									{progress.phase === 'downloading' && progress.totalBytes > 0
										? ` ${Math.min(100, Math.round((progress.bytes / progress.totalBytes) * 100))}%`
										: ''}
								</span>
							)}
							{state === 'installed' && (
								<span className="text-xs-plus" style={{ color: theme.colors.success }}>
									Installed
								</span>
							)}
							{(state === 'not-installed' || state === 'stale') && (
								<button
									type="button"
									onClick={() => void runtimes.install(listing.id)}
									className="px-2 py-1 rounded border text-xs flex items-center gap-1.5"
									style={{
										borderColor: theme.colors.accent,
										backgroundColor: theme.colors.accentDim,
										color: theme.colors.textMain,
									}}
								>
									{state === 'stale' ? (
										<RefreshCw className="w-3 h-3" />
									) : (
										<Download className="w-3 h-3" />
									)}
									{state === 'stale' ? 'Update' : 'Install'} ({formatSize(listing.bytes)})
								</button>
							)}
							{state === 'unavailable' && (
								<span className="text-xs-plus opacity-55">Not available</span>
							)}
						</div>
					</div>
				);
			})}
		</SectionCard>
	);
}
