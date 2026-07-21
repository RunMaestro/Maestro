import * as path from 'node:path';

export type CliEnvironment = Readonly<Record<string, string | undefined>>;

export interface ConfigDirectoryOptions {
	platform: NodeJS.Platform | string;
	home: string;
	cwd: string;
	appName: string;
	userDataKey?: string;
}

/**
 * Resolves the CLI's Electron-store directory from explicit runtime inputs.
 * Environment lookup remains at the caller boundary so this stays testable.
 */
export function resolveCliConfigDirectory(
	env: CliEnvironment,
	{ platform, home, cwd, appName, userDataKey }: ConfigDirectoryOptions
): string {
	const userData = userDataKey ? env[userDataKey] : undefined;
	if (userData) return path.resolve(cwd, userData);

	if (platform === 'darwin') {
		return path.join(home, 'Library', 'Application Support', appName);
	}

	if (platform === 'win32') {
		return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), appName);
	}

	return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), appName);
}

/** Parses accepted CLI boolean spellings without evaluating caller input. */
export function parseEnvironmentBoolean(value: string, flag: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
	if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
	throw new Error(`${flag} expects true or false, got "${value}"`);
}

/** Preserves the existing create-agent integer coercion and diagnostic. */
export function parsePositiveInteger(value: string, flag: string): number {
	const parsed = parseInt(value, 10);
	if (isNaN(parsed) || parsed < 1) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return parsed;
}

/** Parses repeatable `KEY=VALUE` flags as literal data, never as shell syntax. */
export function parseEnvironmentAssignments(entries: readonly string[]): Record<string, string> {
	const assignments: Record<string, string> = {};
	for (const entry of entries) {
		const separator = entry.indexOf('=');
		if (separator === -1) {
			throw new Error(`Invalid --env format "${entry}". Expected KEY=VALUE`);
		}
		assignments[entry.slice(0, separator)] = entry.slice(separator + 1);
	}
	return assignments;
}
