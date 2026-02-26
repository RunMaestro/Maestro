import { spawn } from 'child_process';
import * as path from 'path';

let cachedPath: string | null = null;

/**
 * Spawn the user's login shell and print the PATH. Cache the result for the
 * process lifetime. Times out after 2000ms and rejects on failure.
 */
export async function refreshShellPath(): Promise<string> {
	// On Windows, there's no reliable POSIX login shell to probe — fall back to
	// the current process env PATH so callers still receive something useful.
	if (process.platform === 'win32') {
		const p = process.env.PATH || '';
		cachedPath = p;
		return p;
	}

	const shell = process.env.SHELL || '/bin/bash';
	const shellBase = path.basename(shell);
	// Use -l to load login files; some shells (zsh) need -i to load interactive rc
	const args =
		shellBase === 'zsh'
			? ['-l', '-i', '-c', 'printf "%s" "$PATH"']
			: ['-l', '-c', 'printf "%s" "$PATH"'];

	return new Promise((resolve, reject) => {
		const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';

		const timeout = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			reject(new Error('Timed out reading shell PATH'));
		}, 2000);

		child.stdout?.on('data', (d) => (stdout += d.toString()));
		child.stderr?.on('data', (d) => (stderr += d.toString()));

		child.on('error', (err) => {
			clearTimeout(timeout);
			reject(err);
		});

		child.on('close', (code) => {
			clearTimeout(timeout);
			if (code === 0 && stdout) {
				const result = stdout.trim();
				cachedPath = result;
				resolve(result);
			} else {
				const msg = stderr || `Shell exited with code ${code}`;
				reject(new Error(msg));
			}
		});
	});
}

/**
 * Return cached shell PATH if available, otherwise refresh.
 */
export async function getShellPath(): Promise<string> {
	if (cachedPath) return cachedPath;
	return refreshShellPath();
}

/** Clear the in-memory cache (useful for tests). */
export function clearShellPathCache(): void {
	cachedPath = null;
}

export default getShellPath;
