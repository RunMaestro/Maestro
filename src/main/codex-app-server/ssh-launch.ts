// src/main/codex-app-server/ssh-launch.ts

/**
 * `codex app-server` on an SSH remote.
 *
 * An SSH agent spawn is a local `ssh ... /bin/bash -s` whose stdin carries a
 * launch script (PATH, `cd`, env exports) ending in `exec <agent>`. Bash reads
 * a script from a pipe one byte at a time, so everything written after that
 * last line reaches the agent untouched; that is how an exec turn gets its
 * prompt. app-server rides the same channel: the spawner writes this script
 * first and the JSON-RPC lines after it, so the protocol crosses the ssh
 * client's stdio exactly as it crosses a local child's.
 *
 * The launch is built by the spawn handler, the only place that holds the
 * remote's config, the remote binary and the merged env, and only for a turn
 * that wants app-server. The spawner reads the exec turn it carries
 * (`execArgs`, `cwd`, `prompt`) the same way it reads a local config's, and
 * falls back to the exec wrapper the handler also built when it cannot.
 */

import type { SshRemoteConfig } from '../../shared/types';
import { logger } from '../utils/logger';
import { buildSshCommandWithStdin } from '../utils/ssh-command-builder';
import { parseCodexExecArgs } from './invocation';

const LOG_CONTEXT = 'CodexAppServer';

export interface CodexAppServerSshLaunch {
	/** Local ssh binary. */
	command: string;
	/** ssh connection args, ending in the remote `/bin/bash ... -s`. */
	args: string[];
	/** Launch script that `exec`s `codex app-server` on the remote host. */
	stdinScript: string;
	/** The bare remote invocation, for Process Details. */
	remoteCommandLine: string;
	/** The `codex exec` args the turn was planned with, read like a local config's. */
	execArgs: string[];
	/** The turn's working directory on the REMOTE host. */
	cwd: string;
	/** The prompt, which an SSH config otherwise carries only inside the exec script. */
	prompt: string;
}

export interface CodexAppServerSshLaunchOptions {
	/** Codex binary on the remote host. */
	remoteCommand: string;
	execArgs: string[];
	cwd: string;
	/** Env exported on the remote before `exec` (global, agent, and turn-origin vars). */
	env: Record<string, string>;
	prompt: string | undefined;
	images?: string[];
}

/**
 * The SSH launch for an app-server turn, or null when the turn cannot run there
 * (no prompt, an image, an exec arg app-server has no field for). Null is not
 * an error: the turn runs on the exec wrapper.
 */
export async function buildCodexAppServerSshLaunch(
	remote: SshRemoteConfig,
	options: CodexAppServerSshLaunchOptions
): Promise<CodexAppServerSshLaunch | null> {
	const { remoteCommand, execArgs, cwd, env, prompt, images } = options;
	if (!prompt || (images && images.length > 0)) return null;
	const parsed = parseCodexExecArgs(execArgs, cwd);
	if (!parsed.ok) {
		logger.info('[CodexAppServer] SSH turn not carried by app-server; using exec', LOG_CONTEXT, {
			reason: parsed.reason,
		});
		return null;
	}
	const ssh = await buildSshCommandWithStdin(remote, {
		command: remoteCommand,
		args: ['app-server', ...parsed.invocation.configArgs],
		cwd,
		env,
	});
	if (!ssh.stdinScript) return null;
	return {
		command: ssh.command,
		args: ssh.args,
		stdinScript: ssh.stdinScript,
		remoteCommandLine: ssh.remoteCommandLine ?? '',
		execArgs,
		cwd,
		prompt,
	};
}
