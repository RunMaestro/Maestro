import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	HOST_SHARED_HISTORY_SUFFIX,
	appendSharedHistoryEntry,
	hostSharedHistoryLabel,
	listSharedHistoryFiles,
	parseSharedHistoryJsonl,
	readSharedHistoryEntries,
	rotateSharedHistoryFile,
	sharedHistoryDir,
	sharedHistoryFilename,
	sharedHistoryLabelOf,
} from '../shared-history';
import type { HistoryEntry } from '../../../types';

function entry(id: string, timestamp: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return { id, type: 'USER', timestamp, summary: `summary ${id}`, projectPath: '/p', ...overrides };
}

function jsonl(entries: unknown[]): string {
	return entries.map((e) => `${JSON.stringify(e)}\n`).join('');
}

describe('shared History names', () => {
	it('puts the directory under .maestro/history of the project', () => {
		expect(sharedHistoryDir('/work/app')).toBe(path.join('/work/app', '.maestro/history'));
	});

	it('names a writer file by its label, made safe for a file name', () => {
		expect(sharedHistoryFilename('laptop.local')).toBe('history-laptop.local.jsonl');
		expect(sharedHistoryFilename('my box/1:x')).toBe('history-my_box_1_x.jsonl');
		expect(sharedHistoryFilename('a_b-c')).toBe('history-a_b-c.jsonl');
	});

	it('reads the label back from a history file name, and null for anything else', () => {
		expect(sharedHistoryLabelOf('history-laptop.local.jsonl')).toBe('laptop.local');
		expect(sharedHistoryLabelOf('history-box.host.jsonl')).toBe('box.host');
		expect(sharedHistoryLabelOf('history-.jsonl')).toBeNull();
		expect(sharedHistoryLabelOf('notes.jsonl')).toBeNull();
		expect(sharedHistoryLabelOf('history-laptop.json')).toBeNull();
		expect(sharedHistoryLabelOf('.DS_Store')).toBeNull();
	});

	it('labels a headless host by its hostname plus .host', () => {
		expect(HOST_SHARED_HISTORY_SUFFIX).toBe('.host');
		expect(hostSharedHistoryLabel('build-box')).toBe('build-box.host');
		expect(sharedHistoryLabelOf(sharedHistoryFilename(hostSharedHistoryLabel('build-box')))).toBe(
			'build-box.host'
		);
	});
});

describe('parseSharedHistoryJsonl', () => {
	it('parses each line, skipping blank lines', () => {
		const { entries, malformedLines } = parseSharedHistoryJsonl(
			`${jsonl([entry('a', 1, { hostname: 'h1' }), entry('b', 2, { hostname: 'h1' })])}\n  \n`,
			'h1'
		);
		expect(entries.map((e) => e.id)).toEqual(['a', 'b']);
		expect(malformedLines).toBe(0);
	});

	it('counts each line that is not JSON and keeps the rest', () => {
		const { entries, malformedLines } = parseSharedHistoryJsonl(
			`not json\n${jsonl([entry('a', 1)])}{"half":\n`,
			'h1'
		);
		expect(entries.map((e) => e.id)).toEqual(['a']);
		expect(malformedLines).toBe(2);
	});

	it('gives an entry without a hostname the file label, and keeps one that has it', () => {
		const { entries } = parseSharedHistoryJsonl(
			jsonl([entry('a', 1), entry('b', 2, { hostname: 'elsewhere' })]),
			'box.host'
		);
		expect(entries.map((e) => e.hostname)).toEqual(['box.host', 'elsewhere']);
	});

	it('answers nothing for empty text', () => {
		expect(parseSharedHistoryJsonl('', 'x')).toEqual({ entries: [], malformedLines: 0 });
	});
});

