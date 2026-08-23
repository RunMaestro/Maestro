/**
 * useEnvVarSuggestions
 *
 * Fetches the env var name / value suggestion sets that back the dropdowns in
 * `EnvVarsEditor` and the per-agent config panel. Replaces `useKnownAuthDirs`,
 * which could only describe two hard-coded account-dir variables.
 *
 * Fetched once per mount rather than subscribed: the underlying data changes
 * only when the user edits agent or global settings, and a suggestion list
 * that lags by one modal open costs nothing (the field is free text either
 * way). Every failure resolves to the empty set, so a broken IPC degrades to
 * plain text inputs rather than blocking the editor.
 */

import { useEffect, useState } from 'react';
import {
	EMPTY_ENV_VAR_SUGGESTIONS,
	type EnvVarSuggestions,
} from '../../../shared/envVarSuggestions';

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isEnvVarSuggestions(value: unknown): value is EnvVarSuggestions {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	if (!isStringArray(candidate.keys)) return false;
	if (!candidate.valuesByKey || typeof candidate.valuesByKey !== 'object') return false;
	return Object.values(candidate.valuesByKey as Record<string, unknown>).every(isStringArray);
}

/**
 * @param enabled Pass false to suppress the fetch and return the empty set -
 *   used for SSH-remote agents, whose paths name directories on another host,
 *   so suggesting local ones would point the agent at something absent.
 */
export function useEnvVarSuggestions(enabled = true): EnvVarSuggestions {
	const [suggestions, setSuggestions] = useState<EnvVarSuggestions>(EMPTY_ENV_VAR_SUGGESTIONS);

	useEffect(() => {
		if (!enabled) {
			setSuggestions(EMPTY_ENV_VAR_SUGGESTIONS);
			return;
		}
		const fetchSuggestions = window.maestro?.agents?.getEnvVarSuggestions;
		if (!fetchSuggestions) return;

		let cancelled = false;
		void fetchSuggestions()
			.then((next) => {
				if (!cancelled && isEnvVarSuggestions(next)) {
					setSuggestions(next);
				}
			})
			.catch(() => {
				// Suggestions are optional; manual entry remains available.
			});
		return () => {
			cancelled = true;
		};
	}, [enabled]);

	return suggestions;
}
