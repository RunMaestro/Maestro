// Keep script/argument assembly shared with the headless runtime.
export * from '../../shared/maestro-lib/launch/ssh-command-builder';
import {
	buildSshCommand as buildSshCommandCore,
	buildSshCommandWithStdin as buildSshCommandWithStdinCore,
} from '../../shared/maestro-lib/launch/ssh-command-builder';
import { beginGlobalWorktreeActivity } from '../git/worktreeActivity';
import { resolveSshPath } from './cliDetection';

/** Hold desktop setup through settlement; discovery owns each native probe until close. */
export async function buildSshCommand(
	config: Parameters<typeof buildSshCommandCore>[0],
	remoteOptions: Parameters<typeof buildSshCommandCore>[1]
): ReturnType<typeof buildSshCommandCore> {
	const release = beginGlobalWorktreeActivity();
	try {
		return await buildSshCommandCore(config, remoteOptions, resolveSshPath);
	} finally {
		release();
	}
}

export async function buildSshCommandWithStdin(
	config: Parameters<typeof buildSshCommandWithStdinCore>[0],
	remoteOptions: Parameters<typeof buildSshCommandWithStdinCore>[1]
): ReturnType<typeof buildSshCommandWithStdinCore> {
	const release = beginGlobalWorktreeActivity();
	try {
		return await buildSshCommandWithStdinCore(config, remoteOptions, resolveSshPath);
	} finally {
		release();
	}
}
