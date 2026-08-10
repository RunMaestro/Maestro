/**
 * Preload API for the Context Timeline capture log.
 *
 * Exposes `window.maestro.contextTimeline`. Backed by the IPC handlers in
 * `src/main/ipc/handlers/context-timeline.ts`.
 *
 * Web-desktop gets this for free: the browser build imports this very preload
 * index (`src/web-desktop/bootstrap.ts`), and the electron shim turns
 * `ipcRenderer.invoke` into a `bridge.invoke` frame that main dispatches to the
 * registered handler. There is no hand-maintained second surface to mirror.
 */

import { ipcRenderer } from 'electron';
import type { UsageStats } from '../../shared/types';

/** One raw usage capture as main recorded it. */
export interface ContextTimelineCapture {
	seq: number;
	timestamp: number;
	sessionId: string;
	usageStats: UsageStats;
}

export interface ContextTimelineCapturesResponse {
	success: boolean;
	captures?: ContextTimelineCapture[];
	trimmed?: boolean;
	error?: string;
}

export function createContextTimelineApi() {
	return {
		/** Every raw usage capture main holds for an agent (base) session. */
		getCaptures: (sessionId: string | null): Promise<ContextTimelineCapturesResponse> =>
			ipcRenderer.invoke('contextTimeline:getCaptures', sessionId),

		/** Drop main's captures for an agent - on Clear, and when the agent is deleted. */
		clearCaptures: (sessionId: string | null): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('contextTimeline:clearCaptures', sessionId),
	};
}

export type ContextTimelineApi = ReturnType<typeof createContextTimelineApi>;
