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
import type {
	PianolaDecisionRecord,
	RulesLoadResult,
	PianolaSupervisedTarget,
	PianolaSuggestionsFile,
} from '../../shared/pianola/storage';
import type { PianolaSupervisorSnapshot } from '../ipc/handlers/pianola';

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

		/** Read the staged learning suggestions (rule proposals + profile draft). */
		getSuggestions: (): Promise<PianolaSuggestionsFile> =>
			ipcRenderer.invoke('pianola:get-suggestions'),

		/** Approve a suggestion: persist a rule and/or a profile draft. Returns updated rules. */
		applySuggestion: (payload: {
			rule?: PianolaRule;
			profile?: { text: string; projectPath?: string };
		}): Promise<{ rules: PianolaRule[] }> =>
			ipcRenderer.invoke('pianola:apply-suggestion', payload),

		/**
		 * Control the desktop supervised daemon (the watchers and orchestrations the
		 * app keeps alive across crashes and restarts). Every channel returns a fresh
		 * snapshot of persisted targets plus their live health.
		 */
		supervisor: {
			/** List persisted supervised targets and their current health. */
			list: (): Promise<PianolaSupervisorSnapshot> => ipcRenderer.invoke('pianola:supervisor-list'),
			/** Register a supervised target (id/createdAt filled in when omitted). */
			add: (target: Partial<PianolaSupervisedTarget>): Promise<PianolaSupervisorSnapshot> =>
				ipcRenderer.invoke('pianola:supervisor-add', target),
			/** Enable or disable a target by id; the daemon reconciles immediately. */
			setEnabled: (id: string, enabled: boolean): Promise<PianolaSupervisorSnapshot> =>
				ipcRenderer.invoke('pianola:supervisor-set-enabled', id, enabled),
			/** Remove a target by id; the daemon stops its child if running. */
			remove: (id: string): Promise<PianolaSupervisorSnapshot> =>
				ipcRenderer.invoke('pianola:supervisor-remove', id),
		},
	};
}

export type PianolaApi = ReturnType<typeof createPianolaApi>;
