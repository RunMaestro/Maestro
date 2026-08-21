/**
 * Cross-host history collection for Director's Notes.
 *
 * Director's Notes aggregates the LOCAL history store (`userData/history/`),
 * which holds one file per agent this Maestro instance drives - including
 * agents whose process runs over SSH, because the run is still recorded here.
 *
 * What it never saw is the other half: work performed by a DIFFERENT Maestro
 * instance against the same project. That instance mirrors its entries into
 * `<project>/.maestro/history/history-<hostname>.jsonl` (see
 * `shared-history-manager.ts`), and the per-agent History panel already merges
 * those files. Without this module, the same runs the History panel shows are
 * invisible to every Director's Notes surface: the unified list, the graph,
 * Rich Mode stats, and the AI synopsis.
 *
 * This module walks every stored agent, resolves the DISTINCT set of shared
 * history locations they imply (an SSH remote's project dir, or a local project
 * dir), and reads foreign-host entries from each one exactly once. Many agents
 * usually share a project, so scope de-duplication is what keeps this to a
 * couple of SSH round trips rather than one per agent.
 *
 * Entries authored by THIS host are excluded at the file level by
 * `shared-history-manager` (it skips `history-<local hostname>.jsonl`), so a
 * mirrored copy of a local run can never be double counted.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { app } from 'electron';
import { logger } from './logger';
import { captureException } from './sentry';
import { getSessionsStore } from '../stores';
import { getSshRemoteById } from '../stores/getters';
import {
	hasLocalSharedHistory,
	readRemoteEntriesLocal,
	readRemoteEntriesSsh,
} from '../shared-history-manager';
import { MAX_ENTRIES_PER_SESSION } from '../../shared/history';
import type { HistoryEntry } from '../../shared/types';

const LOG_CONTEXT = '[DirectorNotes:SharedHistory]';

/** Filename of the merged foreign-host corpus handed to the synopsis agent. */
const SHARED_MANIFEST_FILENAME = 'director-notes-shared-history.json';

/**
 * One place to read foreign-host history from. `key` de-duplicates scopes
 * across the agents that resolve to the same location.
 */
interface SharedHistoryScope {
	key: string;
	/** SSH remote id, or undefined for a local project directory. */
	sshRemoteId?: string;
	/** Project directory holding `.maestro/history/` (remote path when SSH). */
	dir: string;
}

/** Foreign-host entries plus the attribution needed to describe them. */
export interface SharedHistoryCollection {
	/** Foreign-host entries, de-duplicated by entry id. */
	entries: HistoryEntry[];
	/** Distinct hostnames the entries came from, sorted for stable display. */
	hosts: string[];
	/** How many distinct locations were read (SSH dirs + local project dirs). */
	scopeCount: number;
}

const EMPTY_COLLECTION: SharedHistoryCollection = { entries: [], hosts: [], scopeCount: 0 };

/**
 * Namespaced agent key for a foreign entry.
 *
 * The remote Maestro's session ids live in a different namespace than ours, so
 * they are prefixed with the host. Without the prefix a foreign id could
 * collide with a local agent and silently fold two different agents' work into
 * one row.
 */
export function sharedEntryAgentKey(entry: HistoryEntry): string {
	const host = entry.hostname || 'unknown-host';
	return `shared:${host}:${entry.sessionId || 'unknown-agent'}`;
}

/** Display label for a foreign agent: its own name, qualified by the host. */
export function sharedEntryAgentName(entry: HistoryEntry): string {
	const host = entry.hostname || 'unknown host';
	const base = entry.sessionName || entry.sessionId?.substring(0, 8) || 'Agent';
	return `${base} (${host})`;
}

/**
 * Resolve the distinct shared-history locations implied by the stored agents.
 *
 * SSH agents contribute their remote project dir, but only when the user opted
 * into `syncHistory` - the same gate `buildSharedHistoryContext()` applies in
 * the renderer, so Director's Notes never reaches over a network the History
 * panel would not have reached over either.
 *
 * Local agents contribute their own project dir, which is where a peer that
 * SSH'd INTO this machine writes its mirror.
 */
function collectScopes(): SharedHistoryScope[] {
	const storedSessions = getSessionsStore().get('sessions', []);
	const scopes = new Map<string, SharedHistoryScope>();

	for (const session of storedSessions) {
		const ssh = session.sessionSshRemoteConfig as
			| { enabled?: boolean; remoteId?: string | null; syncHistory?: boolean }
			| undefined;

		if (ssh?.enabled && ssh.remoteId && ssh.syncHistory) {
			const dir = session.cwd;
			if (!dir) continue;
			const key = `ssh:${ssh.remoteId}:${dir}`;
			if (!scopes.has(key)) scopes.set(key, { key, sshRemoteId: ssh.remoteId, dir });
			continue;
		}

		const dir = session.projectRoot || session.cwd;
		if (!dir) continue;
		const key = `local:${dir}`;
		if (!scopes.has(key)) scopes.set(key, { key, dir });
	}

	return Array.from(scopes.values());
}

