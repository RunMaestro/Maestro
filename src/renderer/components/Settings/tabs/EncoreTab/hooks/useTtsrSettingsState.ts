import { useCallback, useState } from 'react';
import type { TtsrSettingsState } from '../types';

interface UseTtsrSettingsStateOptions {
	ttsrDisabledRules: string[];
	setTtsrDisabledRules: (value: string[]) => void;
}

/**
 * Draft state for the TTSR disabled-rule list. The rule names themselves are a
 * plain global setting (persisted immediately by the settings store), so this
 * hook only owns the "type a name, press Add" buffer + validation.
 */
export function useTtsrSettingsState({
	ttsrDisabledRules,
	setTtsrDisabledRules,
}: UseTtsrSettingsStateOptions): TtsrSettingsState {
	const [newDisabledRule, setNewDisabledRule] = useState('');
	const [disabledRuleError, setDisabledRuleError] = useState<string | null>(null);

	const addDisabledRule = useCallback(() => {
		const name = newDisabledRule.trim();
		if (!name) return;
		if (ttsrDisabledRules.includes(name)) {
			setDisabledRuleError('That rule is already disabled.');
			return;
		}
		setDisabledRuleError(null);
		setNewDisabledRule('');
		setTtsrDisabledRules([...ttsrDisabledRules, name]);
	}, [newDisabledRule, setTtsrDisabledRules, ttsrDisabledRules]);

	const removeDisabledRule = useCallback(
		(name: string) => {
			setDisabledRuleError(null);
			setTtsrDisabledRules(ttsrDisabledRules.filter((rule) => rule !== name));
		},
		[setTtsrDisabledRules, ttsrDisabledRules]
	);

	const updateNewDisabledRule = useCallback((value: string) => {
		setNewDisabledRule(value);
		setDisabledRuleError(null);
	}, []);

	return {
		newDisabledRule,
		disabledRuleError,
		setNewDisabledRule: updateNewDisabledRule,
		addDisabledRule,
		removeDisabledRule,
	};
}
