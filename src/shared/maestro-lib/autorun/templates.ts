/**
 * A new Auto Run document (AR-2): a name that is safe to write, a template that
 * already uses the mandatory `- [ ]` task format, and the create that refuses to
 * overwrite a document the user already has.
 */

import * as fs from 'fs';
import * as path from 'path';

/** A readable title from a document name: `phase-2/api-setup` becomes `Api Setup`. */
export function titleFromDocumentName(name: string): string {
	const base = name.split('/').pop() ?? name;
	return (
		base
			.replace(/\.md$/i, '')
			.split(/[\s_-]+/)
			.filter(Boolean)
			.map((word) => word[0].toUpperCase() + word.slice(1))
			.join(' ') || 'Untitled'
	);
}

/** The text a new document starts with. */
export function autoRunDocumentTemplate(name: string): string {
	return [
		`# ${titleFromDocumentName(name)}`,
		'',
		'Say what this document should get done, and anything the agent must know first.',
		'',
		'## Tasks',
		'',
		'- [ ] First task: say exactly what to do and how to tell it is done.',
		'- [ ] Second task: each task is one checkbox, and Auto Run works them top to bottom.',
		'',
	].join('\n');
}

export type DocumentNameResult = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Checks a typed document name. It may name a subfolder (`phase-1/setup`), but it
 * stays inside the folder: no absolute path, no `..`, no hidden segment. A
 * trailing `.md` is dropped, so `setup` and `setup.md` mean the same document.
 */
export function normalizeDocumentName(input: string): DocumentNameResult {
	const trimmed = input.trim().replace(/\\/g, '/').replace(/\.md$/i, '');
	if (trimmed === '') return { ok: false, reason: 'Give the document a name.' };
	if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
		return { ok: false, reason: 'Use a name inside the Auto Run folder, not a full path.' };
	}
	const segments = trimmed.split('/');
	if (segments.some((segment) => segment.trim() === '')) {
		return { ok: false, reason: 'A name cannot have an empty folder part.' };
	}
	if (segments.some((segment) => segment.startsWith('.'))) {
		return { ok: false, reason: 'A name cannot start with a dot.' };
	}
	if (/[<>:"|?*\u0000-\u001f]/.test(trimmed)) {
		return { ok: false, reason: 'A name cannot hold < > : " | ? * or control characters.' };
	}
	return { ok: true, name: segments.map((segment) => segment.trim()).join('/') };
}

export type CreateDocumentResult =
	| { ok: true; name: string; file: string }
	| { ok: false; reason: string };

/**
 * Writes the template as `<folder>/<name>.md`, creating the folder and any
 * subfolder. An existing document is never overwritten.
 */
export function createAutoRunDocument(folder: string, input: string): CreateDocumentResult {
	const checked = normalizeDocumentName(input);
	if (!checked.ok) return checked;
	const file = path.join(folder, `${checked.name}.md`);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// `wx` fails when the file exists, so a race cannot overwrite it either.
		fs.writeFileSync(file, autoRunDocumentTemplate(checked.name), { flag: 'wx' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			return { ok: false, reason: `${checked.name}.md already exists.` };
		}
		return { ok: false, reason: `Could not create the document: ${(error as Error).message}` };
	}
	return { ok: true, name: checked.name, file };
}
