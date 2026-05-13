import path from 'path';
import os from 'os';
import { OpenCodeSessionStorage } from './opencode-session-storage';
import type { ToolType } from '../../shared/types';
import { isWindows } from '../../shared/platformDetection';

/**
 * Kilo Session Storage Implementation
 *
 * Kilo is a 1:1 fork of OpenCode with identical session formats, but stores
 * data under the kilo data directory and kilo.db.
 */
export class KiloSessionStorage extends OpenCodeSessionStorage {
	readonly agentId: ToolType = 'kilo';

	/**
	 * Get Kilo data base directory (platform-specific)
	 * - Linux/macOS: ~/.local/share/kilo
	 * - Windows: %LOCALAPPDATA%\kilo
	 */
	protected getDataDir(): string {
		if (isWindows()) {
			const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
			return path.join(localAppData, 'kilo');
		}
		return path.join(os.homedir(), '.local', 'share', 'kilo');
	}

	/**
	 * Get Kilo SQLite database path (v1.2+)
	 */
	protected getDbPath(): string {
		return path.join(this.getDataDir(), 'kilo.db');
	}

	/**
	 * Get the Kilo storage base directory (remote)
	 * On remote Linux hosts, ~ expands to the user's home directory
	 */
	protected getRemoteStorageDir(): string {
		return '~/.local/share/kilo/storage';
	}
}
