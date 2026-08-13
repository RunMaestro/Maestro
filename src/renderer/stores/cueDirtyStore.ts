/**
 * cueDirtyStore - Unified dirty-state for the Cue pipeline editor and YAML editor.
 *
 * Centralises unsaved-change flags so CueModal can read them from one place
 * (via getState()) without prop-drilling through CuePipelineEditor and
 * CueYamlEditor.
 */

import { create } from 'zustand';

interface CueDirtyState {
	pipelineDirty: boolean;
	yamlDirty: boolean;
	/**
	 * True while a pipeline save is in flight. Lets CueModal close without the
	 * unsaved-changes confirmation so the user can dismiss the modal mid-save -
	 * the save promise continues in the background and toasts on completion.
	 * Deliberately NOT cleared by resetAll(): the modal unmounts before the
	 * save resolves, and the persistence hook flips this back to false from
	 * its own finally block once the IPC round-trip lands.
	 */
	pipelineSaving: boolean;
	setPipelineDirty: (dirty: boolean) => void;
	setYamlDirty: (dirty: boolean) => void;
	setPipelineSaving: (saving: boolean) => void;
	isAnyDirty: () => boolean;
	resetAll: () => void;
}

export const useCueDirtyStore = create<CueDirtyState>((set, get) => ({
	pipelineDirty: false,
	yamlDirty: false,
	pipelineSaving: false,
	setPipelineDirty: (dirty) => set({ pipelineDirty: dirty }),
	setYamlDirty: (dirty) => set({ yamlDirty: dirty }),
	setPipelineSaving: (saving) => set({ pipelineSaving: saving }),
	isAnyDirty: () => get().pipelineDirty || get().yamlDirty,
	resetAll: () => set({ pipelineDirty: false, yamlDirty: false }),
}));
