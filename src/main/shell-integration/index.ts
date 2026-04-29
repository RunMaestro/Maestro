/**
 * Shell-integration entry helpers consumed by PtySpawner when launching a
 * terminal tab.
 *
 * Two functions, one input each (the shell binary as configured for the tab —
 * either a bare command like `zsh` or an absolute path like `/bin/zsh`):
 *
 *   - `getShellIntegrationEnv(shell)` returns env vars to merge into the
 *     spawner's PTY environment. For zsh the returned env points `ZDOTDIR` at
 *     our static loader directory and stashes the user's original `ZDOTDIR`
 *     in `MAESTRO_REAL_ZDOTDIR` so the loader can restore it before sourcing
 *     the user's real `.zshrc`. For bash the returned env carries only the
 *     marker + script (the loader is wired in via `--rcfile`, see below).
 *
 *   - `getShellIntegrationArgs(shell)` returns extra CLI args to prepend to
 *     the shell argv. Empty for zsh (ZDOTDIR-driven) and for unsupported
 *     shells; for bash it returns `['--rcfile', <bash loader path>]`.
 *
 * Unsupported shells (sh, fish, powershell, cmd, ...) yield empty env and
 * empty args so PtySpawner spawns them unchanged. Command tracking for those
 * tabs falls back to the ps-based foreground detector (Phase 7).
 *
 * Both helpers stay free of disk and side effects — `setup.ts` is responsible
 * for ensuring the loader files referenced here actually exist on disk; this
 * file just resolves their paths and the integration script bodies.
 */

import path from 'path';
import { getBashIntegrationScript } from './bash-integration';
import { getZshIntegrationScript } from './zsh-integration';
import { getBashLoaderPath, getZshLoaderDir } from './setup';

type ShellKind = 'zsh' | 'bash' | 'unsupported';

/**
 * Map a shell binary path or name to a supported integration kind. Tolerates
 * bare commands (`zsh`), absolute paths (`/bin/zsh`, `/usr/local/bin/bash`),
 * and Windows-style executables (`bash.exe`) so callers don't have to
 * normalize beforehand.
 */
function classifyShell(shell: string | undefined): ShellKind {
	if (!shell) return 'unsupported';
	// Normalize backslashes to forward slashes so POSIX `path.basename()`
	// strips the directory off Windows paths like `C:\\msys64\\usr\\bin\\bash.exe`
	// when this code happens to run on POSIX (tests, dev sandboxes).
	const base = path
		.basename(shell.replace(/\\/g, '/'))
		.toLowerCase()
		.replace(/\.exe$/, '');
	if (base === 'zsh') return 'zsh';
	if (base === 'bash') return 'bash';
	return 'unsupported';
}

/**
 * Env vars the spawner should merge on top of its base PTY env. Never strips
 * variables — only adds. Returns `{}` when `shell` is unrecognized so the
 * caller can spread unconditionally.
 */
export function getShellIntegrationEnv(shell: string | undefined): Record<string, string> {
	const kind = classifyShell(shell);
	switch (kind) {
		case 'zsh': {
			const env: Record<string, string> = {
				MAESTRO_SHELL_INTEGRATION: '1',
				MAESTRO_SHELL_INTEGRATION_SCRIPT: getZshIntegrationScript(),
				ZDOTDIR: getZshLoaderDir(),
			};
			// Only capture the user's original ZDOTDIR when they actually have
			// one set. Setting MAESTRO_REAL_ZDOTDIR to an empty string would
			// fool the loader's `[ -n "${MAESTRO_REAL_ZDOTDIR:-}" ]` guard
			// into restoring a blank ZDOTDIR instead of falling through to the
			// `$HOME/.zshrc` branch.
			if (process.env.ZDOTDIR) {
				env.MAESTRO_REAL_ZDOTDIR = process.env.ZDOTDIR;
			}
			return env;
		}
		case 'bash':
			return {
				MAESTRO_SHELL_INTEGRATION: '1',
				MAESTRO_SHELL_INTEGRATION_SCRIPT: getBashIntegrationScript(),
			};
		case 'unsupported':
			return {};
	}
}

/**
 * Extra CLI args to prepend to the shell argv. Empty for zsh (loader is wired
 * in via `ZDOTDIR`) and for unsupported shells.
 */
export function getShellIntegrationArgs(shell: string | undefined): string[] {
	const kind = classifyShell(shell);
	switch (kind) {
		case 'bash':
			return ['--rcfile', getBashLoaderPath()];
		case 'zsh':
		case 'unsupported':
			return [];
	}
}
