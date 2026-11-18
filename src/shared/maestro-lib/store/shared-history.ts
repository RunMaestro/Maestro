/**
 * The shared History files in a project: `<project>/.maestro/history/history-<label>.jsonl`.
 *
 * Every Maestro that works in a project writes its History entries to its OWN file there, named
 * by a label (the desktop uses its hostname), and reads every other file to show the work done
 * from other machines. One writer per file means no write ever conflicts. Each entry carries a
 * `hostname`: the label the History panel shows and filters by. An entry without one is given
 * its file's label on read.
 *
 * The desktop (`src/main/shared-history-manager.ts`) and a headless `maestro-cli host` both go
 * through these functions, so the two cannot disagree about the format. A host writes under
 * `hostSharedHistoryLabel()`, never under the bare hostname: a desktop on the same machine owns
 * that file and skips it on read, so the host's entries would be invisible to it.
 *
 * Synchronous and throwing: a caller decides whether a failure matters (it never should fail the
 * turn the entry describes).
 */

import * as fs from 'fs';
import * as path from 'path';

import { SHARED_HISTORY_DIR } from '../../maestro-paths';
import type { HistoryEntry } from '../../types';

const FILE_PREFIX = 'history-';
const FILE_EXT = '.jsonl';
/** What a headless host adds to its hostname to name its own shared file. */
export const HOST_SHARED_HISTORY_SUFFIX = '.host';

/** The shared History directory of a project. */
export function sharedHistoryDir(projectPath: string): string {
	return path.join(projectPath, SHARED_HISTORY_DIR);
}

/** The file one writer owns, from its label. The label is made safe for a file name. */
export function sharedHistoryFilename(label: string): string {
	return `${FILE_PREFIX}${label.replace(/[^a-zA-Z0-9._-]/g, '_')}${FILE_EXT}`;
}

/** The label a shared History file is named by, or null for a file that is not one. */
export function sharedHistoryLabelOf(filename: string): string | null {
	if (!filename.startsWith(FILE_PREFIX) || !filename.endsWith(FILE_EXT)) return null;
	const label = filename.slice(FILE_PREFIX.length, filename.length - FILE_EXT.length);
	return label || null;
}

/** The label a headless host writes under: its hostname plus `.host`. */
export function hostSharedHistoryLabel(hostname: string): string {
	return `${hostname}${HOST_SHARED_HISTORY_SUFFIX}`;
}

/**
 * The entries in one shared file's text. A line that is not JSON costs that line only and is
 * counted. An entry with no `hostname` gets `sourceLabel`.
 */
export function parseSharedHistoryJsonl(
	content: string,
	sourceLabel: string
): { entries: HistoryEntry[]; malformedLines: number } {
	const entries: HistoryEntry[] = [];
	let malformedLines = 0;
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed) as HistoryEntry;
			if (!entry.hostname) entry.hostname = sourceLabel;
			entries.push(entry);
		} catch {
			malformedLines++;
		}
	}
	return { entries, malformedLines };
}

/**
 * Keep only the newest `maxEntries` lines of a shared file (the end of the file is newest). The
 * trimmed text goes to a temporary file that is renamed over the original, so another Maestro
 * reading the file never sees it half written.
 */
export function rotateSharedHistoryFile(file: string, maxEntries: number): boolean {
	const lines = fs
		.readFileSync(file, 'utf-8')
		.split('\n')
		.filter((line) => line.trim());
	if (lines.length <= maxEntries) return false;
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${lines.slice(lines.length - maxEntries).join('\n')}\n`, 'utf-8');
	fs.renameSync(tmp, file);
	return true;
}

/**
 * Append one entry to the file `label` owns, creating the directory when needed. The entry is
 * written as given: the caller sets its `hostname`. Returns the file written; trim it with
 * `rotateSharedHistoryFile()`.
 */
export function appendSharedHistoryEntry(
	projectPath: string,
	label: string,
	entry: HistoryEntry
): string {
	const dir = sharedHistoryDir(projectPath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, sharedHistoryFilename(label));
	fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf-8');
	return file;
}

/** The shared files in a project other than `excludeLabel`'s own. None when the directory is missing. */
export function listSharedHistoryFiles(projectPath: string, excludeLabel?: string): string[] {
	const dir = sharedHistoryDir(projectPath);
	if (!fs.existsSync(dir)) return [];
	const own = excludeLabel !== undefined ? sharedHistoryFilename(excludeLabel) : undefined;
	return fs.readdirSync(dir).filter((name) => sharedHistoryLabelOf(name) !== null && name !== own);
}

export interface ReadSharedHistoryOptions {
	/** Leave out this writer's own file: its entries come from its own store. */
	excludeLabel?: string;
	/** Read at most the newest this many entries of each file. */
	maxEntriesPerFile?: number;
	/** A file that could not be read. The others are still read. */
	onFileError?(file: string, error: unknown): void;
	/** A file held lines that were not JSON: `count` of them were skipped. */
	onMalformedLines?(file: string, count: number): void;
}

/** Every other writer's entries in a project, file by file, oldest first within a file. */
export function readSharedHistoryEntries(
	projectPath: string,
	options: ReadSharedHistoryOptions = {}
): HistoryEntry[] {
	const dir = sharedHistoryDir(projectPath);
	const out: HistoryEntry[] = [];
	for (const name of listSharedHistoryFiles(projectPath, options.excludeLabel)) {
		const file = path.join(dir, name);
		try {
			const { entries, malformedLines } = parseSharedHistoryJsonl(
				fs.readFileSync(file, 'utf-8'),
				sharedHistoryLabelOf(name) ?? name
			);
			if (malformedLines > 0) options.onMalformedLines?.(file, malformedLines);
			const max = options.maxEntriesPerFile;
			out.push(...(max !== undefined && entries.length > max ? entries.slice(-max) : entries));
		} catch (error) {
			options.onFileError?.(file, error);
		}
	}
	return out;
}
