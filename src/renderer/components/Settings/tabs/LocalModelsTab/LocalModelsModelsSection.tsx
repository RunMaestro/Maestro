/**
 * LocalModelsModelsSection - the Library panel of the Models tab.
 *
 * One summary line (disk in use, models installed, this computer), then a strip
 * of the Library's sections (`LOCAL_MODEL_LIBRARY_SECTIONS`: Engines, Agent
 * Models, Housekeeping, Speech, Search & Safety, Custom), then the one section
 * that is open. A section that holds a model that failed verification carries
 * the strip's error dot, so a problem is visible from any section.
 *
 * A model section lists every model in it, installed or not, on the shared
 * `LocalModelRow` that Voice Setup also draws, in the groups
 * `groupLocalModelsForLibrary` gives it. A section of one group draws its rows
 * under the section heading; a section of several kinds draws one card per
 * kind, which names the tasks that can use it. Each row says what the model is
 * good at and whether it runs on this computer (`modelFit` against the hardware
 * the main process read). A model that is too large is hidden behind a toggle,
 * unless some of it is already on disk: what occupies the disk is never hidden.
 *
 * Mounting reads the listing, the footprint and the hardware, and nothing else:
 * a download starts only from the row's Download button, which also fetches the
 * engine the model runs on when that is missing (the button states both sizes).
 * The Engines section shows those engines on their own, for the cases a model
 * download does not cover. Adding a
 * model from Hugging Face is `AddHuggingFaceModelCard` in Custom, one request
 * per click.
 *
 * "In use by" is answered from two sources. Tasks come from the effective
 * `localModelAssignments` (defaults included), and voice from its own
 * capability table, because voice picks its models through its provider
 * settings rather than through an assignment. Removing a model a task is
 * assigned to warns first and names those tasks: the removal turns each of them
 * unavailable, and the user should choose that knowingly.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
	AlertTriangle,
	Bot,
	Cpu,
	Eye,
	EyeOff,
	Mic,
	PackagePlus,
	ScanSearch,
	Wrench,
	type LucideIcon,
} from 'lucide-react';

import {
	LOCAL_MODEL_LIBRARY_SECTION_IDS,
	LOCAL_MODEL_LIBRARY_SECTIONS,
	groupLocalModelsForLibrary,
	localModelLibrarySection,
	type LocalModelLibrarySectionId,
} from '../../../../../shared/local-models/library';
import {
	describeHardwareProfile,
	hardwareFitCaveat,
	modelFit,
	type ModelFit,
} from '../../../../../shared/local-models/model-fit';
import { tasksNeedingKind, tasksUsingLocalModel } from '../../../../../shared/local-models/tasks';
import { voiceModelUsageLabel } from '../../../../../shared/acappella/voice-models';
import { formatSize } from '../../../../../shared/formatters';
import type { LocalModelListing } from '../../../../../main/local-models/service';
import {
	useLocalModelsHardware,
	type LocalModelsState,
	type LocalRuntimesState,
} from '../../../../hooks/localModels';
import { usePersistedToggle } from '../../../../hooks/ui/usePersistedToggle';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Theme } from '../../../../types';
import { ipcErrorMessage } from '../../../../utils/ipcErrorMessage';
import { ModalTabStrip, tabPanelProps, type ModalTab } from '../../../ui/ModalTabStrip';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { AddHuggingFaceModelCard } from './AddHuggingFaceModelCard';
import { LocalModelRow, isActive } from './LocalModelRow';
import { LocalModelsEnginesCard } from './LocalModelsEnginesCard';
import { RemoveInUseWarning } from './RemoveInUseWarning';

export interface LocalModelsModelsSectionProps {
	theme: Theme;
	/** The tab's one `useLocalModels()` instance, shared with the assignment pickers. */
	models: LocalModelsState;
	/** The tab's one `useLocalRuntimes()` instance: the engines the models run on. */
	runtimes: LocalRuntimesState;
	/** The open section. Owned by `useModelsSettingsNav`, so a deep link can move it. */
	section: LocalModelLibrarySectionId;
	onSectionChange: (section: LocalModelLibrarySectionId) => void;
}

/** localStorage key for "Show models too large for this machine". */
export const SHOW_TOO_LARGE_MODELS_STORAGE_KEY = 'settings.models.showTooLarge';

