/**
 * ModelsOverview - the landing page of Settings > Models, shown when the Models
 * row itself is selected in the sidebar.
 *
 * Top to bottom: a row of stat tiles (disk in use, models installed, engines
 * ready, active tasks, endpoints, and the memory every fit label is judged
 * against); a warning that jumps to a model that failed verification, only when
 * one did; what Local Models is for, with what "active task" means; and a guide
 * to the five panels, each card a jump to its panel.
 *
 * The page's own width (`useElementWidth`) sets the stat tiles to three or two
 * columns. Panel cards use thirds for Library, Sources, and Gateway, then halves
 * for System One and System Two. On narrow pages Gateway fills its own row.
 *
 * It reads what the tab's hooks already hold and nothing else: no download, no
 * probe, no engine call. Every number comes from the same state the panels show,
 * so the overview cannot disagree with them.
 */

import { useMemo, useRef } from 'react';
import {
	AlertTriangle,
	ArrowRight,
	Brain,
	CheckCircle2,
	Compass,
	Cpu,
	HardDrive,
	ListChecks,
	MemoryStick,
	Router,
	Server,
	Sparkles,
	type LucideIcon,
} from 'lucide-react';

import { formatSize } from '../../../../../shared/formatters';
import { localModelLibrarySection } from '../../../../../shared/local-models/library';
import {
	hardwareFitCaveat,
	hardwareProfileStat,
} from '../../../../../shared/local-models/model-fit';
import {
	MODELS_SETTINGS_PANEL_LABELS,
	MODELS_SETTINGS_PANEL_SUMMARIES,
	modelsSettingsSubTab,
	type ModelsSettingsPanel,
} from '../../../../../shared/local-models/settings-location';
import {
	LOCAL_MODEL_TASK_IDS,
	resolveLocalModelAssignments,
} from '../../../../../shared/local-models/tasks';
import {
	useLocalModelsHardware,
	type LocalModelsState,
	type LocalRuntimesState,
} from '../../../../hooks/localModels';
import { useElementWidth } from '../../../../hooks/ui/useElementWidth';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Theme } from '../../../../types';
import { StatCard, type StatCardDatum } from '../../../widgets';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';

/** Below this page width the tiles and cards go two to a row instead of three. */
const TWO_COLUMN_BELOW_PX = 560;

/** Infrastructure first, then the two systems that use it. */
const OVERVIEW_PANEL_ORDER = ['library', 'sources', 'gateway', 'system-one', 'system-two'] as const;

/** The icon each panel carries, here and in the Settings sidebar. */
export const MODELS_SETTINGS_PANEL_ICONS: Readonly<Record<ModelsSettingsPanel, LucideIcon>> =
	Object.freeze({
		overview: HardDrive,
		library: HardDrive,
		sources: Server,
		'system-one': Brain,
		'system-two': Sparkles,
		gateway: Router,
	});

export interface ModelsOverviewProps {
	theme: Theme;
	/** The tab's one `useLocalModels()` instance. */
	models: LocalModelsState;
	/** The tab's one `useLocalRuntimes()` instance. */
	runtimes: LocalRuntimesState;
	/** How many model servers the user has added (Sources). */
	endpointCount: number;
	/** Jump to a place in the tab, by sub-tab path (`sources`, `library/speech`). */
	onOpen: (subTab: string) => void;
}

