/**
 * Read the Grok model catalog an SSH remote's default account keeps, so a
 * remote or hosted Grok agent's context gauge reads its window the same way a
 * local one does.
 *
 * Grok reports no context window on its turn stream. A local agent's window
 * comes from its account's `models_cache.json` (`readGrokModelsCache()` in
 * `detector.ts`); an agent on a remote runs the same binary against the same
 * kind of file in the remote's home, so the readiness probe
 * (`detectAgentsRemote`) reads it over the same SSH connection and records the
 * windows on that remote's Grok snapshot, under the account key the renderer
 * names for a remote agent (`REMOTE_ACCOUNT_HOME_DIR`). A hosted agent runs on
 * its host, which is the same remote, so it reads the same entry.
 *
 * Only the default account (`$HOME/.grok`) is read: discovery is per remote,
 * not per agent. A remote agent with its own `GROK_HOME` keeps an unknown
 * window, as a local agent does for an account whose cache reports none.
 *
 * The file also carries credentials (`api_key` and friends per model). Its text
 * is parsed in memory by `parseGrokModelsCache()`, which keeps only model ids,
 * windows and efforts; it is never logged.
 */

import { buildSshCommand, execSshCommand } from '../utils/ssh-command-builder';
import { isSshConnectionFailure } from '../../shared/sshConnection';
import { logger } from '../utils/logger';
import type { SshRemoteConfig } from '../../shared/types';
import { REMOTE_ACCOUNT_HOME_DIR, resolveAgentAccountKey } from '../../shared/providerProfiles';
import { parseGrokModelsCache, recordGrokAccountContextWindows } from './detector';

const LOG_CONTEXT = 'ProbeRemoteGrokContextWindows';
const SSH_TIMEOUT_MS = 10000;

/** The script that prints the remote default account's Grok model catalog. */
export const REMOTE_GROK_MODELS_CACHE_SCRIPT = 'cat "$HOME/.grok/models_cache.json"';

/**
 * Read the remote's default Grok account catalog and record its windows on the
 * remote's Grok snapshot. A connection failure or timeout leaves the snapshot
 * as it was (unknown stays unknown, a known window is not dropped on a flaky
 * network); a missing or malformed file drops the account's windows, as the
 * local read does.
 */
export async function probeRemoteGrokContextWindows(sshRemote: SshRemoteConfig): Promise<void> {
	try {
		const sshCommand = await buildSshCommand(sshRemote, {
			command: 'sh',
			args: ['-c', REMOTE_GROK_MODELS_CACHE_SCRIPT],
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`SSH connection timed out after ${SSH_TIMEOUT_MS / 1000}s`)),
				SSH_TIMEOUT_MS
			);
		});
		const result = await Promise.race([execSshCommand(sshRemote, sshCommand), timeout]).finally(
			() => clearTimeout(timer)
		);
		if (isSshConnectionFailure(result.exitCode)) {
			logger.debug(`Grok catalog unread: ${sshRemote.host} unreachable`, LOG_CONTEXT);
			return;
		}
		const read = result.exitCode === 0 ? parseGrokModelsCache(result.stdout) : null;
		recordGrokAccountContextWindows(
			resolveAgentAccountKey('grok', undefined, REMOTE_ACCOUNT_HOME_DIR),
			read,
			{ remoteId: sshRemote.id }
		);
	} catch (error) {
		logger.debug(
			`Grok catalog unread on ${sshRemote.host}: ${error instanceof Error ? error.message : String(error)}`,
			LOG_CONTEXT
		);
	}
}
