import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	autoRunDocumentTemplate,
	checkAutoRunDocument,
	countMarkdownTasks,
	createAutoRunDocument,
	findLastAutoRun,
	listAutoRunDocuments,
	normalizeDocumentName,
	resolveAutoRunFolder,
	summarizeAutoRunIssues,
	titleFromDocumentName,
	validateAutoRunDocument,
} from '../../index';

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-autorun-'));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const write = (relative: string, content: string) => {
	const file = path.join(dir, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
};

describe('resolveAutoRunFolder (AR-1)', () => {
	it('defaults to .maestro/playbooks under the project', () => {
		expect(resolveAutoRunFolder({ cwd: '/work/app' })).toBe(
			path.join('/work/app', '.maestro/playbooks')
		);
		// The same root the AUTORUN_FOLDER template variable uses: fullPath, then projectRoot, then cwd.
		expect(resolveAutoRunFolder({ cwd: '/a', projectRoot: '/b', fullPath: '/c' })).toBe(
			path.join('/c', '.maestro/playbooks')
		);
	});

	it("uses the agent's own folder, resolving a relative one from the project", () => {
		expect(resolveAutoRunFolder({ cwd: '/work', autoRunFolderPath: '/docs/runs' })).toBe(
			'/docs/runs'
		);
		expect(resolveAutoRunFolder({ cwd: '/work', autoRunFolderPath: 'docs/runs' })).toBe(
			path.join('/work', 'docs/runs')
		);
	});

	it('has no folder for an agent with no directory, and ignores blank values', () => {
		expect(resolveAutoRunFolder({})).toBeUndefined();
		expect(resolveAutoRunFolder({ cwd: '  ', autoRunFolderPath: '' })).toBeUndefined();
	});
});

describe('listAutoRunDocuments (AR-1)', () => {
	it('counts done and total with the engines scan, ignoring fenced examples', () => {
		write(
			'plan.md',
			[
				'# Plan',
				'- [x] done one',
				'- [X] done two',
				'- [ ] open one',
				'```',
				'- [ ] an example, not a task',
				'```',
			].join('\n')
		);
		const listing = listAutoRunDocuments(dir);
		expect(listing.status).toBe('ok');
		if (listing.status !== 'ok') return;
		expect(listing.documents).toHaveLength(1);
		expect(listing.documents[0]).toMatchObject({
			name: 'plan',
			checked: 2,
			unchecked: 1,
			total: 3,
		});
		// The listing and the engines count the same document the same way.
		expect(countMarkdownTasks(fs.readFileSync(listing.documents[0].file, 'utf8')).total).toBe(3);
	});

	it('names documents without .md, lists subfolders first, and skips dotfiles and backups', () => {
		write('b.md', '- [ ] one');
		write('A.md', '- [ ] one');
		write('phase-1/setup.md', '- [ ] one');
		write('.hidden/skip.md', '- [ ] one');
		write('.dotfile.md', '- [ ] one');
		write('b.backup.md', '- [ ] one');
		write('notes.txt', '- [ ] not markdown');
		const listing = listAutoRunDocuments(dir);
		expect(listing.status === 'ok' && listing.documents.map((d) => d.name)).toEqual([
			'phase-1/setup',
			'A',
			'b',
		]);
	});

	it('reports a missing folder and a file where a folder should be', () => {
		expect(listAutoRunDocuments(path.join(dir, 'nope'))).toEqual({
			status: 'missing',
			folder: path.join(dir, 'nope'),
		});
		const file = write('file.md', 'x');
		expect(listAutoRunDocuments(file).status).toBe('unreadable');
	});

	it('does not loop on a symlink back to the folder', () => {
		write('a.md', '- [ ] one');
		fs.symlinkSync(dir, path.join(dir, 'loop'));
		const listing = listAutoRunDocuments(dir);
		expect(listing.status === 'ok' && listing.documents.map((d) => d.name)).toEqual(['a']);
	});
});

