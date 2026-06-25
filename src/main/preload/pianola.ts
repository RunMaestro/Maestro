/**
 * Preload API for Pianola (autonomous manager agent).
 *
 * Provides the window.maestro.pianola namespace for managing auto-answer rules
 * and reading the decision audit log. All channels are gated in the main
 * process on the `pianola` Encore flag; when it is off they reject with
 * 'PianolaDisabled', which callers treat as "feature off".
 */

import { ipcRenderer } from 'electron';
import type { PianolaRule } from '../../shared/pianola/types';
import type { PianolaDecisionRecord, RulesLoadResult } from '../../shared/pianola/storage';

/**
 * Creates the Pianola API object for contextBridge exposure.
 */
export function createPianolaApi() {
	return {
		/**
		 * Read auto-answer rules. Returns { rules, malformed }: `malformed` is true
		 * when the rules file exists but is unparseable, so the UI can warn instead
		 * of silently showing "no rules" (and risking an overwrite).
		 */
		getRules: (): Promise<RulesLoadResult> => ipcRenderer.invoke('pianola:get-rules'),

		/** Persist the full rules list. Returns the validated, saved rules. */
		saveRules: (rules: PianolaRule[]): Promise<PianolaRule[]> =>
			ipcRenderer.invoke('pianola:save-rules', rules),

		/**
		 * Read recent decision audit records (most recent last). Pass a limit to
		 * tail the log; omit it for the full history.
		 */
		getDecisions: (limit?: number): Promise<PianolaDecisionRecord[]> =>
			ipcRenderer.invoke('pianola:get-decisions', limit),
	};
}

export type PianolaApi = ReturnType<typeof createPianolaApi>;
