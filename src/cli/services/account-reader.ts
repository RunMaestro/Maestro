// CLI-compatible account reader
// Reads account data directly from the filesystem since CLI runs outside Electron

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AccountProfile, AccountStatus } from '../../shared/account-types';
import type { AccountStoreData } from '../../main/stores/account-store-types';

export interface CLIAccountInfo {
	id: string;
	name: string;
	email: string;
	configDir: string;
	status: AccountStatus;
	isDefault: boolean;
}

/**
 * Get possible paths for the Maestro accounts store file.
 * electron-store may use either capitalized or lowercase directory name
 * depending on platform and configuration.
 */
function getAccountStorePaths(): string[] {
	const platform = os.platform();
	const home = os.homedir();
	const paths: string[] = [];

	if (platform === 'darwin') {
		paths.push(path.join(home, 'Library', 'Application Support', 'Maestro', 'maestro-accounts.json'));
		paths.push(path.join(home, 'Library', 'Application Support', 'maestro', 'maestro-accounts.json'));
	} else if (platform === 'win32') {
		const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
		paths.push(path.join(appData, 'Maestro', 'maestro-accounts.json'));
		paths.push(path.join(appData, 'maestro', 'maestro-accounts.json'));
	} else {
		const configBase = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
		paths.push(path.join(configBase, 'Maestro', 'maestro-accounts.json'));
		paths.push(path.join(configBase, 'maestro', 'maestro-accounts.json'));
	}

	return paths;
}

/**
 * Convert an AccountProfile from the store into a CLIAccountInfo.
 */
function profileToCliInfo(profile: AccountProfile): CLIAccountInfo {
	return {
		id: profile.id,
		name: profile.name,
		email: profile.email || '',
		configDir: profile.configDir,
		status: profile.status || 'active',
		isDefault: profile.isDefault || false,
	};
}

/**
 * Read account profiles from the Maestro electron-store JSON file.
 * Falls back to filesystem discovery if the store file doesn't exist.
 */
export async function readAccountsFromStore(): Promise<CLIAccountInfo[]> {
	const storePaths = getAccountStorePaths();

	for (const storePath of storePaths) {
		try {
			const content = fs.readFileSync(storePath, 'utf-8');
			const store: AccountStoreData = JSON.parse(content);
			const accounts: CLIAccountInfo[] = [];

			if (store.accounts && typeof store.accounts === 'object') {
				for (const profile of Object.values(store.accounts)) {
					accounts.push(profileToCliInfo(profile));
				}
			}

			return accounts;
		} catch {
			// Try next path
			continue;
		}
	}

	// Store file doesn't exist at any path — try filesystem discovery
	return discoverAccountsFromFilesystem();
}

/**
 * Discover accounts by scanning for ~/.claude-* directories.
 * Fallback when electron-store is not available.
 */
async function discoverAccountsFromFilesystem(): Promise<CLIAccountInfo[]> {
	const homeDir = os.homedir();

	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(homeDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const accounts: CLIAccountInfo[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!entry.name.startsWith('.claude-')) continue;

		const configDir = path.join(homeDir, entry.name);
		const name = entry.name.replace('.claude-', '');

		// Check for auth info
		let email = '';
		try {
			const authContent = await fs.promises.readFile(
				path.join(configDir, '.claude.json'),
				'utf-8'
			);
			const json = JSON.parse(authContent);
			email = json.email || json.accountEmail || json.primaryEmail || '';
		} catch {
			// no auth file
		}

		accounts.push({
			id: name,
			name,
			email,
			configDir,
			status: 'active',
			isDefault: false,
		});
	}

	return accounts;
}

/**
 * Get the default account, or the first active account, or null.
 */
export async function getDefaultAccount(): Promise<CLIAccountInfo | null> {
	const accounts = await readAccountsFromStore();
	return (
		accounts.find((a) => a.isDefault && a.status === 'active') ||
		accounts.find((a) => a.status === 'active') ||
		null
	);
}

/**
 * Get a specific account by ID or name.
 */
export async function getAccountByIdOrName(idOrName: string): Promise<CLIAccountInfo | null> {
	const accounts = await readAccountsFromStore();
	return accounts.find((a) => a.id === idOrName || a.name === idOrName) || null;
}
