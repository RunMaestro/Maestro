/**
 * Writes the static loader files used to bootstrap shell integration into a
 * spawned PTY shell.
 *
 * The loaders live in `<userData>/shell-integration/` so that PtySpawner can
 * point a freshly-spawned zsh or bash at them without baking absolute paths
 * into the shell-integration scripts themselves. Two paths are produced:
 *
 *   - `<userData>/shell-integration/zsh/.zshrc`
 *       Used by setting `ZDOTDIR=<userData>/shell-integration/zsh` on the
 *       child process. zsh reads this file instead of the user's real
 *       `$ZDOTDIR/.zshrc`. The loader restores the user's real `ZDOTDIR`
 *       from `$MAESTRO_REAL_ZDOTDIR`, sources their real `.zshrc`, and then
 *       evals `$MAESTRO_SHELL_INTEGRATION_SCRIPT` so our hooks install
 *       *after* user customization (otherwise `add-zsh-hook` calls in the
 *       user's rc could be replayed without our hooks present).
 *
 *   - `<userData>/shell-integration/bash-init.sh`
 *       Used by passing `--rcfile <path>` to bash. The loader sources
 *       `~/.bashrc` and then evals `$MAESTRO_SHELL_INTEGRATION_SCRIPT`.
 *
 * Both loaders defer the integration body to the env var rather than embedding
 * it directly so that the loader files are static (good for caching, easy to
 * inspect on disk) and the integration script can be updated by simply
 * relaunching the app — no on-disk migration required.
 *
 * `ensureShellIntegrationFiles()` is intended to be called once during app
 * startup. It is idempotent and overwrites any existing loader content so the
 * files always reflect the current build's expectations.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'shell-integration:setup';

const ZSH_LOADER = `# Maestro zsh integration loader.
#
# zsh was spawned with ZDOTDIR pointing at this directory so this file is read
# in place of the user's real .zshrc. We restore their real ZDOTDIR (captured
# in MAESTRO_REAL_ZDOTDIR by the spawner) before sourcing so any of their
# config that consults $ZDOTDIR sees the expected value, then eval the
# integration script LAST so our preexec/precmd hooks survive any user
# customization that re-runs add-zsh-hook.

if [ -n "\${MAESTRO_REAL_ZDOTDIR:-}" ]; then
	ZDOTDIR="\${MAESTRO_REAL_ZDOTDIR}"
else
	unset ZDOTDIR
fi

if [ -n "\${ZDOTDIR:-}" ] && [ -r "\${ZDOTDIR}/.zshrc" ]; then
	source "\${ZDOTDIR}/.zshrc"
elif [ -r "\${HOME}/.zshrc" ]; then
	source "\${HOME}/.zshrc"
fi

if [ -n "\${MAESTRO_SHELL_INTEGRATION_SCRIPT:-}" ]; then
	eval "\${MAESTRO_SHELL_INTEGRATION_SCRIPT}"
fi
`;

const BASH_LOADER = `# Maestro bash integration loader.
#
# bash was spawned with --rcfile pointing at this file so this is read in
# place of ~/.bashrc. Source the user's real .bashrc first (if any), then
# eval the integration script LAST so our DEBUG trap and PROMPT_COMMAND
# sandwich survive any user customization.

if [ -r "\${HOME}/.bashrc" ]; then
	source "\${HOME}/.bashrc"
fi

if [ -n "\${MAESTRO_SHELL_INTEGRATION_SCRIPT:-}" ]; then
	eval "\${MAESTRO_SHELL_INTEGRATION_SCRIPT}"
fi
`;

/**
 * Resolve the directory under userData that holds the shell-integration
 * loader files. Exported so PtySpawner / tests can compute the same path.
 */
export function getShellIntegrationDir(): string {
	return path.join(app.getPath('userData'), 'shell-integration');
}

/**
 * Resolve the path of the zsh loader's parent directory. Spawning code uses
 * this as the value of ZDOTDIR when launching zsh.
 */
export function getZshLoaderDir(): string {
	return path.join(getShellIntegrationDir(), 'zsh');
}

/**
 * Resolve the path of the bash loader file. Spawning code passes this as
 * `--rcfile` when launching bash.
 */
export function getBashLoaderPath(): string {
	return path.join(getShellIntegrationDir(), 'bash-init.sh');
}

/**
 * Write the loader files to disk. Idempotent: existing files are overwritten
 * so the loaders always match the current build. Failures are logged but not
 * thrown — a missing loader degrades to no-shell-integration, which the
 * fallback ps detector covers, rather than blocking app startup.
 */
export function ensureShellIntegrationFiles(): void {
	try {
		const zshDir = getZshLoaderDir();
		fs.mkdirSync(zshDir, { recursive: true });
		fs.writeFileSync(path.join(zshDir, '.zshrc'), ZSH_LOADER, 'utf-8');
		fs.writeFileSync(getBashLoaderPath(), BASH_LOADER, 'utf-8');
		logger.debug('Wrote shell integration loader files', LOG_CONTEXT);
	} catch (err) {
		logger.warn(`Failed to write shell integration loader files: ${err}`, LOG_CONTEXT);
	}
}
