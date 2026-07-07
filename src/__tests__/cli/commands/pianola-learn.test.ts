/**
 * @file pianola-learn.test.ts
 * @description Tests for `pianola learn`'s transcript fs-walk: the >50MB size
 * skip, newest-first mtime ordering, the per-agent session cap, and the
 * --since / --project / --exclude scope filters. node:fs is mocked; the
 * transcript parsers and classifier run for real so the mined corpus is genuine.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as os from 'os';
import * as path from 'path';

// Shared fs mock for both module specifiers the graph might use.
const fsMock = vi.hoisted(() => ({
	readdirSync: vi.fn(),
	statSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}));
vi.mock('fs', () => fsMock);
vi.mock('node:fs', () => fsMock);

// ./pianola-learn imports ensurePianolaEnabled from ./pianola, which pulls in the
// CLI service modules at load time; stub them so the import is clean.
vi.mock('../../../cli/services/storage', () => ({ readSettingValue: vi.fn() }));
vi.mock('../../../cli/services/pianola-store', () => ({
	readPianolaRules: vi.fn(() => []),
	readPianolaRulesResult: vi.fn(() => ({ rules: [], malformed: false })),
	writePianolaRules: vi.fn((rules) => rules),
	appendPianolaDecision: vi.fn(),
	readPianolaDecisions: vi.fn(() => []),
	getPianolaProfile: vi.fn(() => ({ source: 'none', entry: null })),
}));
vi.mock('../../../cli/services/maestro-client', () => ({
	MaestroClient: class {
		connect = vi.fn();
		sendCommand = vi.fn();
		disconnect = vi.fn();
	},
}));
vi.mock('../../../cli/commands/dispatch', () => ({ runDispatch: vi.fn() }));

import { pianolaLearn } from '../../../cli/commands/pianola-learn';
import { readSettingValue } from '../../../cli/services/storage';

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

interface FakeFile {
	name: string;
	mtimeMs: number;
	size: number;
	content: string;
}

/** A two-line Claude transcript that mines to exactly one decision pair. */
function transcript(cwd: string): string {
	return [
		JSON.stringify({
			cwd,
			uuid: 'a1',
			timestamp: '2026-06-01T00:00:00.000Z',
			message: { role: 'assistant', content: 'Should I rename the variable?' },
		}),
		JSON.stringify({
			cwd,
			uuid: 'u1',
			timestamp: '2026-06-01T00:01:00.000Z',
			message: { role: 'user', content: 'yes go ahead' },
		}),
	].join('\n');
}

let files: FakeFile[] = [];
let consoleSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;

/** Run learn (json mode) and return the parsed stdout payload. */
function runLearn(options: Record<string, unknown> = {}): Record<string, unknown> {
	pianolaLearn({ agent: 'claude-code', json: true, ...options });
	const last = consoleSpy.mock.calls.at(-1);
	if (!last) throw new Error('pianolaLearn produced no stdout');
	return JSON.parse(last[0] as string);
}

/** Basenames passed to fs.readFileSync, in call order. */
function readNames(): string[] {
	return fsMock.readFileSync.mock.calls.map((c) => path.basename(c[0] as string));
}

beforeEach(() => {
	vi.clearAllMocks();
	files = [];
	vi.mocked(readSettingValue).mockReturnValue({ pianola: true });
	consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});

	fsMock.readdirSync.mockImplementation((dir: string) =>
		dir === CLAUDE_DIR ? files.map((f) => ({ name: f.name, isDirectory: () => false })) : []
	);
	fsMock.statSync.mockImplementation((full: string) => {
		const f = files.find((x) => x.name === path.basename(full));
		if (!f) throw new Error(`ENOENT: ${full}`);
		return { mtimeMs: f.mtimeMs, size: f.size, isDirectory: () => false };
	});
	fsMock.readFileSync.mockImplementation((full: string) => {
		const f = files.find((x) => x.name === path.basename(full));
		if (!f) throw new Error(`ENOENT: ${full}`);
		return f.content;
	});
});

describe('pianola learn transcript walk', () => {
	it('skips transcripts larger than 50MB without reading them', () => {
		files = [
			{ name: 'small.jsonl', mtimeMs: 1000, size: 200, content: transcript('/p/a') },
			{
				name: 'huge.jsonl',
				mtimeMs: 2000,
				size: 60 * 1024 * 1024,
				content: transcript('/p/b'),
			},
		];

		const payload = runLearn();

		// The oversized file is enumerated but never read, so it mines no pairs.
		expect(readNames()).toEqual(['small.jsonl']);
		expect(payload.pairCount).toBe(1);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('processes transcripts newest-first by mtime', () => {
		files = [
			{ name: 'oldest.jsonl', mtimeMs: 1000, size: 200, content: transcript('/p/a') },
			{ name: 'newest.jsonl', mtimeMs: 3000, size: 200, content: transcript('/p/b') },
			{ name: 'middle.jsonl', mtimeMs: 2000, size: 200, content: transcript('/p/c') },
		];

		runLearn();

		expect(readNames()).toEqual(['newest.jsonl', 'middle.jsonl', 'oldest.jsonl']);
	});

	it('caps the number of sessions per agent with --limit, keeping the newest', () => {
		files = [
			{ name: 's1.jsonl', mtimeMs: 1000, size: 200, content: transcript('/p/a') },
			{ name: 's2.jsonl', mtimeMs: 2000, size: 200, content: transcript('/p/b') },
			{ name: 's3.jsonl', mtimeMs: 3000, size: 200, content: transcript('/p/c') },
		];

		const payload = runLearn({ limit: '2' });

		expect(readNames()).toEqual(['s3.jsonl', 's2.jsonl']);
		expect((payload.scanned as Record<string, { files: number }>)['claude-code'].files).toBe(2);
		expect(payload.pairCount).toBe(2);
	});

	it('drops transcripts modified before --since', () => {
		files = [
			{
				name: 'old.jsonl',
				mtimeMs: Date.parse('2026-05-01T00:00:00Z'),
				size: 200,
				content: transcript('/p/a'),
			},
			{
				name: 'new.jsonl',
				mtimeMs: Date.parse('2026-07-01T00:00:00Z'),
				size: 200,
				content: transcript('/p/b'),
			},
		];

		const payload = runLearn({ since: '2026-06-01' });

		expect(readNames()).toEqual(['new.jsonl']);
		expect((payload.scanned as Record<string, { files: number }>)['claude-code'].files).toBe(1);
	});

	it('keeps only decisions whose project path matches --project', () => {
		files = [
			{ name: 'a.jsonl', mtimeMs: 2000, size: 200, content: transcript('/home/user/projectA') },
			{ name: 'b.jsonl', mtimeMs: 1000, size: 200, content: transcript('/home/user/projectB') },
		];

		const payload = runLearn({ project: 'projectA' });

		const pairs = payload.pairs as { projectPath: string }[];
		expect(pairs).toHaveLength(1);
		expect(pairs[0].projectPath).toBe('/home/user/projectA');
	});

	it('drops decisions whose project path matches --exclude', () => {
		files = [
			{ name: 'a.jsonl', mtimeMs: 2000, size: 200, content: transcript('/home/user/projectA') },
			{ name: 'b.jsonl', mtimeMs: 1000, size: 200, content: transcript('/home/user/projectB') },
		];

		const payload = runLearn({ exclude: 'projectB' });

		const pairs = payload.pairs as { projectPath: string }[];
		expect(pairs).toHaveLength(1);
		expect(pairs[0].projectPath).toBe('/home/user/projectA');
	});
});
