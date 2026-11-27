/**
 * The runtime's History: reading an agent's entries for a client, and copying each new entry to
 * the shared History of the agent's working directory so the other Maestros there see it.
 *
 * A desktop writes `<project>/.maestro/history/history-<hostname>.jsonl` and reads every other
 * file there (`src/main/shared-history-manager.ts`). A headless host does the same through
 * `store/shared-history.ts`, under its own label (`hostSharedHistoryLabel()`), so the people who
 * work the project from a desktop see the work done on the host, and the host's clients see
 * theirs. Each entry is stamped with the `hostname` of the machine that sent the turn when the
 * client said (`TurnInput.originHost`), else with the host's own.
 *
 * Sharing is opt-in, the same as on a desktop: an agent shares when its record says so
 * (`sessionSshRemoteConfig.shareHistoryToProjectDir`) or when its project already has a
 * `.maestro/history/` directory, which exists only once some Maestro working there chose to
 * share. A host never creates the directory on its own initiative.
 */

import * as fs from 'fs';

import { MAX_ENTRIES_PER_SESSION, listAgentHistory } from '../../history';
import { sharesHistoryInProject } from '../../historySharing';
import type { AgentSshRemoteConfig, HistoryEntry } from '../../types';
import { sshRecordOf } from '../agents/rules';
import type { AgentRepository } from '../agents/repository';
import type { ClientError, ClientMethod, ClientResult, HistoryApi } from '../client/types';
import { logger } from '../host';
import type { MaestroPaths } from '../paths/resolve';
import type { DataDirVerdict } from './data-dir-lock';
import { createHistoryWriter, type HistoryEditResult, type HistoryWriter } from '../turns/history';
import { readHistory } from '../store/read-history';
import {
	appendSharedHistoryEntry,
	readSharedHistoryEntries,
	rotateSharedHistoryFile,
	sharedHistoryDir,
} from '../store/shared-history';

const LOG_CONTEXT = '[RuntimeHistory]';

/** Who this runtime writes the shared History as. */
export interface SharedHistoryIdentity {
	/** The shared file this runtime owns (`hostSharedHistoryLabel(hostname)` for a host). */
	label: string;
	/** The `hostname` an entry carries when the turn did not say where it was sent from. */
	hostname: string;
}

export interface RuntimeHistoryOptions {
	paths: Pick<MaestroPaths, 'historyDir'>;
	repository: Pick<AgentRepository, 'getAgent'>;
	/** Absent: this runtime neither writes nor excludes a shared file (the TUI). */
	shared?: SharedHistoryIdentity;
	/** Entries a shared file keeps. Default `MAX_ENTRIES_PER_SESSION`. */
	maxEntries?: number;
	/** Is this process still the data directory's writer? Asked before every write. */
	fence?: () => DataDirVerdict;
	/**
	 * Called once an agent's own History changed: an entry was appended, removed, or updated. The
	 * runtime says it to its clients (`history.changed`), so one that holds the list reads it again.
	 */
	onChanged?(agentId: string): void;
}

export interface RuntimeHistory {
	readonly api: HistoryApi;
	/**
	 * Copy an entry the runtime just recorded to the shared History of its agent's project, when
	 * the agent shares. Never throws: the entry is already in the agent's own History.
	 */
	share(agentId: string, entry: HistoryEntry): void;
	/**
	 * The one writer of the agents' own History: every turn's entry (copied to the shared History
	 * through `share`), and the panel's Delete and Validate (`api.remove` / `api.update`).
	 */
	readonly writer: HistoryWriter;
}

