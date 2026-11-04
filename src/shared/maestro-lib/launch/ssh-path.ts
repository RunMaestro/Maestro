/**
 * Locating the `ssh` binary for remote agent spawns.
 *
 * Split out of `src/main/utils/cliDetection.ts` (which re-exports it) so the
 * SSH command builder can live in maestro-lib without importing `src/main`.
 * The cache is module state, so the desktop and the library share one answer.
 */

import * as path from 'path';
import { execFileNoThrow } from './exec-file';
import { buildExpandedEnv } from '../../pathUtils';
import { isWindows, getWhichCommand } from '../../platformDetection';

// SSH CLI detection cache
let sshPathCache: string | null = null;
let sshDetectionDone = false;

/**
 * Detect the path to the ssh binary.
 * Uses 'which' on Unix, 'where' on Windows with expanded PATH.
 * Results are cached for performance.
 * @param execute - Optional host adapter for the canonical executor, allowing
 * native child observation without importing desktop state into the library.
 */
export async function detectSshPath(
	execute: typeof execFileNoThrow = execFileNoThrow
): Promise<string | null> {
	if (sshDetectionDone) {
		return sshPathCache;
	}

	const command = getWhichCommand();
	const env = buildExpandedEnv();
	const result = await execute(command, ['ssh'], undefined, env);

	if (result.exitCode === 0 && result.stdout.trim()) {
		// Handle Windows CRLF line endings properly
		// On Windows, 'where' returns paths with \r\n, so we need to split on \r?\n
		const lines = result.stdout.trim().split(/\r?\n/);
		sshPathCache = lines[0]?.trim() || null;
	} else if (isWindows()) {
		// Fallback for Windows: Check the built-in OpenSSH location directly
		// This is the standard location for Windows 10/11 OpenSSH
		const fs = await import('fs');
		const systemRoot = process.env.SystemRoot || 'C:\\Windows';
		const opensshPath = path.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe');

		try {
			if (fs.existsSync(opensshPath)) {
				sshPathCache = opensshPath;
			}
		} catch {
			// If check fails, leave sshPathCache as null
		}
	}

	sshDetectionDone = true;
	return sshPathCache;
}

/**
 * Get the SSH binary path, auto-detecting if not already cached.
 * Falls back to 'ssh' if detection fails (will use PATH at runtime).
 * @returns The path to use for ssh commands
 */
export async function resolveSshPath(
	execute: typeof execFileNoThrow = execFileNoThrow
): Promise<string> {
	await detectSshPath(execute);
	return sshPathCache || 'ssh';
}
