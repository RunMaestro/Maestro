/**
 * Codex visualization IPC: build and register the isolated document for one
 * `visualize` content reference. The renderer gets back an id and revision and
 * loads the document through the Concerto scheme (or the web route).
 */

import { ipcMain } from 'electron';
import { loadCodexVisualization } from '../../codex-visualization';
import type {
	CodexVisualizationLoadRequest,
	CodexVisualizationLoadResult,
} from '../../../shared/codexVisualization';

export function registerCodexVisualizationHandlers(): void {
	ipcMain.handle(
		'codexVisualization:load',
		async (_event, request: CodexVisualizationLoadRequest): Promise<CodexVisualizationLoadResult> =>
			loadCodexVisualization(request)
	);
}