export function ModelsOverview({
	theme,
	models,
	runtimes,
	endpointCount,
	onOpen,
}: ModelsOverviewProps) {
	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const hardware = useLocalModelsHardware();
	const rootRef = useRef<HTMLDivElement>(null);
	const width = useElementWidth(rootRef);
	// Zero before the first measurement (and always in jsdom): three columns.
	const columns = width > 0 && width < TWO_COLUMN_BELOW_PX ? 2 : 3;
	const gridColumns = `repeat(${columns}, minmax(0, 1fr))`;

	const corruptListings = useMemo(
		() => models.listings.filter((listing) => listing.status.status === 'corrupt'),
		[models.listings]
	);

	const tiles = useMemo<StatCardDatum[]>(() => {
		const footprintBytes = models.footprint?.bytes ?? 0;
		const installed = models.listings.filter(
			(listing) => listing.status.status === 'installed'
		).length;
		const enginesReady = runtimes.listings.filter(
			(listing) => listing.installed && !listing.stale
		).length;
		const active = Object.values(resolveLocalModelAssignments(assignments)).filter(
			(assignment) => assignment.type !== 'off'
		).length;
		const memory = hardware.profile ? hardwareProfileStat(hardware.profile) : null;
		return [
			{
				label: 'On disk',
				value: footprintBytes,
				displayValue: formatSize(footprintBytes),
				icon: HardDrive,
				caption: 'Downloaded model files',
			},
			{
				label: 'Installed',
				value: installed,
				icon: CheckCircle2,
				color: theme.colors.success,
				caption: `of ${models.listings.length} models in the Library`,
			},
			{
				label: 'Engines',
				value: enginesReady,
				icon: Cpu,
				caption: `of ${runtimes.listings.length} installed and current`,
			},
			{
				label: 'Active tasks',
				value: active,
				icon: ListChecks,
				caption: `of ${LOCAL_MODEL_TASK_IDS.length} background tasks are on`,
			},
			{
				label: 'Endpoints',
				value: endpointCount,
				icon: Server,
				caption: 'Model servers you added',
			},
			{
				label: 'Memory',
				value: hardware.profile?.totalMemoryBytes ?? 0,
				displayValue: memory?.value ?? '...',
				icon: MemoryStick,
				caption: memory?.caption ?? 'Reading this computer',
			},
		];
	}, [
		models.footprint,
		models.listings,
		runtimes.listings,
		assignments,
		endpointCount,
		hardware.profile,
		theme.colors.success,
	]);

	const fitCaveat = hardware.profile ? hardwareFitCaveat(hardware.profile) : null;
	const firstCorrupt = corruptListings[0];

	return (
		<div ref={rootRef} className="space-y-5 select-none" data-testid="models-overview">
			<div
				className="grid gap-3"
				style={{ gridTemplateColumns: gridColumns }}
				data-testid="models-overview-stats"
			>
				{tiles.map((tile) => (
					<StatCard key={tile.label} theme={theme} {...tile} />
				))}
			</div>

			{firstCorrupt && (
				<button
					type="button"
					onClick={() =>
						onOpen(modelsSettingsSubTab('library', localModelLibrarySection(firstCorrupt.entry)))
					}
					className="w-full flex items-start gap-1.5 text-xs text-left"
					style={{ color: theme.colors.warning }}
					data-testid="models-overview-needs-attention"
				>
					<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
					<span>
						{corruptListings.length === 1
							? `${firstCorrupt.entry.displayName} failed verification.`
							: `${corruptListings.length} models failed verification.`}{' '}
						<span className="underline">
							{corruptListings.length === 1 ? 'Show it in the Library' : 'Open the Library'}
						</span>
					</span>
				</button>
			)}
			{fitCaveat && (
				<div
					className="flex items-start gap-1.5 text-xs select-text"
					style={{ color: theme.colors.warning }}
				>
					<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
					<span>{fitCaveat}</span>
				</div>
			)}

			<div data-setting-id="local-models-overview">
				<SettingsSectionHeading
					icon={HardDrive}
					description={
						<>
							Maestro does small model work beside your agents: it names tabs, writes summaries,
							turns a request into a shell command, screens untrusted text, and more. Each of those
							is a <b>task</b>, and each task can run on a model on this computer, on a model server
							you run, on System One, or on the Utility Agent. An <b>active task</b> is one you have
							given a source; the rest are off and keep their old behavior. Nothing downloads,
							starts, or calls a server until you ask.
						</>
					}
				>
					Models
				</SettingsSectionHeading>
			</div>

			<div>
				<SettingsSectionHeading
					icon={Compass}
					description="Each part of this tab, and what it is for. Click one to go there."
				>
					Where things live
				</SettingsSectionHeading>
				<div
					className="grid gap-3"
					style={{ gridTemplateColumns: `repeat(${columns * 2}, minmax(0, 1fr))` }}
				>
					{OVERVIEW_PANEL_ORDER.map((panel) => {
						const Icon = MODELS_SETTINGS_PANEL_ICONS[panel];
						return (
							<button
								key={panel}
								type="button"
								onClick={() => onOpen(panel)}
								// A button centers its content vertically by default; as a flex
								// column it starts at the top, so cards in one row line up.
								className="group rounded border p-3 flex flex-col items-stretch justify-start text-left transition-colors outline-none focus-visible:ring-2"
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
									gridColumn:
										columns === 2 && panel === 'gateway'
											? '1 / -1'
											: `span ${columns === 3 && panel.startsWith('system-') ? 3 : 2}`,
								}}
								onMouseEnter={(event) => {
									event.currentTarget.style.borderColor = theme.colors.accent;
								}}
								onMouseLeave={(event) => {
									event.currentTarget.style.borderColor = theme.colors.border;
								}}
								aria-label={`Open ${MODELS_SETTINGS_PANEL_LABELS[panel]}`}
								data-testid={`models-overview-panel-${panel}`}
							>
								<span className="flex items-center gap-2 font-medium">
									<Icon className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.accent }} />
									<span>{MODELS_SETTINGS_PANEL_LABELS[panel]}</span>
									<ArrowRight className="w-3.5 h-3.5 ml-auto opacity-0 group-hover:opacity-70 transition-opacity" />
								</span>
								<span className="text-xs opacity-70 mt-1">
									{MODELS_SETTINGS_PANEL_SUMMARIES[panel]}
								</span>
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}
