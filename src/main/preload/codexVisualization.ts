/**
 * Preload API for Codex `visualize` content references.
 */

import { ipcRenderer } from 'electron';
import type {
	CodexVisualizationLoadRequest,
	CodexVisualizationLoadResult,
} from '../../shared/codexVisualization';

export function createCodexVisualizationApi() {
	return {
		/** Build and register the isolated document for one visualization. */
		load: (request: CodexVisualizationLoadRequest): Promise<CodexVisualizationLoadResult> =>
			ipcRenderer.invoke('codexVisualization:load', request),
	};
}

export type CodexVisualizationApi = ReturnType<typeof createCodexVisualizationApi>;
