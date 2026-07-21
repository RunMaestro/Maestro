/**
 * Narrowing helpers for values returned by the persisted settings IPC boundary.
 * Invalid values are treated as absent so callers retain their fresh defaults.
 */

export type PersistedSettings = Readonly<Record<string, unknown>>;

export function readString(settings: PersistedSettings, key: string): string | undefined {
	const value = settings[key];
	return typeof value === 'string' ? value : undefined;
}

export function readBoolean(settings: PersistedSettings, key: string): boolean | undefined {
	const value = settings[key];
	return typeof value === 'boolean' ? value : undefined;
}

export function readFiniteNumber(settings: PersistedSettings, key: string): number | undefined {
	const value = settings[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readStringArray(settings: PersistedSettings, key: string): string[] | undefined {
	const value = settings[key];
	return Array.isArray(value) && value.every((item) => typeof item === 'string')
		? value
		: undefined;
}
