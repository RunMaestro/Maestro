/**
 * The walkthrough A Cappella opens the first time it is switched on.
 *
 * **Why this exists.** Voice is the one Encore Feature that cannot work the
 * moment it is enabled: speech recognition and speech synthesis are models, and
 * models are hundreds of megabytes that nobody should download without being
 * asked. Before this, enabling the feature left a user with a HUD that listened,
 * showed a level meter, and transcribed nothing, because the pipeline silently
 * resolved to a mock. Every part looked healthy and the whole did nothing. The
 * fix is not a better fallback - it is telling the truth at the moment the
 * feature is switched on, and offering the one button that resolves it.
 *
 * **It asks, it does not act.** Mounting this issues no network call. The
 * catalog is frozen and local, so the whole bill of materials - every file, its
 * size, its licence, and whether audio leaves the machine - is on screen BEFORE
 * the user agrees to anything. That is the same rule `VoiceSetupPanel` follows,
 * and it is what makes "Download" a consent rather than a formality.
 *
 * **Dismissing it is a real answer.** "Later" leaves voice enabled and
 * unconfigured, which is a legitimate state: the capability gate refuses by name
 * and points back here. What must never happen is a dismissal that leaves the
 * user believing voice is ready.
 *
 * This is a thin shell over the pieces Voice Setup already uses -
 * `useVoiceModels` for the listing and the downloads, `VoiceModelRow` for
 * per-file progress, `MODEL_SETS` for what a bundle contains. It deliberately
 * owns no download logic of its own, so the modal and the settings panel cannot
 * drift on what "installed" means.
 */

import { useCallback, useMemo } from 'react';
import { Check, Download, ShieldCheck } from 'lucide-react';

import {
	MODEL_SETS,
	getModelSetEntries,
	type VoiceModelSetId,
} from '../../../../shared/acappella/model-catalog';
import { formatSize } from '../../../../shared/formatters';
import type { Theme } from '../../../types';
import { Modal } from '../../ui/Modal';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { VoiceModelRow } from './VoiceModelRow';
import { useVoiceModels } from './useVoiceModels';
import { useVoiceRuntimes } from './useVoiceRuntimes';
import type { RuntimeInstallProgress } from '../../../../main/acappella/runtime/runtime-installer';

/**
 * The bundle a first run offers: the recogniser and the wake word, which is
 * everything the local trio downloads. The voice is the operating system's own
 * and the router is built in, so with this on disk a fresh install can be spoken
 * to and can answer with nothing leaving the machine.
 */
export const FIRST_RUN_MODEL_SET: VoiceModelSetId = 'hands-free-local';

/**
 * What each install phase is called on screen.
 *
 * Named rather than showing the raw phase: "verifying" and "extracting" are
 * short but they are the two moments a progress bar sits still, and a user
 * watching a frozen bar with no label assumes it has hung.
 */
const PHASE_LABELS: Record<RuntimeInstallProgress['phase'], string> = {
	downloading: 'Downloading...',
	verifying: 'Verifying...',
	extracting: 'Installing...',
	done: 'Installed',
};

export interface VoiceSetupModalProps {
	theme: Theme;
	onClose: () => void;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
	/** Opens the full Voice Setup panel, for anything this flow does not cover. */
	onOpenSettings?: () => void;
}

/**
 * Rendered only while open - `Modal` has no `isOpen`, the caller mounts it. That
 * also means `useVoiceModels` runs only while the flow is on screen, so a closed
 * walkthrough holds no listener and issues no disk read.
 */
