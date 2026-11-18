import path from 'node:path';

/**
 * Build the spawnSync command, args, and shell flag for rebuilding a native module.
 *
 * @param {'node' | 'electron'} target
 * @param {{ moduleName: string, win32: boolean, rootDir: string }} options
 */
export function buildRebuildSpawn(target, { moduleName, win32, rootDir }) {
	const pathImpl = win32 ? path.win32 : path.posix;
	const [command, args] =
		target === 'node'
			? [win32 ? 'npm.cmd' : 'npm', ['rebuild', moduleName]]
			: [
					pathImpl.join(
						rootDir,
						'node_modules',
						'.bin',
						win32 ? 'electron-rebuild.cmd' : 'electron-rebuild'
					),
					['-f', '-w', moduleName],
				];
	if (!win32) {
		return { command, args, shell: false };
	}
	// .cmd shims need a shell on Windows (Node >=22.12 refuses them otherwise).
	// Quote only commands with a path separator (so paths with spaces work):
	// a quoted bare batch name like "npm.cmd" makes cmd.exe resolve %~dp0 to
	// cwd instead of the batch file's directory on PATH.
	const quotedCommand = /[\\/]/.test(command) ? `"${command}"` : command;
	return {
		command: `${quotedCommand} ${args.join(' ')}`,
		args: [],
		shell: true,
	};
}
