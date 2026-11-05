/**
 * Probe an SSH remote to confirm `maestro-p` can actually RUN there.
 *
 * This is a launch test, not a path check. A bare `command -v maestro-p` only
 * proves the file exists on PATH - it does NOT prove it will run: maestro-p is a
 * Node script that statically imports `node-pty` (via tui-driver), so a remote
 * with no `node` on PATH, a node missing the `node-pty` native module, or a
 * broken install will pass an existence check yet exit 127/1 the instant a real
 * spawn tries to drive the TUI. We instead run `maestro-p --version`, which
 * loads the full module graph (including node-pty) before printing, so a clean
 * exit-0-with-a-version is a genuine "it will launch" signal.
 *
 * The result feeds {@link remoteMaestroPCache}, which two surfaces read:
 *   - `AgentConfigPanel` (via the `agents:getRemoteMaestroPAvailable` IPC)
 *     disables the TUI token-source option when maestro-p can't run;
 *   - `resolveClaudeSpawnMode` falls a remote TUI spawn back to API when it's
 *     known-unavailable, so a misconfigured agent runs `claude --print` instead
 *     of failing every turn on a maestro-p that can't launch.
 *
 * The agent-readiness probe (`detectAgentsRemote`) calls {@link probeRemoteMaestroP}
 * to piggyback on its connection; the spawn surfaces call
 * {@link ensureRemoteMaestroPProbed} so the cache is warm even when no readiness
 * probe or config modal ran first (the cold-cache first-spawn case).
 */

import { buildSshCommand, RemoteCommandOptions } from '../utils/ssh-command-builder';
import { execFileNoThrow } from '../utils/execFile';
import { stripAnsi } from '../utils/stripAnsi';
import { logger } from '../utils/logger';
import type { SshRemoteConfig } from '../../shared/types';
import {
	setRemoteMaestroPAvailable,
	getRemoteMaestroPAvailable,
	isRemoteMaestroPProbeStale,
} from './remoteMaestroPCache';

const LOG_CONTEXT = 'ProbeRemoteMaestroP';
// Launching maestro-p cold (Node start + module graph incl. node-pty) is heavier
// than a `command -v`, so allow a bit more headroom than a bare existence check.
const SSH_TIMEOUT_MS = 15000;
// A clean `--version` prints a semver-ish line (e.g. `0.16.20-RC`). Requiring the
// pattern - not just non-empty stdout - guards against a shell that exits 0 while
// echoing something unrelated.
const VERSION_OUTPUT_REGEX = /\d+\.\d+\.\d+/;

/**
 * Launch-test `maestro-p --version` on the remote and cache the result keyed by
 * the remote id. Returns the availability, or `null` when the probe could not
 * determine it (connection error / timeout) so the cache stays "unknown" rather
 * than caching a false on a flaky network.
 */
export async function probeRemoteMaestroP(sshRemote: SshRemoteConfig): Promise<boolean | null> {
	// Run maestro-p for real (not `command -v`): a successful `--version` proves
	// node is present and the whole module graph - including the node-pty native
	// addon the TUI needs - resolves on this host.
	const remoteOptions: RemoteCommandOptions = {
		command: 'maestro-p',
		args: ['--version'],
	};

	try {
		const sshCommand = await buildSshCommand(sshRemote, remoteOptions);
		const resultPromise = execFileNoThrow(sshCommand.command, sshCommand.args);
		const timeoutPromise = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
			(_, reject) => {
				setTimeout(
					() => reject(new Error(`SSH connection timed out after ${SSH_TIMEOUT_MS / 1000}s`)),
					SSH_TIMEOUT_MS
				);
			}
		);
		const result = await Promise.race([resultPromise, timeoutPromise]);

		// A connection-level failure tells us nothing about maestro-p - leave it
		// unknown so we don't disable the TUI option on a flaky network.
		if (
			result.stderr &&
			(result.stderr.includes('Connection refused') ||
				result.stderr.includes('Connection timed out') ||
				result.stderr.includes('No route to host') ||
				result.stderr.includes('Could not resolve hostname') ||
				result.stderr.includes('Permission denied'))
		) {
			logger.warn(
				`SSH connection error probing maestro-p on ${sshRemote.host}: ${result.stderr.trim().split('\n')[0]}`,
				LOG_CONTEXT
			);
			return null;
		}

		const cleanedOutput = stripAnsi(result.stdout).trim();
		const available = result.exitCode === 0 && VERSION_OUTPUT_REGEX.test(cleanedOutput);
		setRemoteMaestroPAvailable(sshRemote.id, available);
		if (available) {
			logger.info(
				`maestro-p launches on remote (version ${cleanedOutput.split('\n')[0]}) (${sshRemote.host})`,
				LOG_CONTEXT
			);
		} else {
			// Distinguish "not installed" (127) from "installed but can't launch"
			// (e.g. node/node-pty missing) so the failure is diagnosable from the log.
			const reason =
				result.exitCode === 127
					? 'maestro-p not found on PATH'
					: `maestro-p failed to launch (exit ${result.exitCode}): ${
							stripAnsi(result.stderr).trim().split('\n')[0] || 'no error output'
						}`;
			logger.info(`maestro-p unavailable on remote - ${reason} (${sshRemote.host})`, LOG_CONTEXT);
		}
		return available;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.warn(
			`Failed to probe maestro-p on remote ${sshRemote.host}: ${errorMessage}`,
			LOG_CONTEXT
		);
		return null;
	}
}

/**
 * Ensure the remote maestro-p availability is cached and fresh before a spawn
 * reads it. Returns the cached value untouched when still fresh; otherwise runs
 * a probe and returns its result. Used at the spawn surfaces (desktop turn, Cue,
 * group chat) so the resolver's TUI->API backstop fires on the very first spawn,
 * before any readiness probe or config modal warmed the cache.
 */
export async function ensureRemoteMaestroPProbed(
	sshRemote: SshRemoteConfig
): Promise<boolean | undefined> {
	if (!isRemoteMaestroPProbeStale(sshRemote.id)) {
		return getRemoteMaestroPAvailable(sshRemote.id);
	}
	const probed = await probeRemoteMaestroP(sshRemote);
	// A null probe (couldn't determine) leaves the cache unknown; reflect that.
	return probed ?? getRemoteMaestroPAvailable(sshRemote.id);
}
