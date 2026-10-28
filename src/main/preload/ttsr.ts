/** TTSR matching and rule management; corrections use the native Steer queue. */

import { ipcRenderer } from 'electron';
import type {
	TtsrSteeringClaim,
	TtsrMatchedPayload,
	TtsrProjectSettings,
	TtsrRuleListResult,
	TtsrRulesChangedPayload,
	TtsrRuleValidation,
	TtsrTriggeredPayload,
} from '../../shared/ttsr-types';

export type {
	TtsrSteeringClaim,
	TtsrMatchedPayload,
	TtsrProjectSettings,
	TtsrRule,
	TtsrRuleListResult,
	TtsrRuleRef,
	TtsrRulesChangedPayload,
	TtsrRuleValidation,
	TtsrTriggeredPayload,
} from '../../shared/ttsr-types';

/**
 * Creates the TTSR API object for preload exposure.
 */
export function createTtsrApi() {
	return {
		onTriggered: (callback: (payload: TtsrTriggeredPayload) => void): (() => void) => {
			const handler = (_e: unknown, payload: TtsrTriggeredPayload) => callback(payload);
			ipcRenderer.on('ttsr:triggered', handler);
			return () => ipcRenderer.removeListener('ttsr:triggered', handler);
		},

		// Observability: a rule matched. Non-interrupting matches only ever
		// surface here (they become deferred reminders on the next prompt).
		onMatched: (callback: (payload: TtsrMatchedPayload) => void): (() => void) => {
			const handler = (_e: unknown, payload: TtsrMatchedPayload) => callback(payload);
			ipcRenderer.on('ttsr:matched', handler);
			return () => {
				ipcRenderer.removeListener('ttsr:matched', handler);
			};
		},

		// A project's rules changed on disk (or through the handlers below), so
		// anything showing them has to re-list.
		onRulesChanged: (callback: (payload: TtsrRulesChangedPayload) => void): (() => void) => {
			const handler = (_e: unknown, payload: TtsrRulesChangedPayload) => callback(payload);
			ipcRenderer.on('ttsr:rulesChanged', handler);
			return () => {
				ipcRenderer.removeListener('ttsr:rulesChanged', handler);
			};
		},

		claimSteeringRequest: (request: TtsrSteeringClaim): Promise<boolean> =>
			ipcRenderer.invoke('ttsr:claimSteeringRequest', request),

		// ── Rule management (project-scoped; every call names its project) ──

		listRules: (projectRoot: string): Promise<TtsrRuleListResult> =>
			ipcRenderer.invoke('ttsr:listRules', { projectRoot }),

		readRule: (projectRoot: string, path: string): Promise<string | null> =>
			ipcRenderer.invoke('ttsr:readRule', { projectRoot, path }),

		writeRule: (projectRoot: string, path: string, content: string): Promise<{ path: string }> =>
			ipcRenderer.invoke('ttsr:writeRule', { projectRoot, path, content }),

		deleteRule: (projectRoot: string, path: string): Promise<{ deleted: boolean }> =>
			ipcRenderer.invoke('ttsr:deleteRule', { projectRoot, path }),

		validateRule: (content: string, path?: string): Promise<TtsrRuleValidation> =>
			ipcRenderer.invoke('ttsr:validateRule', { content, path }),

		readProjectSettings: (projectRoot: string): Promise<TtsrProjectSettings> =>
			ipcRenderer.invoke('ttsr:readProjectSettings', { projectRoot }),

		writeProjectSettings: (
			projectRoot: string,
			settings: Partial<TtsrProjectSettings>
		): Promise<{ path: string }> =>
			ipcRenderer.invoke('ttsr:writeProjectSettings', { projectRoot, settings }),
	};
}

export type TtsrApi = ReturnType<typeof createTtsrApi>;
