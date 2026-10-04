/**
 * The agent's Auto Run folder as a list of documents (AR-1).
 *
 * Read-only apart from `createAutoRunDocument`: a document is the user's own
 * file in their project, so listing and counting never touch it. Counting rides
 * `countMarkdownTasks`, the same fence-aware scan both Auto Run engines use, so
 * the done / total shown here is the figure the run itself will work from.
 *
 * Listing mirrors the desktop's `autorun:listDocs` (folders only when they hold
 * a document, names without `.md`, dotfiles skipped), with one deliberate
 * difference: `*.backup.md` files are left out. The desktop writes those beside
 * a document for reset-on-completion, and they are not something to run.
 */

import * as fs from 'fs';
import * as path from 'path';

import { countMarkdownTasks } from '../../markdownTaskScan';
import { PLAYBOOKS_DIR } from '../../maestro-paths';
import { validateAutoRunDocument, type AutoRunIssue } from './validate';

/** The fields of an agent record that decide where its Auto Run folder is. */
export interface AutoRunFolderSource {
	cwd?: unknown;
	projectRoot?: unknown;
	fullPath?: unknown;
	autoRunFolderPath?: unknown;
}

const asPath = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() !== '' ? value : undefined;

/**
 * Where an agent's Auto Run documents live: its own `autoRunFolderPath`, else
 * `.maestro/playbooks` under its project (the same default the `AUTORUN_FOLDER`
 * template variable gives an agent). A relative folder is read from the project.
 * `undefined` when the agent has neither a folder nor a directory.
 */
export function resolveAutoRunFolder(agent: AutoRunFolderSource): string | undefined {
	const root = asPath(agent.fullPath) ?? asPath(agent.projectRoot) ?? asPath(agent.cwd);
	const own = asPath(agent.autoRunFolderPath);
	if (own) return path.isAbsolute(own) || !root ? own : path.join(root, own);
	return root ? path.join(root, PLAYBOOKS_DIR) : undefined;
}

export interface AutoRunDocument {
	/** Path under the folder, `/`-separated, without `.md`: what a run names it. */
	name: string;
	/** Absolute path of the file. */
	file: string;
	checked: number;
	unchecked: number;
	total: number;
	modifiedMs: number;
}

export type AutoRunListing =
	| { status: 'ok'; folder: string; documents: AutoRunDocument[] }
	| { status: 'missing'; folder: string }
	| { status: 'unreadable'; folder: string; reason: string };

const MARKDOWN_EXT = '.md';
const BACKUP_SUFFIX = '.backup.md';

function isDocumentFile(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(MARKDOWN_EXT) && !lower.endsWith(BACKUP_SUFFIX);
}

function collect(dir: string, prefix: string, seen: Set<string>, out: AutoRunDocument[]): void {
	const real = fs.realpathSync(dir);
	// A symlink loop would otherwise list the same folder forever.
	if (seen.has(real)) return;
	seen.add(real);

	const entries = fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => !entry.name.startsWith('.'))
		.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		let stats: fs.Stats;
		try {
			stats = fs.statSync(full);
		} catch {
			// A broken symlink or a file removed mid-read: nothing to list.
			continue;
		}
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (stats.isDirectory()) {
			collect(full, relative, seen, out);
		} else if (stats.isFile() && isDocumentFile(entry.name)) {
			let content: string;
			try {
				content = fs.readFileSync(full, 'utf8');
			} catch {
				continue;
			}
			const counts = countMarkdownTasks(content);
			out.push({
				name: relative.slice(0, -MARKDOWN_EXT.length),
				file: full,
				checked: counts.checked,
				unchecked: counts.unchecked,
				total: counts.total,
				modifiedMs: stats.mtimeMs,
			});
		}
	}
}

/** Every document under `folder`, in folder-then-name order. Never throws. */
export function listAutoRunDocuments(folder: string): AutoRunListing {
	try {
		if (!fs.statSync(folder).isDirectory()) {
			return { status: 'unreadable', folder, reason: 'It is not a folder.' };
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', folder };
		return { status: 'unreadable', folder, reason: (error as Error).message };
	}
	try {
		const documents: AutoRunDocument[] = [];
		collect(folder, '', new Set(), documents);
		// Folders sort before files at each level, as the desktop's tree draws them.
		documents.sort((a, b) => compareNames(a.name, b.name));
		return { status: 'ok', folder, documents };
	} catch (error) {
		return { status: 'unreadable', folder, reason: (error as Error).message };
	}
}

function compareNames(a: string, b: string): number {
	const left = a.split('/');
	const right = b.split('/');
	for (let i = 0; i < Math.min(left.length, right.length); i++) {
		if (left[i] === right[i]) continue;
		const leftIsFolder = i < left.length - 1;
		const rightIsFolder = i < right.length - 1;
		if (leftIsFolder !== rightIsFolder) return leftIsFolder ? -1 : 1;
		return left[i].toLowerCase().localeCompare(right[i].toLowerCase());
	}
	return left.length - right.length;
}

export type DocumentCheck =
	| { status: 'ok'; issues: AutoRunIssue[] }
	| { status: 'unreadable'; reason: string };

/** Reads a document and validates it. Never throws: an unreadable file is a result. */
export function checkAutoRunDocument(file: string): DocumentCheck {
	try {
		return { status: 'ok', issues: validateAutoRunDocument(fs.readFileSync(file, 'utf8')) };
	} catch (error) {
		return { status: 'unreadable', reason: (error as Error).message };
	}
}