describe('validateAutoRunDocument (AR-2)', () => {
	const issuesOf = (text: string) => validateAutoRunDocument(text);

	it('accepts a document of plain tasks', () => {
		expect(issuesOf('# T\n\n- [ ] one\n- [x] two\n')).toEqual([]);
		expect(summarizeAutoRunIssues([])).toBe('no problems');
	});

	it('warns, by line, about a checkbox that is not a task', () => {
		const issues = issuesOf(
			['- [ ] real', '1. [ ] numbered', '[ ] bare', '- [ ]', '- [-] odd mark'].join('\n')
		);
		expect(issues).toEqual([
			{ severity: 'warning', line: 2, message: expect.stringContaining('numbered') },
			{ severity: 'warning', line: 3, message: expect.stringContaining('leading dash') },
			{ severity: 'warning', line: 4, message: 'This task has no text.' },
			{ severity: 'warning', line: 5, message: expect.stringContaining('ignored') },
		]);
	});

	it('does not read a fenced example as a mistake', () => {
		expect(issuesOf('- [ ] real\n```\n1. [ ] numbered\n```\n')).toEqual([]);
	});

	it('flags a halt marker standing alone as an error, on its own line', () => {
		const issues = issuesOf('- [x] done\n<!-- maestro:halt: build broken -->\n- [ ] next\n');
		expect(issues).toEqual([
			{ severity: 'error', line: 2, message: expect.stringContaining('build broken') },
		]);
		expect(summarizeAutoRunIssues(issues)).toBe('1 error');
	});

	it('treats a halt marker in backticks, a fence, or on a task line as an example', () => {
		const text = [
			'- [ ] write `<!-- maestro:halt: x -->` when stuck',
			'```',
			'<!-- maestro:halt -->',
			'```',
			'- [ ] a task <!-- maestro:halt: described -->',
		].join('\n');
		expect(issuesOf(text)).toEqual([]);
	});

	it('warns about a marker value Maestro does not know, and notes a live human gate', () => {
		const issues = issuesOf(
			[
				'<!-- MAESTRO:MODEL tier="hgih" -->',
				'<!-- MAESTRO:HITL reason="Add the API key" -->',
				'- [ ] needs a key',
			].join('\n')
		);
		expect(issues).toEqual([
			{ severity: 'warning', line: 1, message: expect.stringContaining('tier="hgih"') },
			{ severity: 'info', line: 2, message: 'A human gate pauses the run here: Add the API key.' },
		]);
	});

	it('warns once, for the whole document, when there are no tasks', () => {
		expect(issuesOf('# Just prose\n')).toEqual([
			{ severity: 'warning', line: 0, message: expect.stringContaining('No tasks') },
		]);
	});

	it('summarizes errors and warnings with the right plurals', () => {
		expect(
			summarizeAutoRunIssues([
				{ severity: 'error', line: 1, message: '' },
				{ severity: 'error', line: 2, message: '' },
				{ severity: 'warning', line: 3, message: '' },
				{ severity: 'info', line: 4, message: '' },
			])
		).toBe('2 errors, 1 warning');
	});

	it('checks a file on disk, and reports one it cannot read', () => {
		const file = write('a.md', '[ ] bare\n- [ ] ok');
		const result = checkAutoRunDocument(file);
		expect(result.status === 'ok' && result.issues.map((i) => i.line)).toEqual([1]);
		expect(checkAutoRunDocument(path.join(dir, 'gone.md')).status).toBe('unreadable');
	});
});

describe('new documents (AR-2)', () => {
	it('a template is valid and its title comes from the name', () => {
		expect(titleFromDocumentName('phase-2/api_setup')).toBe('Api Setup');
		const text = autoRunDocumentTemplate('phase-1/setup');
		expect(text.startsWith('# Setup\n')).toBe(true);
		expect(validateAutoRunDocument(text)).toEqual([]);
		expect(countMarkdownTasks(text).unchecked).toBe(2);
	});

	it('normalizes a typed name and refuses one that leaves the folder', () => {
		expect(normalizeDocumentName(' phase-1/Setup.md ')).toEqual({
			ok: true,
			name: 'phase-1/Setup',
		});
		for (const bad of [
			'',
			'  ',
			'/etc/passwd',
			'C:\\x',
			'../up',
			'a//b',
			'.hidden',
			'a/.b',
			'x?y',
		]) {
			expect(normalizeDocumentName(bad).ok, bad).toBe(false);
		}
	});

	it('writes the template, creating the folder and any subfolder', () => {
		const folder = path.join(dir, 'playbooks');
		const created = createAutoRunDocument(folder, 'phase-1/setup');
		expect(created.ok && created.file).toBe(path.join(folder, 'phase-1', 'setup.md'));
		expect(fs.readFileSync(path.join(folder, 'phase-1', 'setup.md'), 'utf8')).toBe(
			autoRunDocumentTemplate('phase-1/setup')
		);
	});

	it('never overwrites a document that exists', () => {
		const folder = path.join(dir, 'playbooks');
		createAutoRunDocument(folder, 'plan');
		fs.writeFileSync(path.join(folder, 'plan.md'), 'mine');
		expect(createAutoRunDocument(folder, 'plan.md')).toEqual({
			ok: false,
			reason: 'plan.md already exists.',
		});
		expect(fs.readFileSync(path.join(folder, 'plan.md'), 'utf8')).toBe('mine');
	});
});

describe('findLastAutoRun (AR-1)', () => {
	const writeHistory = (entries: Array<Record<string, unknown>>) => {
		fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'history', 'a1.jsonl'),
			entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
		);
	};
	const entry = (id: string, type: string, timestamp: number, extra = {}) => ({
		id,
		type,
		timestamp,
		summary: id,
		projectPath: '/p',
		...extra,
	});

	it('is the newest AUTO entry, past newer USER entries', () => {
		writeHistory([
			entry('old-auto', 'AUTO', 100, { success: true }),
			entry('new-auto', 'AUTO', 200, { success: false }),
			entry('user', 'USER', 300),
		]);
		expect(findLastAutoRun({ historyDir: path.join(dir, 'history') }, 'a1')).toEqual({
			at: 200,
			success: false,
			summary: 'new-auto',
		});
	});

	it('finds one beyond the first page of newer entries', () => {
		const entries = [entry('auto', 'AUTO', 1)];
		for (let i = 0; i < 450; i++) entries.push(entry(`u${i}`, 'USER', 10 + i));
		writeHistory(entries);
		expect(findLastAutoRun({ historyDir: path.join(dir, 'history') }, 'a1')?.at).toBe(1);
	});

	it('is undefined with no AUTO entry and with no history file', () => {
		writeHistory([entry('user', 'USER', 5)]);
		expect(findLastAutoRun({ historyDir: path.join(dir, 'history') }, 'a1')).toBeUndefined();
		expect(findLastAutoRun({ historyDir: path.join(dir, 'history') }, 'none')).toBeUndefined();
	});
});