export function VoiceSetupModal({ theme, onClose, enabled, onOpenSettings }: VoiceSetupModalProps) {
	const models = useVoiceModels(enabled);
	const runtimes = useVoiceRuntimes(enabled);

	const entries = useMemo(() => getModelSetEntries(FIRST_RUN_MODEL_SET), []);
	const listingsById = useMemo(
		() => new Map(models.listings.map((listing) => [listing.entry.id, listing])),
		[models.listings]
	);

	/** Files the bundle needs that are neither installed nor already downloading. */
	const missing = useMemo(
		() =>
			entries
				.map((entry) => entry.id)
				.filter((id) => {
					const listing = listingsById.get(id);
					if (!listing) return false;
					// A live job is already fetching this one; counting it again would
					// inflate the button's total and re-issue the download.
					if (models.progress[id]?.phase === 'downloading') return false;
					return listing.status.status !== 'installed';
				}),
		[entries, listingsById, models.progress]
	);

	const missingBytes = useMemo(
		() => missing.reduce((total, id) => total + (listingsById.get(id)?.entry.bytes ?? 0), 0),
		[missing, listingsById]
	);

	const downloading = useMemo(
		() => entries.some((entry) => models.progress[entry.id]?.phase === 'downloading'),
		[entries, models.progress]
	);

	/**
	 * Runtimes the bundle's slots need but that are not installed.
	 *
	 * Derived from the SLOTS the chosen models fill rather than from a hard-coded
	 * id, so a catalog change cannot leave the walkthrough fetching weights with
	 * no engine to read them. A runtime with no build for this platform is
	 * excluded: offering a download that cannot exist is worse than saying nothing.
	 */
	const missingRuntimes = useMemo(() => {
		const needed = new Set(entries.map((entry) => entry.role));
		return runtimes.listings.filter(
			(runtime) =>
				runtime.downloadable &&
				(!runtime.installed || runtime.stale) &&
				runtime.slots.some((slot) => needed.has(slot as (typeof entries)[number]['role']))
		);
	}, [entries, runtimes.listings]);

	const missingRuntimeBytes = useMemo(
		() => missingRuntimes.reduce((total, runtime) => total + runtime.bytes, 0),
		[missingRuntimes]
	);

	const installingRuntime = useMemo(
		() =>
			missingRuntimes.some((runtime) => {
				const phase = runtimes.progress[runtime.id]?.phase;
				return phase !== undefined && phase !== 'done';
			}),
		[missingRuntimes, runtimes.progress]
	);

	// Ready means every file AND every engine is on disk. Derived rather than
	// remembered, so a model removed from the Models page while this is open stops
	// claiming to be installed - and so a machine with all the weights but no
	// runtime is not told voice is ready when it would refuse on the first word.
	const ready =
		models.listings.length > 0 &&
		missing.length === 0 &&
		missingRuntimes.length === 0 &&
		!downloading &&
		!installingRuntime;

	/**
	 * One button fetches BOTH, and the runtimes go first.
	 *
	 * A model without its engine is inert, and the two are a single decision from
	 * the user's side ("make voice work"), so splitting them into two buttons would
	 * only create a state where someone waits through a gigabyte and voice still
	 * refuses. Runtimes lead because they are far smaller, so the slow part of the
	 * wait happens with everything else already in place.
	 */
	const handleDownload = useCallback(async () => {
		for (const runtime of missingRuntimes) {
			await runtimes.install(runtime.id);
		}
		await models.downloadMany([...missing]);
	}, [models, missing, missingRuntimes, runtimes]);

	return (
		<Modal
			theme={theme}
			onClose={onClose}
			title="Set up voice"
			priority={MODAL_PRIORITIES.CONFIRM}
			resizeKey="voiceSetupModal"
			defaultSize={{ width: 620, height: 560 }}
			minSize={{ width: 460, height: 420 }}
		>
			<div className="space-y-4 select-none">
				<p className="text-xs opacity-75" style={{ color: theme.colors.textMain }}>
					Voice needs a speech recogniser, which runs on this machine and has to be downloaded once.
					Replies use your computer&apos;s own voice, so nothing else is needed. Nothing is fetched
					until you press Download.
				</p>

				<div
					className="flex items-start gap-2 rounded p-2.5"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<ShieldCheck
						size={15}
						className="shrink-0 mt-0.5"
						style={{ color: theme.colors.success }}
					/>
					<p className="text-[11px] opacity-80" style={{ color: theme.colors.textMain }}>
						{MODEL_SETS[FIRST_RUN_MODEL_SET].description} You can switch any slot to a hosted
						provider later, and voice will tell you before it sends anything anywhere.
					</p>
				</div>

				{(models.error || runtimes.error) && (
					<p className="text-xs" style={{ color: theme.colors.error }}>
						{models.error ?? runtimes.error}
					</p>
				)}

				<div className="space-y-2">
					{entries.map((entry) => {
						const listing = listingsById.get(entry.id);
						if (!listing) return null;
						return (
							<VoiceModelRow
								key={entry.id}
								theme={theme}
								listing={listing}
								progress={models.progress[entry.id]}
								verifyResult={models.verifyResults[entry.id]}
								onDownload={(id) => void models.download(id)}
								onPause={(id) => void models.pause(id)}
								onResume={(id) => void models.resume(id)}
								onCancel={(id) => void models.cancel(id)}
								onVerify={(id) => void models.verify(id)}
							/>
						);
					})}
					{missingRuntimes.map((runtime) => {
						// The engine is listed too. It is a real download the user is about
						// to make, and a bill of materials that omits it is not a bill of
						// materials - the total on the button would silently exceed the sum
						// of the rows above it.
						const phase = runtimes.progress[runtime.id]?.phase;
						return (
							<div
								key={runtime.id}
								data-testid={`voice-setup-runtime-${runtime.id}`}
								className="flex items-center justify-between gap-3 rounded p-2.5"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								<div className="min-w-0">
									<div
										className="text-sm font-medium truncate"
										style={{ color: theme.colors.textMain }}
									>
										{runtime.label}
									</div>
									<p className="text-[11px] opacity-70">
										The engine that runs the models above. Downloaded once, from a pinned release,
										and checked against a hash recorded in the app.
									</p>
								</div>
								<span className="text-xs opacity-70 shrink-0">
									{phase && phase !== 'done' ? PHASE_LABELS[phase] : formatSize(runtime.bytes)}
								</span>
							</div>
						);
					})}
					{models.loading && models.listings.length === 0 && (
						<p className="text-xs opacity-55">Reading what is already installed...</p>
					)}
				</div>

				{ready && (
					<div
						className="flex items-center gap-2 rounded p-2.5"
						style={{ backgroundColor: theme.colors.bgActivity }}
					>
						<Check size={15} className="shrink-0" style={{ color: theme.colors.success }} />
						<p className="text-xs" style={{ color: theme.colors.textMain }}>
							Voice is ready. Open it from the microphone in the composer, or say your wake word.
						</p>
					</div>
				)}

				<div className="flex items-center justify-between gap-3 pt-1">
					<div className="flex items-center gap-2">
						<button
							type="button"
							data-testid="voice-setup-modal-download"
							disabled={
								ready ||
								(missing.length === 0 && missingRuntimes.length === 0) ||
								downloading ||
								installingRuntime
							}
							onClick={handleDownload}
							className="px-3 py-2 rounded border text-sm font-medium disabled:opacity-55 flex items-center gap-1.5"
							style={{
								borderColor: theme.colors.accent,
								backgroundColor: theme.colors.accentDim,
								color: theme.colors.textMain,
							}}
						>
							<Download size={14} />
							{installingRuntime
								? 'Installing engine...'
								: downloading
									? 'Downloading...'
									: ready
										? 'Everything is installed'
										: `Download (${formatSize(missingBytes + missingRuntimeBytes)})`}
						</button>
						{onOpenSettings && (
							<button
								type="button"
								data-testid="voice-setup-modal-advanced"
								onClick={onOpenSettings}
								className="px-2.5 py-2 rounded text-xs opacity-75 hover:opacity-100"
								style={{ color: theme.colors.textMain }}
							>
								More options
							</button>
						)}
					</div>

					<button
						type="button"
						data-testid="voice-setup-modal-dismiss"
						onClick={onClose}
						className="px-3 py-2 rounded text-sm"
						style={{ color: theme.colors.textMain, opacity: 0.8 }}
					>
						{/* Honest about the state it leaves behind: voice stays ON and
						    unconfigured, and the gate will say so when it refuses. */}
						{ready ? 'Done' : 'Later'}
					</button>
				</div>
			</div>
		</Modal>
	);
}
