/**
 * Where model choices live in Settings, for every surface that has to say so.
 *
 * The Models settings tab opens on an Overview (the Models row itself in the
 * Settings sidebar) and has five more panels, drawn as a subtree under it.
 * Library is split again into sections (its own tab strip). The renderer draws both from these ids and labels, and
 * every recovery sentence in the main process, the CLI, and the renderer
 * ("Assign it a model in ...") names its place through `modelsSettingsLocation`
 * or `taskAssignmentLocation`. So a renamed tab or a task that moves between
 * systems is one edit here, not one per message.
 *
 * A place inside the tab is addressed by ONE string, the sub-tab path: a panel
 * id (`gateway`) or a panel and a Library section (`library/speech`). It is
 * what `maestro-cli open settings --tab models --sub-tab` takes, what a Settings
 * search result carries, and what an in-app link passes to `openSettings`.
 */

import {
	LOCAL_MODEL_LIBRARY_SECTIONS,
	LOCAL_MODEL_LIBRARY_SECTION_IDS,
	type LocalModelLibrarySectionId,
} from './library';
import { LOCAL_MODEL_TASKS, type LocalModelSystem, type LocalModelTaskId } from './tasks';

/** The panels of the Models settings tab, in sidebar order. Overview is the Models row itself. */
export const MODELS_SETTINGS_PANELS = [
	'overview',
	'library',
	'sources',
	'system-one',
	'system-two',
	'gateway',
] as const;

export type ModelsSettingsPanel = (typeof MODELS_SETTINGS_PANELS)[number];

/** What each inner tab is called, on its tab and in a sentence. */
export const MODELS_SETTINGS_PANEL_LABELS: Readonly<Record<ModelsSettingsPanel, string>> =
	Object.freeze({
		overview: 'Overview',
		library: 'Library',
		sources: 'Sources',
		'system-one': 'System One',
		'system-two': 'System Two',
		gateway: 'Gateway',
	});

/** The panels listed under Models in the sidebar: every panel but the Overview, which is Models itself. */
export const MODELS_SETTINGS_DETAIL_PANELS: readonly Exclude<ModelsSettingsPanel, 'overview'>[] =
	Object.freeze(
		MODELS_SETTINGS_PANELS.filter(
			(panel): panel is Exclude<ModelsSettingsPanel, 'overview'> => panel !== 'overview'
		)
	);

/** What each detail panel is for, in one sentence: the Overview's guide to the tab. */
export const MODELS_SETTINGS_PANEL_SUMMARIES: Readonly<
	Record<Exclude<ModelsSettingsPanel, 'overview'>, string>
> = Object.freeze({
	library:
		'Models Maestro downloads and runs on this computer, and the engines that run them. Nothing downloads until you press Download.',
	sources:
		"Where models come from besides the Library: model servers you run (Ollama, LM Studio, any OpenAI-compatible URL), Maestro's own model server, and where model files download from.",
	'system-one':
		'Fast judgments: a yes or no, a label, a score, a vector, or a transcript. The Cue gate, prompt-injection and secret screens, voice routing, dictation, semantic search.',
	'system-two':
		'Text for someone to read or run: tab names, summaries, shell commands, pull request drafts, spoken notices. Also the Utility Agent and the tier defaults.',
	gateway:
		"A proxy for an agent's own provider traffic: Headroom, LiteLLM, or Maestro's token proxy, which can compress tool results to save tokens.",
});

/** The Settings tab every model choice lives in, as a sentence names it. */
export const MODELS_SETTINGS_LOCATION = 'Settings > Models';

/** The inner tab that lists one system's tasks. */
export function systemSettingsPanel(system: LocalModelSystem): ModelsSettingsPanel {
	return system === 'one' ? 'system-one' : 'system-two';
}

/** Where inside the Models tab: a panel, and for Library optionally one of its sections. */
export interface ModelsSettingsPlace {
	panel: ModelsSettingsPanel;
	/** A Library section. Only ever set when `panel` is `library`. */
	librarySection?: LocalModelLibrarySectionId;
}

/** The separator between a panel and a Library section in a sub-tab path. */
const SUB_TAB_SEPARATOR = '/';

/** The sub-tab path of a place: `gateway`, or `library/speech`. */
export function modelsSettingsSubTab(
	panel: ModelsSettingsPanel,
	librarySection?: LocalModelLibrarySectionId
): string {
	return panel === 'library' && librarySection
		? `${panel}${SUB_TAB_SEPARATOR}${librarySection}`
		: panel;
}

/** Read a sub-tab path back, or null for one that names no place in the tab. */
export function parseModelsSettingsSubTab(subTab: string): ModelsSettingsPlace | null {
	const [panelId, sectionId, ...rest] = subTab.trim().toLowerCase().split(SUB_TAB_SEPARATOR);
	const panel = MODELS_SETTINGS_PANELS.find((id) => id === panelId);
	if (!panel || rest.length > 0) return null;
	if (sectionId === undefined) return { panel };
	if (panel !== 'library') return null;
	const librarySection = LOCAL_MODEL_LIBRARY_SECTION_IDS.find((id) => id === sectionId);
	return librarySection ? { panel, librarySection } : null;
}

/** Every sub-tab path, in sidebar then strip order: each panel, with Library's sections after it. */
export const MODELS_SETTINGS_SUB_TAB_PATHS: readonly string[] = Object.freeze(
	MODELS_SETTINGS_PANELS.flatMap((panel) => [
		panel,
		...(panel === 'library'
			? LOCAL_MODEL_LIBRARY_SECTION_IDS.map((section) => modelsSettingsSubTab(panel, section))
			: []),
	])
);

/** What a place is called after "Settings > Models": "Library", or "Library > Speech". */
export function modelsSettingsPlaceLabel(
	panel: ModelsSettingsPanel,
	librarySection?: LocalModelLibrarySectionId
): string {
	const panelLabel = MODELS_SETTINGS_PANEL_LABELS[panel];
	return panel === 'library' && librarySection
		? `${panelLabel} > ${LOCAL_MODEL_LIBRARY_SECTIONS[librarySection].label}`
		: panelLabel;
}

/** "Settings > Models > Library", or "Settings > Models > Library > Engines". */
export function modelsSettingsLocation(
	panel: ModelsSettingsPanel,
	librarySection?: LocalModelLibrarySectionId
): string {
	return `${MODELS_SETTINGS_LOCATION} > ${modelsSettingsPlaceLabel(panel, librarySection)}`;
}

/** The inner tab where a person assigns a task its source. */
export function taskAssignmentPanel(taskId: LocalModelTaskId): ModelsSettingsPanel {
	return systemSettingsPanel(LOCAL_MODEL_TASKS[taskId].system);
}

/** Where a person assigns a task its source: "Settings > Models > System One". */
export function taskAssignmentLocation(taskId: LocalModelTaskId): string {
	return modelsSettingsLocation(taskAssignmentPanel(taskId));
}
