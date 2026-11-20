/**
 * useModelsSettingsNav - where the user is inside Settings > Models: which
 * panel (Overview, Library, Sources, System One, System Two, Gateway) and which
 * Library section (Engines, Agent Models, Housekeeping, ...).
 *
 * `SettingsModal` owns the one instance, because two surfaces read it: the
 * sidebar draws the panels as a subtree under Models, and `ModelsSettingsTab`
 * draws the open panel and the Library's section strip. Both picks are
 * remembered across opens, and a deep link or a search result moves them
 * through `open`, which takes the same sub-tab path `maestro-cli open settings
 * --tab models --sub-tab` does (`gateway`, `library/speech`).
 */

import { useCallback, useMemo } from 'react';
import {
	LOCAL_MODEL_LIBRARY_SECTION_IDS,
	type LocalModelLibrarySectionId,
} from '../../../../../shared/local-models/library';
import {
	MODELS_SETTINGS_PANELS,
	parseModelsSettingsSubTab,
	type ModelsSettingsPanel,
} from '../../../../../shared/local-models/settings-location';
import { usePersistedChoice } from '../../../../hooks/ui/usePersistedChoice';

/** localStorage key for the last panel the user opened. */
export const MODELS_SETTINGS_PANEL_STORAGE_KEY = 'settings.models.panel';

/** localStorage key for the last Library section the user opened. */
export const MODELS_LIBRARY_SECTION_STORAGE_KEY = 'settings.models.librarySection';

export interface ModelsSettingsNav {
	panel: ModelsSettingsPanel;
	setPanel: (panel: ModelsSettingsPanel) => void;
	librarySection: LocalModelLibrarySectionId;
	setLibrarySection: (section: LocalModelLibrarySectionId) => void;
	/**
	 * Move to a sub-tab path (`gateway`, `library/speech`). A bare `library`
	 * keeps the remembered section. Returns false, and moves nothing, for a
	 * path that names no place in the tab.
	 */
	open: (subTab: string) => boolean;
}

export function useModelsSettingsNav(): ModelsSettingsNav {
	const { value: panel, setValue: setPanel } = usePersistedChoice<ModelsSettingsPanel>(
		MODELS_SETTINGS_PANEL_STORAGE_KEY,
		MODELS_SETTINGS_PANELS,
		'overview'
	);
	const { value: librarySection, setValue: setLibrarySection } =
		usePersistedChoice<LocalModelLibrarySectionId>(
			MODELS_LIBRARY_SECTION_STORAGE_KEY,
			LOCAL_MODEL_LIBRARY_SECTION_IDS,
			LOCAL_MODEL_LIBRARY_SECTION_IDS[0]
		);

	const open = useCallback(
		(subTab: string) => {
			const place = parseModelsSettingsSubTab(subTab);
			if (!place) return false;
			setPanel(place.panel);
			if (place.librarySection) setLibrarySection(place.librarySection);
			return true;
		},
		[setPanel, setLibrarySection]
	);

	return useMemo(
		() => ({ panel, setPanel, librarySection, setLibrarySection, open }),
		[panel, setPanel, librarySection, setLibrarySection, open]
	);
}