/**
 * Cheap, network-free probe: could there be foreign-host history at all?
 *
 * An SSH scope counts as "could be" without contacting the host, because
 * answering properly means a round trip - which is exactly what the callers
 * use this probe to avoid on the common all-local setup. The local scopes are
 * a directory listing.
 *
 * Used to decide whether a cached aggregate (fingerprinted over LOCAL history
 * files only, so blind to shared entries) is still safe to serve.
 */
export function hasSharedHistorySources(): boolean {
	for (const scope of collectScopes()) {
		if (scope.sshRemoteId) return true;
		if (hasLocalSharedHistory(scope.dir)) return true;
	}
	return false;
}

/**
 * Read foreign-host history entries from every location the stored agents
 * imply, de-duplicated by entry id.
 *
 * Never throws: a shared-history read failing (remote down, dir missing, SSH
 * key rotated) must degrade Director's Notes to local-only, not break it.
 */
export async function collectSharedHistoryEntries(
	maxEntriesPerFile: number = MAX_ENTRIES_PER_SESSION
): Promise<SharedHistoryCollection> {
	const scopes = collectScopes();
	if (scopes.length === 0) return EMPTY_COLLECTION;

	const perScope = await Promise.all(
		scopes.map(async (scope) => {
			try {
				if (scope.sshRemoteId) {
					const sshRemote = getSshRemoteById(scope.sshRemoteId);
					if (!sshRemote) return [];
					return await readRemoteEntriesSsh(scope.dir, sshRemote, maxEntriesPerFile);
				}
				return readRemoteEntriesLocal(scope.dir, maxEntriesPerFile);
			} catch (error) {
				void captureException(error, { operation: 'directorNotes:collectSharedHistory' });
				logger.warn(`Failed to read shared history from ${scope.key}: ${error}`, LOG_CONTEXT);
				return [];
			}
		})
	);

	const seenIds = new Set<string>();
	const entries: HistoryEntry[] = [];
	const hosts = new Set<string>();

	for (const scopeEntries of perScope) {
		for (const entry of scopeEntries) {
			if (!entry.id || seenIds.has(entry.id)) continue;
			seenIds.add(entry.id);
			entries.push(entry);
			if (entry.hostname) hosts.add(entry.hostname);
		}
	}

	if (entries.length > 0) {
		logger.debug(
			`Collected ${entries.length} shared entries from ${hosts.size} host(s) across ${scopes.length} scope(s)`,
			LOG_CONTEXT
		);
	}

	return { entries, hosts: Array.from(hosts).sort(), scopeCount: scopes.length };
}

/** A materialized corpus of foreign-host entries the synopsis agent can read. */
export interface SharedHistoryManifestEntry {
	/** Absolute local path to the JSON file holding the entries. */
	filePath: string;
	hosts: string[];
	entryCount: number;
}

/**
 * Write the in-window foreign-host entries to a local JSON file so the synopsis
 * agent can read them the same way it reads the per-agent history files.
 *
 * The synopsis prompt is a manifest of file PATHS, and the agent runs on this
 * machine - it cannot open a path on the remote host. Materializing the merged
 * entries locally keeps the prompt's one contract (here are files, go read
 * them) instead of inlining a second, differently-shaped data channel.
 *
 * Returns null when there is nothing in window, so callers can skip the
 * manifest section entirely.
 */
export async function materializeSharedHistoryFile(
	entries: HistoryEntry[],
	cutoffTime: number,
	hosts: string[]
): Promise<SharedHistoryManifestEntry | null> {
	const inWindow = cutoffTime > 0 ? entries.filter((e) => e.timestamp >= cutoffTime) : entries;
	if (inWindow.length === 0) return null;

	const filePath = path.join(app.getPath('userData'), SHARED_MANIFEST_FILENAME);
	// Newest first, matching the per-agent history files the agent also reads.
	const sorted = [...inWindow].sort((a, b) => b.timestamp - a.timestamp);

	try {
		await fs.writeFile(filePath, JSON.stringify({ entries: sorted }, null, 2), 'utf-8');
	} catch (error) {
		void captureException(error, { operation: 'directorNotes:materializeSharedHistory' });
		logger.warn(`Failed to write shared history manifest file: ${error}`, LOG_CONTEXT);
		return null;
	}

	const hostsInWindow = hosts.length
		? hosts
		: Array.from(new Set(sorted.map((e) => e.hostname).filter((h): h is string => !!h))).sort();

	return { filePath, hosts: hostsInWindow, entryCount: sorted.length };
}

/**
 * Collect and materialize in one call - what both synopsis callers (desktop IPC
 * and the web/CLI callback) need.
 */
export async function prepareSharedHistoryForSynopsis(
	cutoffTime: number
): Promise<SharedHistoryManifestEntry | null> {
	const collection = await collectSharedHistoryEntries();
	if (collection.entries.length === 0) return null;
	return materializeSharedHistoryFile(collection.entries, cutoffTime, collection.hosts);
}
