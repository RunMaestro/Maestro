/**
 * cueDirtyStore — Unified dirty-state for the Cue pipeline editor and YAML editor.
 *
 * Centralises unsaved-change flags so CueModal can read them from one place
 * (via getState()) without prop-drilling through CuePipelineEditor and
 * CueYamlEditor.
 */

import { create } from 'zustand';

interface CueDirtyState {
	pipelineDirty: boolean;
	yamlDirty: boolean;
	setPipelineDirty: (dirty: boolean) => void;
	setYamlDirty: (dirty: boolean) => void;
	isAnyDirty: () => boolean;
	resetAll: () => void;
}

export const useCueDirtyStore = create<CueDirtyState>((set, get) => ({
	pipelineDirty: false,
	yamlDirty: false,
	setPipelineDirty: (dirty) => set({ pipelineDirty: dirty }),
	setYamlDirty: (dirty) => set({ yamlDirty: dirty }),
	isAnyDirty: () => get().pipelineDirty || get().yamlDirty,
	resetAll: () => set({ pipelineDirty: false, yamlDirty: false }),
}));