function fail<T = never>(method: ClientMethod, code: ClientError['code'], message: string) {
	return { ok: false, error: { code, message, method } } as ClientResult<T>;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** An edit's result as the client API answers it. */
function editOutcome<K extends 'removed' | 'updated'>(
	method: ClientMethod,
	key: K,
	result: HistoryEditResult
): ClientResult<Record<K, boolean>> {
	if (result.ok) return { ok: true, value: { [key]: result.changed } as Record<K, boolean> };
	if (result.reason === 'fenced') return fail(method, 'host-lost', result.message);
	return fail(method, 'failed', result.message);
}

export function createRuntimeHistory(options: RuntimeHistoryOptions): RuntimeHistory {
	const { paths, repository, shared } = options;
	const maxEntries = options.maxEntries ?? MAX_ENTRIES_PER_SESSION;

	/** The project whose shared History the agent takes part in, or undefined when it does not. */
	function sharingProject(agentId: string): string | undefined {
		const agent = repository.getAgent(agentId);
		const project = (agent?.projectRoot || agent?.cwd || '').trim();
		if (!agent || !project) return undefined;
		const ssh = sshRecordOf(agent.sessionSshRemoteConfig) as
			| Pick<AgentSshRemoteConfig, 'enabled' | 'syncHistory' | 'shareHistoryToProjectDir'>
			| undefined;
		// An agent whose turns run over SSH has its project on the remote: its path
		// is never written on this machine.
		if (ssh?.enabled === true) return undefined;
		// History sharing is one setting stored in two fields.
		const optedIn = sharesHistoryInProject(ssh);
		return optedIn || fs.existsSync(sharedHistoryDir(project)) ? project : undefined;
	}

	const api: HistoryApi = {
		list: async (agentId, listOptions = {}) => {
			const agent = repository.getAgent(agentId);
			if (!agent) return fail('history.list', 'not-found', `No agent ${agentId}.`);
			const read = readHistory(paths, agentId, { limit: Number.MAX_SAFE_INTEGER });
			if (read.status === 'corrupt' || read.status === 'unreadable') {
				return fail(
					'history.list',
					'failed',
					`The agent's History could not be read: ${read.reason}`
				);
			}
			const own = read.status === 'ok' ? read.entries : [];
			const project = (agent.projectRoot || agent.cwd || '').trim();
			let others: HistoryEntry[] = [];
			if (project) {
				try {
					others = readSharedHistoryEntries(project, {
						...(shared ? { excludeLabel: shared.label } : {}),
						maxEntriesPerFile: maxEntries,
						onFileError: (file, error) =>
							logger.warn(
								`A shared History file was not read (${file}): ${errorText(error)}`,
								LOG_CONTEXT
							),
					});
				} catch (error) {
					logger.warn(`The shared History was not read: ${errorText(error)}`, LOG_CONTEXT);
				}
			}
			return { ok: true, value: listAgentHistory(own, others, listOptions.limit) };
		},
		// Only the agent's own entries: an entry another Maestro shared stays theirs to edit, the
		// same as `HistoryManager.deleteEntry` on a desktop finds only the agent's own file.
		remove: async (agentId, entryId) => {
			if (!repository.getAgent(agentId)) {
				return fail('history.remove', 'not-found', `No agent ${agentId}.`);
			}
			if (!entryId) return fail('history.remove', 'invalid', 'An entry id is required.');
			return editOutcome('history.remove', 'removed', await writer.remove(agentId, entryId));
		},
		update: async (agentId, entryId, updates) => {
			if (!repository.getAgent(agentId)) {
				return fail('history.update', 'not-found', `No agent ${agentId}.`);
			}
			if (!entryId) return fail('history.update', 'invalid', 'An entry id is required.');
			if (updates.validated === undefined) {
				return fail('history.update', 'invalid', 'Nothing to change: pass validated.');
			}
			return editOutcome(
				'history.update',
				'updated',
				await writer.update(agentId, entryId, updates)
			);
		},
	};

	function share(agentId: string, entry: HistoryEntry): void {
		if (!shared) return;
		try {
			const project = sharingProject(agentId);
			if (!project) return;
			const file = appendSharedHistoryEntry(project, shared.label, {
				...entry,
				hostname: entry.hostname || shared.hostname,
			});
			rotateSharedHistoryFile(file, maxEntries);
		} catch (error) {
			logger.warn(`The entry was not shared to the project: ${errorText(error)}`, LOG_CONTEXT);
		}
	}

	const written = createHistoryWriter({
		paths,
		...(options.fence ? { fence: options.fence } : {}),
		onAppended: (agentId, entry) => {
			share(agentId, entry);
			options.onChanged?.(agentId);
		},
	});
	/** An edit that changed the agent's own History is said, as an append is. */
	const said = (agentId: string, result: HistoryEditResult): HistoryEditResult => {
		if (result.ok && result.changed) options.onChanged?.(agentId);
		return result;
	};
	const writer: HistoryWriter = {
		...written,
		remove: async (agentId, entryId) => said(agentId, await written.remove(agentId, entryId)),
		update: async (agentId, entryId, updates) =>
			said(agentId, await written.update(agentId, entryId, updates)),
	};

	return { api, share, writer };
}
