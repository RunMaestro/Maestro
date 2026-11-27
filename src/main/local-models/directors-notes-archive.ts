/**
 * The semantic index's copy of Director's Notes synopses.
 *
 * A synopsis is not stored anywhere else: the renderer keeps the last one in a
 * module variable and it is gone at the next launch. An index has to be able to
 * read a source again (to re-embed it under a new model, and to show the text a
 * search matched), so each generated synopsis is appended here, as the text a
 * person reads rather than the JSON the agent emitted.
 *
 *   userData/semantic-index/directors-notes.jsonl   one record per line
 *
 * Two limits keep it what it is, a search source and not a second history:
 *
 *   - **Written only while Semantic search is assigned a source.** With the
 *     task off, generating a synopsis leaves nothing new on disk, exactly as
 *     before this module existed.
 *   - **Bounded.** The newest {@link MAX_ARCHIVED_SYNOPSES} are kept.
 *
 * Archiving never fails a synopsis: the caller fires it and moves on, and a
 * write that fails is logged.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
	narrativeToMarkdown,
	parseDirectorNotesNarrative,
	type DirectorNotesNarrative,
} from '../../shared/directorNotesNarrative';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { resolveLocalModelAssignment } from '../../shared/local-models/tasks';
import { atomicWriteFile } from '../utils/atomic-json-store';
import { logger } from '../utils/logger';
import { localModelsDataDir } from './paths';
import { readLocalModelAssignments } from './sources';

const LOG_CONTEXT = '[DirectorNotesArchive]';

/** The archive's directory, relative to the data dir. */
export const SEMANTIC_INDEX_DIRNAME = 'semantic-index';

/** The archive file, inside {@link SEMANTIC_INDEX_DIRNAME}. */
export const DIRECTORS_NOTES_ARCHIVE_FILENAME = 'directors-notes.jsonl';

/** Synopses kept. A synopsis covers days of work, so this is months of them. */
export const MAX_ARCHIVED_SYNOPSES = 100;

/** One archived synopsis. */
export interface ArchivedSynopsis {
	id: string;
	/** When it was generated (Unix ms). */
	generatedAt: number;
	lookbackDays: number;
	/** The provider that wrote it, when known. */
	provider?: string;
	/** The synopsis as markdown prose. */
	text: string;
}

export interface ArchiveSynopsisInput {
	/** The agent's raw output. */
	synopsis: string;
	/** The parsed narrative, when the caller already has one. */
	narrative?: DirectorNotesNarrative;
	generatedAt?: number;
	lookbackDays: number;
	provider?: string;
}

const writeQueue = createKeyedWriteQueue();
const listeners = new Set<(record: ArchivedSynopsis) => void>();

/** Where the archive lives. `dataDir` is injected in tests. */
export function directorNotesArchivePath(dataDir: string = localModelsDataDir()): string {
	return path.join(dataDir, SEMANTIC_INDEX_DIRNAME, DIRECTORS_NOTES_ARCHIVE_FILENAME);
}

/**
 * The text a synopsis is indexed as: the narrative rendered as prose when
 * there is one, the raw output otherwise (a profile whose prompt asks for
 * markdown returns prose already).
 */
export function synopsisIndexText(synopsis: string, narrative?: DirectorNotesNarrative): string {
	if (narrative) return narrativeToMarkdown(narrative).trim();
	const parsed = parseDirectorNotesNarrative(synopsis);
	return (parsed.ok ? narrativeToMarkdown(parsed.narrative) : synopsis).trim();
}

/** Whether Semantic search is assigned a source, so a synopsis is worth keeping. */
function semanticSearchAssigned(): boolean {
	return resolveLocalModelAssignment(readLocalModelAssignments(), 'semantic-search').type !== 'off';
}

function parseRecord(line: string): ArchivedSynopsis | null {
	try {
		const value = JSON.parse(line) as Partial<ArchivedSynopsis> | null;
		if (
			!value ||
			typeof value.id !== 'string' ||
			typeof value.text !== 'string' ||
			typeof value.generatedAt !== 'number' ||
			typeof value.lookbackDays !== 'number'
		) {
			return null;
		}
		return {
			id: value.id,
			generatedAt: value.generatedAt,
			lookbackDays: value.lookbackDays,
			...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
			text: value.text,
		};
	} catch {
		return null;
	}
}

/**
 * Every archived synopsis, oldest first. A missing file is an empty archive; a
 * line that does not parse is skipped rather than failing the read.
 */
export async function readDirectorNotesArchive(dataDir?: string): Promise<ArchivedSynopsis[]> {
	let raw: string;
	try {
		raw = await fs.readFile(directorNotesArchivePath(dataDir), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	const records: ArchivedSynopsis[] = [];
	for (const line of raw.split('\n')) {
		if (line.trim() === '') continue;
		const record = parseRecord(line);
		if (record) records.push(record);
	}
	return records;
}

export interface ArchiveSynopsisOptions {
	dataDir?: string;
	/** Injected in tests. Defaults to "Semantic search is assigned a source". */
	isEnabled?: () => boolean;
}

/**
 * Keep one generated synopsis. Resolves to the stored record, or `null` when
 * nothing was written (the task is off, or the synopsis has no text).
 */
export async function archiveDirectorNotesSynopsis(
	input: ArchiveSynopsisInput,
	options: ArchiveSynopsisOptions = {}
): Promise<ArchivedSynopsis | null> {
	if (!(options.isEnabled ?? semanticSearchAssigned)()) return null;
	const text = synopsisIndexText(input.synopsis, input.narrative);
	if (text === '') return null;

	const record: ArchivedSynopsis = {
		id: randomUUID(),
		generatedAt: input.generatedAt ?? Date.now(),
		lookbackDays: input.lookbackDays,
		...(input.provider ? { provider: input.provider } : {}),
		text,
	};
	const filePath = directorNotesArchivePath(options.dataDir);

	// One read-modify-write at a time: two synopses finishing together must
	// both land, and the trim must not drop the one written a moment before.
	await writeQueue.enqueue(filePath, async () => {
		const kept = [...(await readDirectorNotesArchive(options.dataDir)), record].slice(
			-MAX_ARCHIVED_SYNOPSES
		);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await atomicWriteFile(filePath, kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
	});

	for (const listener of listeners) {
		try {
			listener(record);
		} catch (error) {
			logger.warn(`Synopsis archive listener failed: ${error}`, LOG_CONTEXT);
		}
	}
	return record;
}

/**
 * {@link archiveDirectorNotesSynopsis} for a caller that must not wait on it or
 * fail because of it: both synopsis paths (the IPC handler and the web / CLI
 * callback) call this on their way out.
 */
export function archiveDirectorNotesSynopsisInBackground(input: ArchiveSynopsisInput): void {
	void archiveDirectorNotesSynopsis(input).catch((error) => {
		logger.warn(`Could not archive a Director's Notes synopsis: ${error}`, LOG_CONTEXT);
	});
}

/** Listen for newly archived synopses. Returns the unsubscribe. */
export function onDirectorNotesArchived(listener: (record: ArchivedSynopsis) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
