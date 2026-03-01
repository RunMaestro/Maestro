/**
 * Filter matching engine for Maestro Cue event payload filtering.
 *
 * Evaluates filter expressions against event payloads. Supports exact match,
 * negation, numeric comparison, glob patterns, and boolean matching.
 * All filter conditions are AND'd — every condition must pass.
 */

import picomatch from 'picomatch';

/**
 * Resolve a dot-notation key to a value in a nested object.
 * e.g., "source.status" accesses payload.source.status
 */
function resolveKey(obj: Record<string, unknown>, key: string): unknown {
	return key.split('.').reduce<unknown>((acc, part) => {
		if (acc !== null && acc !== undefined && typeof acc === 'object') {
			return (acc as Record<string, unknown>)[part];
		}
		return undefined;
	}, obj);
}

/**
 * Returns true if the payload matches ALL filter conditions.
 * Each filter key is a payload field name (supports dot-notation for nested access).
 * Each filter value is an expression evaluated against the payload field.
 */
export function matchesFilter(
	payload: Record<string, unknown>,
	filter: Record<string, string | number | boolean>
): boolean {
	for (const [key, filterValue] of Object.entries(filter)) {
		const payloadValue = resolveKey(payload, key);

		// Field must exist
		if (payloadValue === undefined) return false;

		if (typeof filterValue === 'boolean') {
			if (payloadValue !== filterValue) return false;
		} else if (typeof filterValue === 'number') {
			if (payloadValue !== filterValue) return false;
		} else {
			// String filter expression
			if (filterValue.startsWith('>=')) {
				const threshold = Number(filterValue.slice(2));
				if (Number(payloadValue) < threshold) return false;
			} else if (filterValue.startsWith('<=')) {
				const threshold = Number(filterValue.slice(2));
				if (Number(payloadValue) > threshold) return false;
			} else if (filterValue.startsWith('>')) {
				const threshold = Number(filterValue.slice(1));
				if (Number(payloadValue) <= threshold) return false;
			} else if (filterValue.startsWith('<')) {
				const threshold = Number(filterValue.slice(1));
				if (Number(payloadValue) >= threshold) return false;
			} else if (filterValue.startsWith('!')) {
				const remainder = filterValue.slice(1);
				if (String(payloadValue) === remainder) return false;
			} else if (filterValue.includes('*')) {
				const isMatch = picomatch(filterValue);
				if (!isMatch(String(payloadValue))) return false;
			} else {
				// Plain string — exact match
				if (String(payloadValue) !== filterValue) return false;
			}
		}
	}

	return true;
}

/**
 * Returns a human-readable description of a filter for logging.
 * e.g., 'path matches *.ts AND status != archived'
 */
export function describeFilter(filter: Record<string, string | number | boolean>): string {
	const parts: string[] = [];

	for (const [key, value] of Object.entries(filter)) {
		if (typeof value === 'boolean') {
			parts.push(`${key} is ${value}`);
		} else if (typeof value === 'number') {
			parts.push(`${key} == ${value}`);
		} else if (value.startsWith('>=')) {
			parts.push(`${key} >= ${value.slice(2)}`);
		} else if (value.startsWith('<=')) {
			parts.push(`${key} <= ${value.slice(2)}`);
		} else if (value.startsWith('>')) {
			parts.push(`${key} > ${value.slice(1)}`);
		} else if (value.startsWith('<')) {
			parts.push(`${key} < ${value.slice(1)}`);
		} else if (value.startsWith('!')) {
			parts.push(`${key} != ${value.slice(1)}`);
		} else if (value.includes('*')) {
			parts.push(`${key} matches ${value}`);
		} else {
			parts.push(`${key} == "${value}"`);
		}
	}

	return parts.join(' AND ');
}
