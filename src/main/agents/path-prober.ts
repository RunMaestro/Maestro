import { beginGlobalWorktreeActivity } from '../git/worktreeActivity';
import { withWorktreeTurnActivity } from '../git/worktreeTurnActivity';
import { getShellPath } from '../runtime/getShellPath';
import { execFileNoThrow } from '../utils/execFile';
import { captureException } from '../../shared/maestro-lib/host';
import {
	getExpandedEnvWithShell as getExpandedEnvWithShellCore,
	checkBinaryExists as checkBinaryExistsCore,
	findAllBinaryPaths as findAllBinaryPathsCore,
	type PathProbeRuntime,
} from '../../shared/maestro-lib/launch/path-prober';

// Keep the canonical implementation; direct library and filesystem-only
// callers remain independent coverage gaps.
export * from '../../shared/maestro-lib/launch/path-prober';

const execProbe: typeof execFileNoThrow = (command, args, cwd, options) => {
	// Result, error, exit or timeout cannot establish close. Unknown launch or
	// failed/missing native observation deliberately retains this independent hold.
	const releaseNative = beginGlobalWorktreeActivity();
	return execFileNoThrow(command, args, cwd, options, (child) =>
		child.once('close', releaseNative)
	);
};

function probeWithActivity<T>(probe: (runtime: PathProbeRuntime) => Promise<T>): Promise<T> {
	return withWorktreeTurnActivity(
		(_start, observe) =>
			observe(
				probe({
					getShellPath,
					execFileNoThrow: execProbe,
					captureException: (...args) => observe(captureException(...args)),
				})
			),
		() => {
			// Preserve core/caller error reporting; observe also handles rejected
			// fire-and-forget diagnostics without releasing their activity early.
		}
	);
}

export async function getExpandedEnvWithShell(): Promise<NodeJS.ProcessEnv> {
	return probeWithActivity(getExpandedEnvWithShellCore);
}

export async function checkBinaryExists(binaryName: string) {
	return probeWithActivity((runtime) => checkBinaryExistsCore(binaryName, runtime));
}

export async function findAllBinaryPaths(binaryName: string): Promise<string[]> {
	return probeWithActivity((runtime) => findAllBinaryPathsCore(binaryName, runtime));
}
