// Keep spawn assembly shared with the headless runtime.
export * from '../../shared/maestro-lib/launch/ssh-spawn-wrapper';
import { wrapSpawnWithSsh as wrapSpawnWithSshCore } from '../../shared/maestro-lib/launch/ssh-spawn-wrapper';
import { beginGlobalWorktreeActivity } from '../git/worktreeActivity';
import { buildSshCommand, buildSshCommandWithStdin } from './ssh-command-builder';

/** Hold all desktop setup/fallback; discovery owns native children until close. */
export async function wrapSpawnWithSsh(
	config: Parameters<typeof wrapSpawnWithSshCore>[0],
	sshConfig: Parameters<typeof wrapSpawnWithSshCore>[1],
	sshStore: Parameters<typeof wrapSpawnWithSshCore>[2]
): ReturnType<typeof wrapSpawnWithSshCore> {
	const release = beginGlobalWorktreeActivity();
	try {
		return await wrapSpawnWithSshCore(config, sshConfig, sshStore, {
			buildSshCommand,
			buildSshCommandWithStdin,
		});
	} finally {
		release();
	}
}
