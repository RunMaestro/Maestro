/**
 * Coerce a positional settings CLI argument without changing legacy command semantics.
 */
export function parseSettingsCliValue(input: string): unknown {
	if (input === 'true') return true;
	if (input === 'false') return false;
	if (input === 'null') return null;

	// Do not turn empty strings or identifier-like leading-zero values into numbers.
	if (input !== '' && !/^0\d/.test(input)) {
		const numberValue = Number(input);
		if (!Number.isNaN(numberValue) && Number.isFinite(numberValue)) return numberValue;
	}

	if (input.startsWith('[') || input.startsWith('{')) {
		try {
			return JSON.parse(input);
		} catch {
			// Preserve malformed JSON as a string unless the caller explicitly requested --raw.
		}
	}

	return input;
}
