import { useEffect, useState } from 'react';
import { EMPTY_KNOWN_ENV_VAR_KEYS, type KnownEnvVarKeys } from '../../../shared/envVarCatalog';

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isKnownEnvVarKeys(value: unknown): value is KnownEnvVarKeys {
	if (!value || typeof value !== 'object') return false;
	if (!('byProvider' in value) || !('global' in value)) return false;
	if (!isStringArray(value.global)) return false;
	const byProvider = value.byProvider;
	if (!byProvider || typeof byProvider !== 'object') return false;
	return Object.values(byProvider).every(isStringArray);
}

/**
 * Env-var names the user has already set, for the editors' name suggestions.
 *
 * Read once per mount: names change only when someone edits an env var, and the
 * editor doing that already has the row in front of it.
 */
export function useKnownEnvVarKeys(enabled = true): KnownEnvVarKeys {
	const [knownEnvVarKeys, setKnownEnvVarKeys] = useState<KnownEnvVarKeys>(EMPTY_KNOWN_ENV_VAR_KEYS);

	useEffect(() => {
		if (!enabled) {
			setKnownEnvVarKeys(EMPTY_KNOWN_ENV_VAR_KEYS);
			return;
		}
		const getKnownEnvVarKeys = window.maestro?.agents?.getKnownEnvVarKeys;
		if (!getKnownEnvVarKeys) return;

		let cancelled = false;
		void getKnownEnvVarKeys()
			.then((keys) => {
				if (!cancelled && isKnownEnvVarKeys(keys)) {
					setKnownEnvVarKeys(keys);
				}
			})
			.catch(() => {
				// Name suggestions are optional; typing a name by hand still works.
			});
		return () => {
			cancelled = true;
		};
	}, [enabled]);

	return knownEnvVarKeys;
}
