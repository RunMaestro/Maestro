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

import { MAX_ENTRIES_PER_SESSION, mergeEntriesById } from '../../history';
import type { HistoryEntry } from '../../types';
import { sshRecordOf } from '../agents/rules';
import type { AgentRepository } from '../agents/repository';
import type { ClientError, ClientMethod, ClientResult, HistoryApi } from '../client/types';
import { logger } from '../host';
import type { MaestroPaths } from '../paths/resolve';
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
}

export interface RuntimeHistory {
	readonly api: HistoryApi;
	/**
	 * Copy an entry the runtime just recorded to the shared History of its agent's project, when
	 * the agent shares. Never throws: the entry is already in the agent's own History.
	 */
	share(agentId: string, entry: HistoryEntry): void;
}

function fail<T = never>(method: ClientMethod, code: ClientError['code'], message: string) {
	return { ok: false, error: { code, message, method } } as ClientResult<T>;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createRuntimeHistory(options: RuntimeHistoryOptions): RuntimeHistory {
	const { paths, repository, shared } = options;
	const maxEntries = options.maxEntries ?? MAX_ENTRIES_PER_SESSION;

	/** The project whose shared History the agent takes part in, or undefined when it does not. */
	function sharingProject(agentId: string): string | undefined {
		const agent = repository.getAgent(agentId);
		const project = (agent?.projectRoot || agent?.cwd || '').trim();
		if (!agent || !project) return undefined;
		const optedIn =
			(sshRecordOf(agent.sessionSshRemoteConfig) as { shareHistoryToProjectDir?: unknown })
				?.shareHistoryToProjectDir === true;
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
			const merged = mergeEntriesById(own, others);
			const limit = listOptions.limit;
			return {
				ok: true,
				value: limit !== undefined && limit >= 0 ? merged.slice(0, limit) : merged,
			};
		},
	};

	return {
		api,
		share(agentId, entry) {
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
		},
	};
}
