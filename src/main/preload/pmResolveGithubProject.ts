/**
 * Preload API for the pm:resolveGithubProject IPC channel (#447).
 *
 * Exposes window.maestro.pmResolveGithubProject.resolve() so the renderer
 * can look up (or discover) the GitHub project mapping for a project path.
 */

import { ipcRenderer } from 'electron';
import type {
	ResolveGithubProjectInput,
	ResolveGithubProjectResult,
} from '../ipc/handlers/pm-resolve-github-project';

export function createPmResolveGithubProjectApi() {
	return {
		/**
		 * Resolve the GitHub Projects v2 mapping for a project path.
		 * Returns cached result if available; runs discovery otherwise.
		 */
		resolve: (input: ResolveGithubProjectInput): Promise<ResolveGithubProjectResult> =>
			ipcRenderer.invoke('pm:resolveGithubProject', input),
	};
}

export type PmResolveGithubProjectApi = ReturnType<typeof createPmResolveGithubProjectApi>;