const SECTION_ICONS: Readonly<Record<LocalModelLibrarySectionId, LucideIcon>> = Object.freeze({
	agents: Bot,
	housekeeping: Wrench,
	speech: Mic,
	search: ScanSearch,
	custom: PackagePlus,
	engines: Cpu,
});

const ID_PREFIX = 'settings-models-library';

/** A removal waiting on the in-use warning: the files alone, or the Library entry too. */
interface PendingRemoval {
	id: string;
	fromLibrary: boolean;
}

export function LocalModelsModelsSection({
	theme,
	models,
	runtimes,
	section,
	onSectionChange,
}: LocalModelsModelsSectionProps) {
	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const hardware = useLocalModelsHardware();
	const showTooLarge = usePersistedToggle(SHOW_TOO_LARGE_MODELS_STORAGE_KEY, false);
	// The model whose removal is waiting on the in-use warning, if any.
	const [confirmingRemove, setConfirmingRemove] = useState<PendingRemoval | null>(null);
	const [libraryError, setLibraryError] = useState<string | null>(null);

	// Whether each model runs on this computer. Empty until the hardware is read,
	// so nothing is labeled, or hidden, on a guess.
	const fitByModel = useMemo(() => {
		const byModel: Record<string, ModelFit> = {};
		if (!hardware.profile) return byModel;
		for (const listing of models.listings) {
			byModel[listing.entry.id] = modelFit(listing.entry, hardware.profile);
		}
		return byModel;
	}, [hardware.profile, models.listings]);

	// A model too large for this computer is hidden unless the user asked to see
	// those, or some of it is on disk or on its way there: disk in use, and a
	// download in flight, are never hidden.
	const tooLargeIds = useMemo(() => {
		const ids = new Set<string>();
		for (const listing of models.listings) {
			const id = listing.entry.id;
			const progress = models.progress[id];
			const busy = isActive(progress) || progress?.phase === 'paused';
			if (fitByModel[id]?.fit === 'too-large' && listing.status.bytesOnDisk === 0 && !busy) {
				ids.add(id);
			}
		}
		return ids;
	}, [fitByModel, models.listings, models.progress]);

	const sectionListings = useMemo(
		() => models.listings.filter((listing) => localModelLibrarySection(listing.entry) === section),
		[models.listings, section]
	);
	const hiddenInSection = sectionListings.filter((listing) =>
		tooLargeIds.has(listing.entry.id)
	).length;

	const groups = useMemo(
		() =>
			groupLocalModelsForLibrary(
				showTooLarge.value
					? sectionListings
					: sectionListings.filter((listing) => !tooLargeIds.has(listing.entry.id)),
				(listing) => listing.entry,
				section
			),
		[sectionListings, showTooLarge.value, tooLargeIds, section]
	);

	const tasksByModel = useMemo(() => {
		const byModel: Record<string, string[]> = {};
		for (const listing of models.listings) {
			byModel[listing.entry.id] = tasksUsingLocalModel(assignments, listing.entry.id).map(
				(task) => task.label
			);
		}
		return byModel;
	}, [assignments, models.listings]);

	const footprintBytes = models.footprint?.bytes ?? 0;
	const installedCount = models.listings.filter(
		(listing) => listing.status.status === 'installed'
	).length;

	// The strip: one tab per section, with the error dot on a section that holds
	// a model that failed verification, or on Engines when an engine needs work.
	const sectionTabs = useMemo<ModalTab<LocalModelLibrarySectionId>[]>(() => {
		const corruptSections = new Set(
			models.listings
				.filter((listing) => listing.status.status === 'corrupt')
				.map((listing) => localModelLibrarySection(listing.entry))
		);
		const enginesNeedWork =
			!!runtimes.error || runtimes.listings.some((listing) => listing.installed && listing.stale);
		return LOCAL_MODEL_LIBRARY_SECTION_IDS.map((id) => ({
			id,
			label: LOCAL_MODEL_LIBRARY_SECTIONS[id].label,
			icon: SECTION_ICONS[id],
			hasError: id === 'engines' ? enginesNeedWork : corruptSections.has(id),
		}));
	}, [models.listings, runtimes.error, runtimes.listings]);
	const corruptCount = models.listings.filter(
		(listing) => listing.status.status === 'corrupt'
	).length;

	// Bytes of engine each runtime still needs, so a model row can state what its
	// Download button fetches. Zero once the engine is installed and current, and
	// zero where no build exists (the Engines section says that; the row cannot fix it).
	const engineBytesByRuntime = useMemo(() => {
		const bytes: Record<string, number> = {};
		for (const runtime of runtimes.listings) {
			const needed = runtime.downloadable && (!runtime.installed || runtime.stale);
			bytes[runtime.id] = needed ? runtime.bytes : 0;
		}
		return bytes;
	}, [runtimes.listings]);

	const { download: downloadModel } = models;
	const { refresh: refreshRuntimes } = runtimes;
	const handleDownload = useCallback(
		(modelId: string) => {
			// The download installs the engine too (main does both), so the engine
			// listing is re-read when it settles.
			void downloadModel(modelId).then(() => refreshRuntimes());
		},
		[downloadModel, refreshRuntimes]
	);

	const { remove: removeModel, refresh: refreshModels } = models;
	const runRemoval = useCallback(
		async ({ id, fromLibrary }: PendingRemoval) => {
			setLibraryError(null);
			if (!fromLibrary) {
				await removeModel(id);
				return;
			}
			try {
				const result = await window.maestro.localModels.huggingFace.remove(id);
				if (!result.ok) setLibraryError(result.message);
			} catch (error) {
				setLibraryError(ipcErrorMessage(error));
			}
			await refreshModels();
		},
		[removeModel, refreshModels]
	);

	const requestRemoval = useCallback(
		(removal: PendingRemoval) => {
			if ((tasksByModel[removal.id] ?? []).length > 0) {
				setConfirmingRemove(removal);
				return;
			}
			void runRemoval(removal);
		},
		[runRemoval, tasksByModel]
	);

	const handleRemove = useCallback(
		(modelId: string) => requestRemoval({ id: modelId, fromLibrary: false }),
		[requestRemoval]
	);
	const handleRemoveFromLibrary = useCallback(
		(modelId: string) => requestRemoval({ id: modelId, fromLibrary: true }),
		[requestRemoval]
	);

	const confirmRemove = useCallback(
		(removal: PendingRemoval) => {
			setConfirmingRemove(null);
			void runRemoval(removal);
		},
		[runRemoval]
	);

	const fitCaveat = hardware.profile ? hardwareFitCaveat(hardware.profile) : null;
	const error = models.error ?? libraryError ?? hardware.error;

	const renderRow = (listing: LocalModelListing) => {
		const id = listing.entry.id;
		const taskLabels = tasksByModel[id] ?? [];
		const voiceLabel = voiceModelUsageLabel(id);
		const rowUsedBy = voiceLabel ? [...taskLabels, voiceLabel] : taskLabels;
		return (
			<div key={id} className="space-y-2">
				{confirmingRemove?.id === id && (
					<RemoveInUseWarning
						theme={theme}
						subjectName={listing.entry.displayName}
						taskLabels={taskLabels}
						recovery={confirmingRemove.fromLibrary ? 'add it again' : 'download it again'}
						onConfirm={() => confirmRemove(confirmingRemove)}
						onKeep={() => setConfirmingRemove(null)}
					/>
				)}
				<LocalModelRow
					theme={theme}
					listing={listing}
					progress={models.progress[id]}
					verifyResult={models.verifyResults[id]}
					usedBy={rowUsedBy}
					engineBytes={engineBytesByRuntime[listing.entry.runtime] ?? 0}
					showRoles
					fit={fitByModel[id]}
					onDownload={handleDownload}
					onPause={(modelId) => void models.pause(modelId)}
					onResume={(modelId) => void models.resume(modelId)}
					onCancel={(modelId) => void models.cancel(modelId)}
					onVerify={(modelId) => void models.verify(modelId)}
					onRemove={handleRemove}
					onRemoveFromLibrary={handleRemoveFromLibrary}
				/>
			</div>
		);
	};

	// The open section's models: rows straight under the heading for a section of
	// one group, one titled card per kind for a section of several.
	const modelCards = (emptyNote?: string): ReactNode => {
		const several = LOCAL_MODEL_LIBRARY_SECTIONS[section].groups.length > 1;
		return (
			<div className="space-y-3">
				{groups.length === 0 && emptyNote && (
					<SectionCard theme={theme}>
						<p className="text-xs opacity-70">{emptyNote}</p>
					</SectionCard>
				)}
				{groups.map(({ group, items }) => {
					let header: ReactNode = null;
					if (several) {
						// A kind card names the tasks that can use it.
						const usedBy = group.kind ? tasksNeedingKind(group.kind).map((task) => task.label) : [];
						if (items.some((listing) => voiceModelUsageLabel(listing.entry.id))) {
							usedBy.push('Voice');
						}
						header = (
							<div>
								<div className="font-medium" style={{ color: theme.colors.textMain }}>
									{group.label}
								</div>
								<p className="text-xs opacity-70 mt-0.5">
									{usedBy.length > 0
										? `Can be used by ${usedBy.join(', ')}.`
										: 'Nothing uses this kind of model yet.'}
								</p>
							</div>
						);
					}
					return (
						<SectionCard key={group.id} theme={theme} testId={`local-models-group-${group.id}`}>
							{header}
							{items.map(renderRow)}
						</SectionCard>
					);
				})}
				{hiddenInSection > 0 && (
					<button
						type="button"
						onClick={showTooLarge.toggle}
						aria-pressed={showTooLarge.value}
						className="px-2 py-1 rounded border text-xs flex items-center gap-1.5"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						data-testid="local-models-show-too-large"
					>
						{showTooLarge.value ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
						{showTooLarge.value ? 'Hide' : 'Show'} models too large for this machine (
						{hiddenInSection})
					</button>
				)}
			</div>
		);
	};

	const heading = (
		<SettingsSectionHeading
			icon={SECTION_ICONS[section]}
			description={LOCAL_MODEL_LIBRARY_SECTIONS[section].description}
		>
			{LOCAL_MODEL_LIBRARY_SECTIONS[section].label}
		</SettingsSectionHeading>
	);

	return (
		<div className="select-none space-y-5" data-testid="local-models-models-section">
			<div className="space-y-1.5">
				<p className="text-xs opacity-70 select-text" data-testid="local-models-summary">
					{formatSize(footprintBytes)} on disk, {installedCount} installed
					{hardware.profile && (
						<span data-testid="local-models-hardware">
							. This computer: {describeHardwareProfile(hardware.profile)}
						</span>
					)}
					.
				</p>
				{corruptCount > 0 && (
					<div
						className="flex items-start gap-1.5 text-xs select-text"
						style={{ color: theme.colors.warning }}
						data-testid="local-models-needs-attention"
					>
						<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
						<span>
							{corruptCount === 1
								? 'One model failed verification. Its tab is marked.'
								: `${corruptCount} models failed verification. Their tabs are marked.`}
						</span>
					</div>
				)}
				{fitCaveat && (
					<div
						className="flex items-start gap-1.5 text-xs select-text"
						style={{ color: theme.colors.warning }}
						data-testid="local-models-fit-caveat"
					>
						<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
						<span>{fitCaveat}</span>
					</div>
				)}
				{error && (
					<div
						className="flex items-start gap-1.5 text-xs select-text"
						style={{ color: theme.colors.error }}
					>
						<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
						<span>{error}</span>
					</div>
				)}
			</div>

			<ModalTabStrip
				theme={theme}
				tabs={sectionTabs}
				activeTab={section}
				onChange={onSectionChange}
				label="Library sections"
				idPrefix={ID_PREFIX}
			/>

			<div {...tabPanelProps(ID_PREFIX, section)} className="space-y-5">
				{section === 'agents' && (
					<div data-setting-id="local-models-agents">
						{heading}
						{modelCards()}
					</div>
				)}
				{section === 'housekeeping' && (
					<div data-setting-id="local-models-housekeeping">
						{heading}
						{modelCards()}
					</div>
				)}
				{section === 'speech' && (
					<div data-setting-id="local-models-speech">
						{heading}
						{modelCards()}
					</div>
				)}
				{section === 'search' && (
					<div data-setting-id="local-models-search">
						{heading}
						{modelCards()}
					</div>
				)}
				{section === 'custom' && (
					<>
						<div>
							{heading}
							{modelCards('No models added yet. Add one below by its Hugging Face repo and file.')}
						</div>
						<AddHuggingFaceModelCard
							theme={theme}
							hardware={hardware.profile}
							onAdded={() => void models.refresh()}
						/>
					</>
				)}
				{section === 'engines' && (
					<div data-setting-id="local-models-engines">
						{heading}
						<LocalModelsEnginesCard theme={theme} runtimes={runtimes} />
					</div>
				)}
			</div>
		</div>
	);
}
