// Shared path + discovery-file helpers for mae. Single source of truth for the
// Maestro config dir so the launcher (reader) and the desktop host (writer)
// resolve the discovery file to the same place. Mirrors
// src/shared/cli-server-discovery.ts getConfigDir (lowercase "maestro").

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DISCOVERY_FILENAME, PROTOCOL_VERSION, type BridgeDiscovery } from './protocol';

export interface MaeEnv {
	[key: string]: string | undefined;
}

export function homeDir(env: MaeEnv): string {
	return env.USERPROFILE || env.HOME || os.homedir();
}

// Honors MAESTRO_USER_DATA, else the per-platform userData location used by the
// desktop app. NEVER a hardcoded ~/.maestro.
export function maestroConfigDir(env: MaeEnv): string {
	if (env.MAESTRO_USER_DATA && env.MAESTRO_USER_DATA.trim() !== '') {
		return path.resolve(env.MAESTRO_USER_DATA);
	}
	const home = homeDir(env);
	if (process.platform === 'darwin') {
		return path.join(home, 'Library', 'Application Support', 'maestro');
	}
	if (process.platform === 'win32') {
		return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'maestro');
	}
	return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'maestro');
}

// The discovery file path. The reader honors MAE_BRIDGE_DISCOVERY (tests); the
// real app reader + writer both fall through to the shared config dir.
export function bridgeDiscoveryPath(env: MaeEnv): string {
	const override = env.MAE_BRIDGE_DISCOVERY;
	if (override && override.trim() !== '') return override;
	return path.join(maestroConfigDir(env), DISCOVERY_FILENAME);
}

export async function writeBridgeDiscovery(
	filePath: string,
	info: { url: string; secret: string }
): Promise<void> {
	const payload: BridgeDiscovery = {
		version: PROTOCOL_VERSION,
		url: info.url,
		secret: info.secret,
	};
	// The discovery file carries the bootstrap secret: owner-only perms (0600),
	// owner-only dir (0700). chmod after write defends against a prior umask /
	// pre-existing tmp. (mode is a no-op on Windows but harmless.)
	await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tmp = `${filePath}.${process.pid}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
	await fsp.chmod(tmp, 0o600);
	await fsp.rename(tmp, filePath);
}

export async function removeBridgeDiscovery(filePath: string): Promise<void> {
	try {
		await fsp.rm(filePath);
	} catch {
		// already gone
	}
}
