/**
 * @file pianola-learn.test.ts
 * @description Tests for `pianola learn`'s transcript fs-walk: the >50MB size
 * skip, newest-first mtime ordering, the per-agent session cap, and the
 * --since / --project / --exclude scope filters. node:fs is mocked; the
 * transcript parsers and classifier run for real so the mined corpus is genuine.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
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
import { GROK_PERMISSION_DECISIONS_UNSUPPORTED } from '../../../shared/pianola/transcript-mining';

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

/**
 * Grok transcripts. The account root comes from `GROK_HOME` by the
 * launch path's resolver, so every case points it at a virtual directory and
 * the mocked fs serves a tree keyed by full path (every Grok transcript shares
 * the basename `chat_history.jsonl`). Rows follow the sanitized native shapes
 * the Grok session reader suite pins; every decision is a test input, never a
 * recorded transcript, and none counts as native qualification.
 */
describe('pianola learn Grok transcripts', () => {
	const ACCOUNT = path.resolve(os.tmpdir(), 'gt1-08-19-grok-account');
	const DEFAULT_SESSIONS = path.join(os.homedir(), '.grok', 'sessions');
	const PROJECT = '/work/my proj';

	interface TreeFile {
		content: string;
		mtimeMs: number;
		size?: number;
	}
	let tree: Map<string, TreeFile>;
	let savedGrokHome: string | undefined;

	const sessionFile = (root: string, sessionId: string, cwd = PROJECT): string =>
		path.join(root, encodeURIComponent(cwd), sessionId, 'chat_history.jsonl');
	const put = (full: string, content: string, mtimeMs = 1000, size?: number): void => {
		tree.set(full, { content, mtimeMs, size });
	};
	const readPaths = (): string[] => fsMock.readFileSync.mock.calls.map((c) => c[0] as string);

	/** Native shape: a prose ask past tool work, answered by a typed reply. */
	const nativeChat = (reply = 'yes go ahead'): string =>
		[
			{ type: 'system', content: 'You are Grok 4.5 released by xAI.' },
			{
				type: 'user',
				content: [{ type: 'text', text: '<user_info>\nOS Version: macos\n</user_info>' }],
			},
			{
				type: 'user',
				content: [{ type: 'text', text: '<user_query>\nRename the helper\n</user_query>' }],
			},
			{ type: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
			{ type: 'tool_result', tool_call_id: 'c1', content: 'no' },
			{ type: 'assistant', content: 'Should I also rename the tests?' },
			{ type: 'user', content: [{ type: 'text', text: `<user_query>\n${reply}\n</user_query>` }] },
		]
			.map((row) => JSON.stringify(row))
			.join('\n');

	const runGrok = (options: Record<string, unknown> = {}) => {
		const payload = runLearn({ agent: 'grok', ...options });
		return payload as {
			scanned: Record<
				string,
				{ files: number; sessionsWithDecisions: number; unsupported?: unknown }
			>;
			pairCount: number;
			pairs: Record<string, unknown>[];
		};
	};

	beforeEach(() => {
		tree = new Map();
		savedGrokHome = process.env.GROK_HOME;
		process.env.GROK_HOME = ACCOUNT;
		fsMock.readdirSync.mockImplementation((dir: string) => {
			const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
			const seen = new Map<string, boolean>();
			for (const full of tree.keys()) {
				if (!full.startsWith(prefix)) continue;
				const rest = full.slice(prefix.length).split(path.sep);
				seen.set(rest[0], (seen.get(rest[0]) ?? false) || rest.length > 1);
			}
			if (seen.size === 0) throw new Error(`ENOENT: ${dir}`);
			return [...seen].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
		});
		fsMock.statSync.mockImplementation((full: string) => {
			const f = tree.get(full);
			if (!f) throw new Error(`ENOENT: ${full}`);
			return { mtimeMs: f.mtimeMs, size: f.size ?? f.content.length, isDirectory: () => false };
		});
		fsMock.readFileSync.mockImplementation((full: string) => {
			const f = tree.get(full);
			if (!f) throw new Error(`ENOENT: ${full}`);
			return f.content;
		});
	});

	afterEach(() => {
		if (savedGrokHome === undefined) delete process.env.GROK_HOME;
		else process.env.GROK_HOME = savedGrokHome;
	});

	it('mines the selected GROK_HOME account and reports permission decisions unsupported', () => {
		const selected = sessionFile(path.join(ACCOUNT, 'sessions'), 'sess-1');
		const other = sessionFile(DEFAULT_SESSIONS, 'sess-default');
		put(selected, nativeChat());
		put(other, nativeChat());

		const payload = runGrok();

		expect(readPaths()).toEqual([selected]);
		expect(payload.scanned.grok).toEqual({
			files: 1,
			sessionsWithDecisions: 1,
			unsupported: [{ ...GROK_PERMISSION_DECISIONS_UNSUPPORTED }],
		});
		expect(payload.pairCount).toBe(1);
		expect(payload.pairs[0]).toMatchObject({
			agent: 'grok',
			sessionId: 'sess-1',
			projectPath: PROJECT,
			ask: 'Should I also rename the tests?',
			reply: 'yes go ahead',
			polarity: 'affirmative',
			askedAt: '',
			repliedAt: '',
			provenance: { format: 'grok-chat-history', askLine: 6, replyLine: 7 },
		});
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('falls back to ~/.grok when GROK_HOME is blank', () => {
		process.env.GROK_HOME = '   ';
		const selected = sessionFile(path.join(ACCOUNT, 'sessions'), 'sess-1');
		const fallback = sessionFile(DEFAULT_SESSIONS, 'sess-default');
		put(selected, nativeChat());
		put(fallback, nativeChat('no'));

		const payload = runGrok();

		expect(readPaths()).toEqual([fallback]);
		expect(payload.pairs[0]).toMatchObject({ sessionId: 'sess-default', polarity: 'negative' });
	});

	it('reads only transcripts at <cwd>/<session>/chat_history.jsonl depth', () => {
		const sessions = path.join(ACCOUNT, 'sessions');
		const live = sessionFile(sessions, 'sess-1');
		put(live, nativeChat());
		put(
			path.join(path.dirname(live), 'compaction_checkpoints', 'cp-1', 'chat_history.jsonl'),
			nativeChat()
		);
		put(path.join(sessions, encodeURIComponent(PROJECT), 'chat_history.jsonl'), nativeChat());
		put(path.join(sessions, 'chat_history.jsonl'), nativeChat());
		put(path.join(path.dirname(live), 'updates.jsonl'), nativeChat());

		const payload = runGrok();

		expect(readPaths()).toEqual([live]);
		expect(payload.scanned.grok).toMatchObject({ files: 1, sessionsWithDecisions: 1 });
	});

	it('skips a Grok transcript over 50MB without reading it and mines past bad lines', () => {
		const sessions = path.join(ACCOUNT, 'sessions');
		const huge = sessionFile(sessions, 'sess-huge');
		const messy = sessionFile(sessions, 'sess-messy');
		put(huge, nativeChat(), 2000, 60 * 1024 * 1024);
		put(
			messy,
			[
				'{not json',
				'',
				JSON.stringify({ type: 'assistant', content: 'z'.repeat(300_000) }),
				nativeChat(),
			].join('\n')
		);

		const payload = runGrok();

		expect(readPaths()).toEqual([messy]);
		expect(payload.scanned.grok).toMatchObject({ files: 2, sessionsWithDecisions: 1 });
		expect(payload.pairs).toHaveLength(1);
		expect(payload.pairs[0]).toMatchObject({
			sessionId: 'sess-messy',
			provenance: { format: 'grok-chat-history', askLine: 9, replyLine: 10 },
		});
	});

	it('reports absent evidence as zero files with the unsupported entry, not an error', () => {
		const payload = runGrok();

		expect(readPaths()).toEqual([]);
		expect(payload.scanned.grok).toEqual({
			files: 0,
			sessionsWithDecisions: 0,
			unsupported: [{ ...GROK_PERMISSION_DECISIONS_UNSUPPORTED }],
		});
		expect(payload.pairCount).toBe(0);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('mines no decision from tool results, shell commands or the model describing consent', () => {
		// Synthetic: asks answered only by non-human records or by assistant prose.
		const rows = [
			{ type: 'assistant', content: 'Should I delete the build folder?' },
			{ type: 'tool_result', tool_call_id: 'c1', content: 'yes' },
			{ type: 'user', synthetic_reason: 'direct_bash', content: [{ type: 'text', text: 'yes' }] },
			{ type: 'user', synthetic_reason: 'parent_human_message', content: 'yes go ahead' },
			{ type: 'assistant', content: 'You approved the deletion, so I removed it.' },
		];
		put(
			sessionFile(path.join(ACCOUNT, 'sessions'), 'sess-1'),
			rows.map((r) => JSON.stringify(r)).join('\n')
		);

		const payload = runGrok();

		expect(payload.scanned.grok).toMatchObject({ files: 1, sessionsWithDecisions: 0 });
		expect(payload.pairCount).toBe(0);
	});

	it('keeps Grok out of the default agent list and ignores unknown agents beside it', () => {
		put(sessionFile(path.join(ACCOUNT, 'sessions'), 'sess-1'), nativeChat());

		pianolaLearn({ json: true });
		const defaults = JSON.parse(consoleSpy.mock.calls.at(-1)![0] as string);
		expect(defaults.scanned.grok).toBeUndefined();
		expect(readPaths()).toEqual([]);

		const payload = runGrok({ agent: 'grok,antigravity' });
		expect(Object.keys(payload.scanned)).toEqual(['grok']);
		expect(payload.pairCount).toBe(1);
	});

	it('leaves the supported Claude scan without an unsupported entry or provenance', () => {
		const claude = path.join(CLAUDE_DIR, 'c1.jsonl');
		put(claude, transcript('/p/a'));
		put(sessionFile(path.join(ACCOUNT, 'sessions'), 'sess-1'), nativeChat());

		const payload = runGrok({ agent: 'claude-code,grok' });

		expect(payload.scanned['claude-code']).toEqual({ files: 1, sessionsWithDecisions: 1 });
		const byAgent = Object.fromEntries(payload.pairs.map((p) => [p.agent, p]));
		expect(byAgent['claude-code']).not.toHaveProperty('provenance');
		expect(byAgent.grok).toHaveProperty('provenance');
	});
});
