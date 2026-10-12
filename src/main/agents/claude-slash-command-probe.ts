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
 */

import { execFileNoThrow } from '../utils/execFile';
import { logger } from '../utils/logger';

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
	const run = (args: string[]) =>
		env
			? execFileNoThrow(commandPath, [...args, '--', '/help'], cwd, { env })
			: execFileNoThrow(commandPath, [...args, '--', '/help'], cwd);

	let result = await run([...PROBE_ARGS, NO_PERSISTENCE_FLAG]);
	// A claude too old to know the flag refuses to start; ask again without it.
	if (result.exitCode !== 0 && /unknown option/i.test(result.stderr ?? '')) {
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

interface CacheEntry {
	at: number;
	commands: Promise<string[] | null>;
}

const cache = new Map<string, CacheEntry>();

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
	const now = Date.now();
	const hit = cache.get(key);
	if (hit && now - hit.at < CACHE_TTL_MS) return hit.commands;
	const commands = probeClaudeSlashCommands(commandPath, cwd, env).then((found) => {
		if (!found) cache.delete(key);
		return found;
	});
	cache.set(key, { at: now, commands });
	return commands;
}

/** For tests: forget every cached probe. */
export function clearClaudeSlashCommandCache(): void {
	cache.clear();
}