describe('shared History files on disk', () => {
	let project: string;
	const dir = () => sharedHistoryDir(project);
	const write = (label: string, content: string) => {
		fs.mkdirSync(dir(), { recursive: true });
		const file = path.join(dir(), sharedHistoryFilename(label));
		fs.writeFileSync(file, content);
		return file;
	};

	beforeEach(() => {
		project = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lib-shared-history-'));
	});

	afterEach(() => {
		fs.rmSync(project, { recursive: true, force: true });
	});

	describe('appendSharedHistoryEntry', () => {
		it('creates the directory when it is missing and appends one JSON line', () => {
			const file = appendSharedHistoryEntry(project, 'box.host', entry('a', 1));
			expect(file).toBe(path.join(dir(), 'history-box.host.jsonl'));
			appendSharedHistoryEntry(project, 'box.host', entry('b', 2, { hostname: 'laptop' }));
			const lines = fs.readFileSync(file, 'utf-8').split('\n');
			expect(lines).toHaveLength(3);
			expect(lines[2]).toBe('');
			expect(JSON.parse(lines[0])).toEqual(entry('a', 1));
			// Written as given: the caller sets the hostname, the module never stamps one.
			expect(JSON.parse(lines[0]).hostname).toBeUndefined();
			expect(JSON.parse(lines[1]).hostname).toBe('laptop');
		});

		it('leaves the other files in an existing directory alone', () => {
			const other = write('laptop', jsonl([entry('x', 1)]));
			appendSharedHistoryEntry(project, 'box.host', entry('a', 1));
			expect(fs.readFileSync(other, 'utf-8')).toBe(jsonl([entry('x', 1)]));
		});

		it('sanitizes the label into the file name', () => {
			const file = appendSharedHistoryEntry(project, 'my box', entry('a', 1));
			expect(path.basename(file)).toBe('history-my_box.jsonl');
		});
	});

	describe('rotateSharedHistoryFile', () => {
		it('does nothing and answers false at or under the limit', () => {
			const content = jsonl([entry('a', 1), entry('b', 2)]);
			const file = write('h', content);
			expect(rotateSharedHistoryFile(file, 2)).toBe(false);
			expect(fs.readFileSync(file, 'utf-8')).toBe(content);
		});

		it('keeps the newest lines (the end of the file) and answers true over the limit', () => {
			const file = write(
				'h',
				`${jsonl([entry('a', 1), entry('b', 2)])}\n${jsonl([entry('c', 3)])}`
			);
			expect(rotateSharedHistoryFile(file, 2)).toBe(true);
			expect(fs.readFileSync(file, 'utf-8')).toBe(jsonl([entry('b', 2), entry('c', 3)]));
		});

		it('throws for a file that is not there', () => {
			expect(() => rotateSharedHistoryFile(path.join(project, 'missing.jsonl'), 5)).toThrow();
		});
	});

	describe('listSharedHistoryFiles', () => {
		it('lists none when the directory is missing', () => {
			expect(listSharedHistoryFiles(project)).toEqual([]);
			expect(listSharedHistoryFiles(project, 'me')).toEqual([]);
		});

		it('lists only history files, without the excluded label own file', () => {
			write('me', '');
			write('laptop', '');
			write('box.host', '');
			fs.writeFileSync(path.join(dir(), 'README.md'), 'x');
			fs.writeFileSync(path.join(dir(), 'history-.jsonl'), 'x');
			expect(listSharedHistoryFiles(project).sort()).toEqual([
				'history-box.host.jsonl',
				'history-laptop.jsonl',
				'history-me.jsonl',
			]);
			expect(listSharedHistoryFiles(project, 'me').sort()).toEqual([
				'history-box.host.jsonl',
				'history-laptop.jsonl',
			]);
		});

		it('matches the excluded label after sanitizing it', () => {
			write('my box', '');
			write('other', '');
			expect(listSharedHistoryFiles(project, 'my box')).toEqual(['history-other.jsonl']);
		});
	});

	describe('readSharedHistoryEntries', () => {
		it('reads none when the directory is missing', () => {
			expect(readSharedHistoryEntries(project)).toEqual([]);
		});

		it('reads every other writer file, backfilling the hostname from the file label', () => {
			write('me', jsonl([entry('mine', 1)]));
			write('laptop', jsonl([entry('l1', 2), entry('l2', 3, { hostname: 'laptop.local' })]));
			write('box.host', jsonl([entry('b1', 4)]));
			const read = readSharedHistoryEntries(project, { excludeLabel: 'me' });
			expect(read.map((e) => e.id).sort()).toEqual(['b1', 'l1', 'l2']);
			const byId = Object.fromEntries(read.map((e) => [e.id, e.hostname]));
			expect(byId).toEqual({ l1: 'laptop', l2: 'laptop.local', b1: 'box.host' });
		});

		it('includes every file when no label is excluded', () => {
			write('me', jsonl([entry('mine', 1)]));
			write('laptop', jsonl([entry('l1', 2)]));
			expect(
				readSharedHistoryEntries(project)
					.map((e) => e.id)
					.sort()
			).toEqual(['l1', 'mine']);
		});

		it('keeps the newest entries of each file, oldest first within a file', () => {
			write('laptop', jsonl([entry('l1', 1), entry('l2', 2), entry('l3', 3)]));
			write('box', jsonl([entry('b1', 4)]));
			const read = readSharedHistoryEntries(project, { maxEntriesPerFile: 2 });
			const laptop = read.filter((e) => e.hostname === 'laptop').map((e) => e.id);
			expect(laptop).toEqual(['l2', 'l3']);
			expect(read.filter((e) => e.hostname === 'box').map((e) => e.id)).toEqual(['b1']);
		});

		it('skips malformed lines and reports a file it cannot read, still reading the others', () => {
			write('laptop', `garbage\n${jsonl([entry('l1', 1)])}`);
			// A directory with a history file name cannot be read as a file.
			fs.mkdirSync(path.join(dir(), sharedHistoryFilename('broken')));
			const failures: string[] = [];
			const read = readSharedHistoryEntries(project, {
				onFileError: (file) => failures.push(path.basename(file)),
			});
			expect(read.map((e) => e.id)).toEqual(['l1']);
			expect(failures).toEqual(['history-broken.jsonl']);
		});

		it('reports how many malformed lines a file held', () => {
			write('laptop', `garbage\nmore garbage\n${jsonl([entry('l1', 1)])}`);
			write('box', jsonl([entry('b1', 2)]));
			const malformed: Array<[string, number]> = [];
			readSharedHistoryEntries(project, {
				onMalformedLines: (file, count) => malformed.push([path.basename(file), count]),
			});
			expect(malformed).toEqual([['history-laptop.jsonl', 2]]);
		});

		it('swallows a file error when no handler is given', () => {
			fs.mkdirSync(path.join(dir(), sharedHistoryFilename('broken')), { recursive: true });
			write('laptop', jsonl([entry('l1', 1)]));
			expect(readSharedHistoryEntries(project).map((e) => e.id)).toEqual(['l1']);
		});
	});
});
