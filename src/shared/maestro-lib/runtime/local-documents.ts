/**
 * The Auto Run documents port over the local file system.
 *
 * The engine reads and writes a playbook document through a port so the CLI and the runtime run
 * one loop. This is the runtime's side: a document is `<folder>/<name>.md`, a missing or
 * unreadable one reads as empty with no tasks (the engine then skips it), and counting is
 * `countMarkdownTasks`, the fence-aware scan the stall guard and the Auto Run document list
 * already use, so a `- [ ]` in a code example is never a task (C1).
 */

import * as fs from 'fs';
import * as path from 'path';

import {
	CHECKED_TASK_REGEX,
	UNCHECKED_TASK_REGEX,
	countMarkdownTasks,
	forEachMarkdownLine,
} from '../../markdownTaskScan';
import type { AutoRunDeps, AutoRunDocumentRead } from '../autorun/engine-types';

const UNCHECKED_PREFIX = /^[\s]*[-*+]\s*\[\s*\]\s*/;

/** `<folder>/<name>.md`. `name` may carry subfolders, `/`-separated. */
function documentPath(folder: string, name: string): string {
	return path.join(folder, `${name}.md`);
}

/** The engine's documents port, with the synchronous answers a local file system gives. */
export type LocalDocuments = Omit<AutoRunDeps['documents'], 'read' | 'readTasks' | 'write'> & {
	read(folder: string, name: string): AutoRunDocumentRead;
	readTasks(folder: string, name: string): { content: string; tasks: string[] };
	write(folder: string, file: string, content: string): void;
};

export function createLocalDocuments(): LocalDocuments {
	function readContent(folder: string, name: string): string {
		try {
			return fs.readFileSync(documentPath(folder, name), 'utf-8');
		} catch {
			return '';
		}
	}

	return {
		read(folder, name) {
			const file = documentPath(folder, name);
			let content: string;
			try {
				content = fs.readFileSync(file, 'utf-8');
			} catch (error) {
				// A document that does not exist is a broken playbook, which the engine reports
				// (DOCUMENT_NOT_FOUND). Any other read failure stays an empty document.
				return (error as NodeJS.ErrnoException).code === 'ENOENT'
					? { content: '', unchecked: 0, checked: 0, missingPath: file }
					: { content: '', unchecked: 0, checked: 0 };
			}
			const { unchecked, checked } = countMarkdownTasks(content);
			return { content, unchecked, checked };
		},
		readTasks(folder, name) {
			const content = readContent(folder, name);
			const tasks: string[] = [];
			forEachMarkdownLine(content, (line) => {
				if (UNCHECKED_TASK_REGEX.test(line)) tasks.push(line.replace(UNCHECKED_PREFIX, '').trim());
			});
			return { content, tasks };
		},
		write(folder, file, content) {
			const target = path.join(folder, file);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content, 'utf-8');
		},
		uncheckAll: (content) => content.replace(CHECKED_TASK_REGEX, '$1[ ]'),
	};
}
