/**
 * Ask Claude Code which slash commands it offers in a folder.
 *
 * `claude --print` names them in its `init` event, so a `--print` turn fills
 * the composer's slash-command list as a side effect. A maestro-p turn drives
 * the interactive TUI, which announces nothing, so that list stayed empty for
 * every agent on the TUI token source. Both the New Agent wizard and the
 * maestro-p tab spawn get the list from here instead.
 *
 * The probe runs `/help`, a local command: it costs no tokens and returns in
 * under two seconds. `--no-session-persistence` keeps it from leaving a
 * transcript behind, which would otherwise show up as a stray session in the
 * folder's session list on every probe.
 *
 * The probe runs where the agent runs. For an SSH agent (and a hosted one,
 * which keeps its SSH remote) that is the remote, over SSH, in the agent's
 * folder there: the folder does not exist on this machine, and this machine's
 * commands are not the remote's. A remote that cannot be reached gives no
 * list; the probe never falls back to running here.
 */

import type { SshRemoteConfig } from '../../shared/types';
import { execFileNoThrow, type ExecResult } from '../utils/execFile';
import { agentEnvOverRemote, buildSshCommand, execSshCommand } from '../utils/ssh-command-builder';
import { stripAnsi } from '../utils/stripAnsi';
import { logger } from '../utils/logger';
import { createTtlPromiseCache } from '../utils/ttl-promise-cache';
import { canonicalJson } from '../../shared/canonicalJson';

const LOG_CONTEXT = '[ClaudeSlashCommands]';

const PROBE_ARGS = [
	'--print',
	'--verbose',
	'--output-format',
	'stream-json',
	'--dangerously-skip-permissions',
];
const NO_PERSISTENCE_FLAG = '--no-session-persistence';

// Commands change when the user adds a skill, plugin, or MCP server, which is
// rare; one probe per folder in this window is plenty.
const CACHE_TTL_MS = 30 * 60 * 1000;

/** The `slash_commands` of the first `init` event in stream-json output, or null. */
export function parseInitSlashCommands(stdout: string): string[] | null {
	for (const line of stdout.split('\n')) {
		if (!line.trim()) continue;
		try {
			const msg = JSON.parse(line);
			if (msg?.type === 'system' && msg.subtype === 'init' && Array.isArray(msg.slash_commands)) {
				return msg.slash_commands.filter((c: unknown): c is string => typeof c === 'string');
			}
		} catch {
			// Not JSON (a warning line); keep looking.
		}
	}
	return null;
}

/**
 * Run the probe. Returns the command names, or null when claude could not be
 * run or reported none. `env` is the full environment for the probe, so a
 * caller can point it at the same `CLAUDE_CONFIG_DIR` its agent runs with.
 */
export async function probeClaudeSlashCommands(
	commandPath: string,
	cwd: string,
	env?: NodeJS.ProcessEnv
): Promise<string[] | null> {
	return runProbe((args) =>
		env
			? execFileNoThrow(commandPath, [...args, '--', '/help'], cwd, { env })
			: execFileNoThrow(commandPath, [...args, '--', '/help'], cwd)
	);
}

/** Bound on one remote probe: an SSH round trip plus claude's start. */
const REMOTE_PROBE_TIMEOUT_MS = 30_000;

/**
 * {@link probeClaudeSlashCommands} on an SSH remote: `binary` (the agent's
 * custom path there, or the provider's binary name) runs in `cwd` on the
 * remote, with the remote's environment and then `env`, the agent's own vars.
 */
export async function probeClaudeSlashCommandsRemote(
	sshRemote: SshRemoteConfig,
	binary: string,
	cwd: string,
	env: Record<string, string> = {}
): Promise<string[] | null> {
	// The agent's own vars (its `CLAUDE_CONFIG_DIR` account) over the remote's;
	// a blank agent value cancels the remote's, then is dropped.
	const target = agentEnvOverRemote(sshRemote, env);
	return runProbe(async (args) => {
		const sshCommand = await buildSshCommand(target.config, {
			command: binary,
			args: [...args, '--', '/help'],
			cwd,
			env: target.env,
		});
		const result = await execSshCommand(sshRemote, sshCommand, {
			timeout: REMOTE_PROBE_TIMEOUT_MS,
		});
		// A forced TTY (`--print` over SSH) can paint escape sequences around the JSON.
		return { ...result, stdout: stripAnsi(result.stdout ?? '') };
	});
}

/**
 * Whether claude refused to start because it does not know
 * {@link NO_PERSISTENCE_FLAG}. Over SSH the forced TTY carries stderr on stdout,
 * so both streams are read.
 */
function rejectedPersistenceFlag(result: ExecResult): boolean {
	if (result.exitCode === 0) return false;
	const refusal = /unknown option\W+--no-session-persistence/i;
	return refusal.test(result.stderr ?? '') || refusal.test(result.stdout ?? '');
}

async function runProbe(run: (args: string[]) => Promise<ExecResult>): Promise<string[] | null> {
	let result = await run([...PROBE_ARGS, NO_PERSISTENCE_FLAG]);
	// A claude too old to know the flag refuses to start; ask again without it.
	if (rejectedPersistenceFlag(result)) {
		result = await run(PROBE_ARGS);
	}
	if (result.exitCode !== 0 && !result.stdout) {
		logger.warn(`Slash command probe failed with exit code ${result.exitCode}`, LOG_CONTEXT, {
			stderr: result.stderr?.substring(0, 500),
		});
		return null;
	}
	const commands = parseInitSlashCommands(result.stdout);
	if (!commands) {
		logger.warn('No init message found in slash command probe output', LOG_CONTEXT);
	}
	return commands;
}

/** One probe per key in the window; a failed probe (null) is not kept. */
const cache = createTtlPromiseCache<string[] | null>(CACHE_TTL_MS, (found) => found !== null);

/**
 * {@link probeClaudeSlashCommands}, at most once per binary, folder, and config
 * dir in {@link CACHE_TTL_MS}. Concurrent callers share one probe, so several
 * tabs starting at once spawn one claude, not several. A failed probe is not
 * cached, so the next turn tries again.
 */
export function probeClaudeSlashCommandsCached(
	commandPath: string,
	cwd: string,
	env: NodeJS.ProcessEnv
): Promise<string[] | null> {
	const key = [commandPath, cwd, env.CLAUDE_CONFIG_DIR ?? ''].join('\0');
	return cache.get(key, () => probeClaudeSlashCommands(commandPath, cwd, env));
}

/**
 * {@link probeClaudeSlashCommandsRemote}, at most once per remote, binary,
 * folder, and agent env in {@link CACHE_TTL_MS}, so opening an SSH agent does not start an SSH
 * round trip each time. Keyed by the remote's id: two remotes never share a
 * list. A failed probe is not cached.
 */
export function probeClaudeSlashCommandsRemoteCached(
	sshRemote: SshRemoteConfig,
	binary: string,
	cwd: string,
	env: Record<string, string> = {}
): Promise<string[] | null> {
	// The account is part of the key: two agents on one remote with different
	// config dirs see their own commands.
	const key = ['ssh', sshRemote.id, binary, cwd, canonicalJson(env)].join('\0');
	return cache.get(key, () => probeClaudeSlashCommandsRemote(sshRemote, binary, cwd, env));
}

/** For tests: forget every cached probe. */
export function clearClaudeSlashCommandCache(): void {
	cache.clear();
}
