/**
 * Preload API for the User Journey log (`window.maestro.journey`).
 *
 * Mirrors the `journey:*` channels in `src/main/ipc/handlers/journey.ts`.
 * Renderer code records through `recordJourney()` in
 * `src/renderer/services/userJourney.ts`, never through `append` directly:
 * the service stamps the time and SSH remote and keeps a failed write out of
 * the UI.
 */

import { ipcRenderer } from 'electron';
import type { UserJourneyEntry, UserJourneyKind } from '../../shared/userJourney';

export interface JourneyReadOptions {
	/** Only entries with `ts >= since` (epoch ms). */
	since?: number;
	/** Only the newest N entries (after the other filters). */
	tail?: number;
	/** Only these kinds. */
	kinds?: UserJourneyKind[];
}

export interface JourneyApi {
	/** Append one entry. Resolves true when a line was written (false when collapsed or malformed). */
	append: (entry: UserJourneyEntry) => Promise<boolean>;
	/** An agent's journey, oldest first. */
	read: (agentId: string, options?: JourneyReadOptions) => Promise<UserJourneyEntry[]>;
	/** Absolute path of the agent's journey file. */
	getPath: (agentId: string) => Promise<string>;
}

export function createJourneyApi(): JourneyApi {
	return {
		append: (entry) => ipcRenderer.invoke('journey:append', entry),
		read: (agentId, options) => ipcRenderer.invoke('journey:read', agentId, options),
		getPath: (agentId) => ipcRenderer.invoke('journey:path', agentId),
	};
}
