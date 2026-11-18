// Moved into maestro-lib: the SSH spawn wrapper builds its commands with it.
// Re-exported so existing imports keep resolving unchanged.
export * from '../../shared/maestro-lib/launch/ssh-command-builder';

import type { SshRemoteConfig } from '../../shared/types';
import type { SshCommandResult } from '../../shared/maestro-lib/launch/ssh-command-builder';
import { execFileNoThrow, type ExecOptions, type ExecResult } from './execFile';
import { noteSshExit } from '../ssh-reachability';

/**
 * Run a command `buildSshCommand()` built, and report how ssh exited to the
 * reachability tracker (`src/main/ssh-reachability.ts`).
 *
 * Use this instead of `execFileNoThrow(sshCommand.command, sshCommand.args)`
 * for every one-shot remote command, so a host that went down is noticed by
 * whichever background job reaches it first (git polls, agent detection, model
 * discovery) and the user gets one dialog about it rather than silence.
 *
 * It lives here rather than beside `buildSshCommand()` in maestro-lib because
 * the tracker is main-process state, which src/shared must not import.
 */
export async function execSshCommand(
	config: SshRemoteConfig,
	sshCommand: SshCommandResult,
	options?: ExecOptions
): Promise<ExecResult> {
	const result = options
		? await execFileNoThrow(sshCommand.command, sshCommand.args, undefined, options)
		: await execFileNoThrow(sshCommand.command, sshCommand.args);
	noteSshExit(config, result.exitCode);
	return result;
}
