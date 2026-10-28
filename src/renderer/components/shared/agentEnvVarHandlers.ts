/**
 * agentEnvVarHandlers - the `<AgentEnvVarsSection>` callbacks for a form that
 * keeps an agent's environment as two flat records: the live variables and the
 * parked ones.
 *
 * Edit Agent and the Group Chat moderator both hold that pair, and both hand
 * the same handlers to two places: `<AgentConfigPanel hideEnvVars>` on the
 * Provider tab and `<EnvironmentTab>`. Each edit lands in the record the row
 * lives in (the trailing `enabled` argument says which), and a toggle moves the
 * row between the records with its value intact, so a key is never in both.
 *
 * New Agent keeps one environment per provider and has no parked rows, so it
 * keeps its own handlers.
 */

import type { Dispatch, SetStateAction } from 'react';
import { withBlankEnvVarRow } from '../../../shared/envVarCatalog';
import type { AgentEnvVarsSectionProps } from './AgentEnvVarsSection';

type EnvVarRecord = Record<string, string>;

export interface AgentEnvVarRecords {
	customEnvVars: EnvVarRecord;
	customEnvVarsDisabled: EnvVarRecord;
	setCustomEnvVars: Dispatch<SetStateAction<EnvVarRecord>>;
	setCustomEnvVarsDisabled: Dispatch<SetStateAction<EnvVarRecord>>;
}

export type AgentEnvVarHandlers = Pick<
	AgentEnvVarsSectionProps,
	| 'customEnvVars'
	| 'customEnvVarsDisabled'
	| 'onEnvVarToggle'
	| 'onEnvVarKeyChange'
	| 'onEnvVarValueChange'
	| 'onEnvVarRemove'
	| 'onEnvVarAdd'
	| 'onEnvVarsBlur'
	| 'onEnvVarsReplace'
>;

/**
 * The section's records and callbacks over `records`. The form saves both
 * records on its own Save, so blur does nothing.
 */
export function agentEnvVarHandlers({
	customEnvVars,
	customEnvVarsDisabled,
	setCustomEnvVars,
	setCustomEnvVarsDisabled,
}: AgentEnvVarRecords): AgentEnvVarHandlers {
	const setterFor = (enabled?: boolean) =>
		enabled === false ? setCustomEnvVarsDisabled : setCustomEnvVars;

	return {
		customEnvVars,
		customEnvVarsDisabled,
		onEnvVarToggle: (key, nextEnabled) => {
			// Move the var between the two records, value intact.
			const from = nextEnabled ? customEnvVarsDisabled : customEnvVars;
			const value = from[key] ?? '';
			setterFor(!nextEnabled)((prev) => {
				const remaining = { ...prev };
				delete remaining[key];
				return remaining;
			});
			setterFor(nextEnabled)((prev) => ({ ...prev, [key]: value }));
		},
		onEnvVarKeyChange: (oldKey, newKey, value, enabled) => {
			setterFor(enabled)((prev) => {
				const next = { ...prev };
				delete next[oldKey];
				next[newKey] = value;
				return next;
			});
		},
		onEnvVarValueChange: (key, value, enabled) => {
			setterFor(enabled)((prev) => ({ ...prev, [key]: value }));
		},
		onEnvVarRemove: (key, enabled) => {
			setterFor(enabled)((prev) => {
				const next = { ...prev };
				delete next[key];
				return next;
			});
		},
		onEnvVarAdd: () => {
			setCustomEnvVars((prev) => withBlankEnvVarRow(prev));
		},
		onEnvVarsReplace: (vars, disabledVars) => {
			setCustomEnvVars(vars);
			setCustomEnvVarsDisabled(disabledVars);
		},
		onEnvVarsBlur: () => {
			/* Saved on the form's Save */
		},
	};
}
