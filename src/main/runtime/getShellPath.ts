import { spawn } from 'child_process';
import { beginGlobalWorktreeActivity } from '../git/worktreeActivity';
import {
	getShellPath as getShellPathCore,
	refreshShellPath as refreshShellPathCore,
	type ShellPathSpawner,
} from '../../shared/maestro-lib/launch/getShellPath';

// Keep the library cache/accessors; direct library callers remain a coverage gap.
export * from '../../shared/maestro-lib/launch/getShellPath';

const spawnShell: ShellPathSpawner = (command, args, options) => {
	// Timeout, error, exit and kill delivery cannot prove native close. Unknown
	// launch or missing/failed observation deliberately keeps this hold busy.
	const releaseNative = beginGlobalWorktreeActivity();
	const child = spawn(command, args, options);
	child.once('close', releaseNative);
	return child;
};

export async function refreshShellPath(): Promise<string> {
	const release = beginGlobalWorktreeActivity();
	try {
		return await refreshShellPathCore(spawnShell);
	} finally {
		release();
	}
}

export async function getShellPath(): Promise<string> {
	const release = beginGlobalWorktreeActivity();
	try {
		return await getShellPathCore(spawnShell);
	} finally {
		release();
	}
}

export default getShellPath;
