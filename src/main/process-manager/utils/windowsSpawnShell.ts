// src/main/process-manager/utils/windowsSpawnShell.ts

import { isWindows } from '../../../shared/platformDetection';
import {
	quoteCommandForCmdShell,
	windowsShellReason,
	type WindowsShellReason,
} from '../../../shared/maestro-lib/launch/windows-command';
import { escapeArgsForShell } from './shellEscape';

/** What a pipe-backed agent spawn hands to `child_process.spawn`. */
export interface SpawnShellPlan {
	command: string;
	args: string[];
	/** `false`, `true` for the platform default shell, or the shell's path. */
	shell: boolean | string;
	/** Set when Windows forced the shell on: the caller logs why. */
	autoReason?: WindowsShellReason;
	/** The shebang line that made `autoReason` a `shebang-script`. */
	shebang?: string;
}

/**
 * Decide how an agent command reaches `child_process.spawn`.
 *
 * Off Windows this is the identity, plus the caller's explicit `runInShell`.
 * On Windows a command that cannot be spawned directly (a bare `.exe` name, a
 * `.cmd` / `.bat` shim, an extensionless shebang script; see
 * `windowsShellReason()`) gets a shell, the args are escaped for that shell,
 * and a boolean (cmd.exe) shell has its command path quoted so a space in it
 * does not split the command. Shared by `ChildProcessSpawner` and
 * `CodexAppServerSpawner`, which launch the same binary and must agree on it.
 */
export function planSpawnShell(
	command: string,
	args: string[],
	options: { runInShell?: boolean; shell?: string }
): SpawnShellPlan {
	let useShell = !!options.runInShell;
	let autoReason: WindowsShellReason | undefined;
	let shebang: string | undefined;

	if (isWindows() && !useShell) {
		const decision = windowsShellReason(command);
		if (decision.reason) {
			useShell = true;
			autoReason = decision.reason;
			shebang = decision.shebang;
		}
	}

	const shellPath = typeof options.shell === 'string' ? options.shell : undefined;
	const spawnArgs = isWindows() && useShell ? escapeArgsForShell(args, shellPath) : args;

	let shell: boolean | string = useShell;
	if (useShell && shellPath && shellPath.trim()) {
		shell = shellPath.trim();
	}

	const spawnCommand = isWindows() && shell === true ? quoteCommandForCmdShell(command) : command;

	return {
		command: spawnCommand,
		args: spawnArgs,
		shell,
		...(autoReason ? { autoReason } : {}),
		...(shebang !== undefined ? { shebang } : {}),
	};
}
