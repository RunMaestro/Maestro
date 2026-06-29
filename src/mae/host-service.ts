// Builds the bridge `BridgeHandlers` from injected Maestro service callbacks,
// using the pure mappers. This is the complete W2 (real ecosystem) + W3 (session
// ingest) binding logic, decoupled from Electron so it stays unit-testable: the
// desktop entry constructs `MaeHostDeps` from the real services (sessions store,
// CueEngine, Electron Notification, renderer push) and passes it here, then
// hands the result to `startBridgeHost`.

import type { BridgeHandlers } from './bridge-core';
import {
	type CueGraphSessionLike,
	type CueRunResultLike,
	type PlaybookFileLike,
	type StoredSessionLike,
	mergePlaybooks,
	toCueEntries,
	toSessionList,
} from './host-mappers';
import type { SessionEndParams, SessionEventParams, SessionRegisterParams } from './protocol';

export interface MaeHostDeps {
	// Read sources (raw Maestro shapes; mapped to bridge metadata here).
	getStoredSessions(): StoredSessionLike[] | Promise<StoredSessionLike[]>;
	getPlaybookFiles():
		| { playbooks?: PlaybookFileLike[] }[]
		| Promise<{ playbooks?: PlaybookFileLike[] }[]>;
	getCueGraph(): CueGraphSessionLike[];
	getCueActivity(): CueRunResultLike[];
	// Effects.
	showToast(title: string, message: string): void | Promise<void>;
	// Session ingest -> push to the renderer (so the GUI tracks the run live).
	onSessionRegister(params: SessionRegisterParams): void | Promise<void>;
	onSessionEvent(params: SessionEventParams): void | Promise<void>;
	onSessionEnd(params: SessionEndParams): void | Promise<void>;
}

export function createMaeHandlers(deps: MaeHostDeps): BridgeHandlers {
	return {
		listSessions: async () => toSessionList(await deps.getStoredSessions()),
		listPlaybooks: async () => mergePlaybooks(await deps.getPlaybookFiles()),
		observeCues: async () => toCueEntries(deps.getCueGraph(), deps.getCueActivity()),
		toast: async (params) => {
			await deps.showToast(params.title, params.message);
		},
		registerSession: async (params) => {
			await deps.onSessionRegister(params);
		},
		recordEvent: async (params) => {
			await deps.onSessionEvent(params);
		},
		endSession: async (params) => {
			await deps.onSessionEnd(params);
		},
	};
}
