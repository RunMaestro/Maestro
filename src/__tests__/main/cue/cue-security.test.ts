/**
 * Phase 11 — Security hardening tests.
 *
 * Covers all four security guards added in Phase 11:
 *   11A — `validateGlobPattern` rejects path-traversal / absolute / drive
 *         patterns; the file-watcher runtime guard drops events that resolve
 *         outside the project root.
 *   11B — `sanitizeCustomEnvVars` drops blocklisted and malformed env var
 *         names before they reach the child process.
 *   11C — `readPromptFile` (via `cue-config-normalizer`) refuses to read
 *         prompt files that resolve outside the project root. Exercised by
 *         loading a crafted YAML through the normalizer.
 *   11D — `initCueDb` chmods the DB file to 0o600 after opening; a failing
 *         chmod logs a warning but does not fail initialization.
 *
 * Intentionally split from the feature-level tests (`cue-file-watcher.test.ts`,
 * `cue-db.test.ts`, etc.) so a security regression is easy to spot and bisect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ────────────────────────────────────────────────────────────────────────────
// 11A-1 — Glob validator
// ────────────────────────────────────────────────────────────────────────────

import { validateSubscription } from '../../../main/cue/config/cue-config-validator';

function watchErrors(sub: Record<string, unknown>): string[] {
	return validateSubscription({ name: 'test', event: 'file.changed', prompt: 'go', ...sub }, 'sub');
}

describe('Phase 11A — validateGlobPattern rejects traversal patterns', () => {
	it('rejects patterns containing ".." segments', () => {
		const errs = watchErrors({ watch: '../**/*.ts' });
		expect(errs.some((e) => /path traversal/i.test(e))).toBe(true);
	});

	it('rejects bare ".." as a segment', () => {
		const errs = watchErrors({ watch: '..' });
		expect(errs.some((e) => /path traversal/i.test(e))).toBe(true);
	});

	it('rejects mid-path ".." segments', () => {
		const errs = watchErrors({ watch: 'src/../../etc/passwd' });
		expect(errs.some((e) => /path traversal/i.test(e))).toBe(true);
	});

	it('rejects Windows-style backslash traversal', () => {
		const errs = watchErrors({ watch: '..\\foo\\bar.md' });
		expect(errs.some((e) => /path traversal/i.test(e))).toBe(true);
	});

	it('rejects absolute POSIX paths', () => {
		const errs = watchErrors({ watch: '/etc/passwd' });
		expect(errs.some((e) => /absolute paths are not permitted/i.test(e))).toBe(true);
	});

	it('rejects absolute backslash paths', () => {
		const errs = watchErrors({ watch: '\\Windows\\System32' });
		expect(errs.some((e) => /absolute paths are not permitted/i.test(e))).toBe(true);
	});

	it('rejects Windows drive-letter paths', () => {
		const errs = watchErrors({ watch: 'C:\\Windows\\System32\\*.exe' });
		expect(errs.some((e) => /Windows drive paths are not permitted/i.test(e))).toBe(true);
	});

	it('rejects Windows drive-letter paths with forward slashes', () => {
		const errs = watchErrors({ watch: 'D:/secret/*.txt' });
		expect(errs.some((e) => /Windows drive paths are not permitted/i.test(e))).toBe(true);
	});

	it('rejects drive-relative Windows paths without a separator after the colon', () => {
		// `C:secret\*.txt` is resolved against Windows' per-drive CWD table
		// and can escape the project root. Catch both drive-absolute
		// (`C:\...`) and drive-relative (`C:...`) shapes with one regex.
		const errs = watchErrors({ watch: 'C:secret\\*.txt' });
		expect(errs.some((e) => /Windows drive paths are not permitted/i.test(e))).toBe(true);
	});

	it('accepts a normal relative glob', () => {
		const errs = watchErrors({ watch: 'src/**/*.ts' });
		// There should be no watch-related error.
		expect(errs.filter((e) => /watch/i.test(e))).toHaveLength(0);
	});

	it('accepts recursive globs', () => {
		const errs = watchErrors({ watch: '**/*.{js,ts}' });
		expect(errs.filter((e) => /watch/i.test(e))).toHaveLength(0);
	});

	it('accepts nested directory globs', () => {
		const errs = watchErrors({ watch: 'docs/**/*.md' });
		expect(errs.filter((e) => /watch/i.test(e))).toHaveLength(0);
	});

	it('also hardens task.pending watch patterns', () => {
		const errs = validateSubscription(
			{ name: 't', event: 'task.pending', prompt: 'go', watch: '../tasks/**/*.md' },
			'sub'
		);
		expect(errs.some((e) => /path traversal/i.test(e))).toBe(true);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// 11A-2 — File-watcher runtime guard
// ────────────────────────────────────────────────────────────────────────────

const mockOn = vi.fn().mockReturnThis();
const mockClose = vi.fn();
vi.mock('chokidar', () => ({
	watch: vi.fn(() => ({
		on: mockOn,
		close: mockClose,
	})),
}));

// Isolate the crypto.randomUUID mock from the file-watcher's own suite.
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => 'security-test-uuid'),
}));

import { createCueFileWatcher } from '../../../main/cue/cue-file-watcher';

describe('Phase 11A — file-watcher runtime path containment', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function getChangeHandler(): (filePath: string) => void {
		const handler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];
		expect(handler).toBeDefined();
		return handler as (filePath: string) => void;
	}

	it('drops events whose resolved path escapes the project root', () => {
		const projectRoot = path.resolve(os.tmpdir(), 'maestro-cue-security-test');
		const onEvent = vi.fn();
		const onLog = vi.fn();

		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot,
			debounceMs: 10,
			onEvent,
			triggerName: 'sec-test',
			onLog,
		});

		const changeHandler = getChangeHandler();

		// chokidar normally delivers paths relative to `cwd`, but a misconfigured
		// symlink or an explicit absolute path that escapes the root must be
		// dropped. Simulate the escape by passing a path that resolves above
		// `projectRoot`.
		const escapingPath = path.join('..', '..', 'etc', 'passwd');
		changeHandler(escapingPath);

		vi.advanceTimersByTime(10);

		expect(onEvent).not.toHaveBeenCalled();
		expect(onLog).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('Dropped file event outside projectRoot')
		);
	});

	it('accepts events whose resolved path is inside the project root', () => {
		const projectRoot = path.resolve(os.tmpdir(), 'maestro-cue-security-test-ok');
		const onEvent = vi.fn();
		const onLog = vi.fn();

		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot,
			debounceMs: 10,
			onEvent,
			triggerName: 'sec-test',
			onLog,
		});

		const changeHandler = getChangeHandler();
		changeHandler(path.join('src', 'index.ts'));

		vi.advanceTimersByTime(10);

		expect(onEvent).toHaveBeenCalledTimes(1);
		expect(onLog).not.toHaveBeenCalled();
	});

	it('does not throw when onLog is not provided and an escape occurs', () => {
		const projectRoot = path.resolve(os.tmpdir(), 'maestro-cue-security-test-nolog');
		const onEvent = vi.fn();

		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot,
			debounceMs: 10,
			onEvent,
			triggerName: 'sec-test',
		});

		const changeHandler = getChangeHandler();
		expect(() => {
			changeHandler(path.join('..', 'outside.ts'));
			vi.advanceTimersByTime(10);
		}).not.toThrow();
		expect(onEvent).not.toHaveBeenCalled();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// 11B — Env var sanitizer
// ────────────────────────────────────────────────────────────────────────────

import { sanitizeCustomEnvVars, getBlockedEnvVarNames } from '../../../main/cue/cue-env-sanitizer';

describe('Phase 11B — sanitizeCustomEnvVars', () => {
	it('returns an empty result for undefined input', () => {
		const res = sanitizeCustomEnvVars(undefined);
		expect(res.sanitized).toEqual({});
		expect(res.droppedNames).toEqual([]);
	});

	it('returns an empty result for null input', () => {
		const res = sanitizeCustomEnvVars(null);
		expect(res.sanitized).toEqual({});
		expect(res.droppedNames).toEqual([]);
	});

	it('passes valid POSIX-style env vars through unchanged', () => {
		const onLog = vi.fn();
		const res = sanitizeCustomEnvVars(
			{
				ANTHROPIC_API_KEY: 'sk-test',
				_MY_VAR: 'x',
				FOO123: 'bar',
				A: '1',
			},
			onLog
		);
		expect(res.sanitized).toEqual({
			ANTHROPIC_API_KEY: 'sk-test',
			_MY_VAR: 'x',
			FOO123: 'bar',
			A: '1',
		});
		expect(res.droppedNames).toEqual([]);
		expect(onLog).not.toHaveBeenCalled();
	});

	describe.each([
		'PATH',
		'HOME',
		'USER',
		'SHELL',
		'LD_PRELOAD',
		'LD_LIBRARY_PATH',
		'DYLD_INSERT_LIBRARIES',
		'NODE_OPTIONS',
	])('drops blocklisted var %s', (name) => {
		it('drops the var and logs a warn with "blocklisted"', () => {
			const onLog = vi.fn();
			const res = sanitizeCustomEnvVars({ [name]: 'malicious' }, onLog);
			expect(res.sanitized).toEqual({});
			expect(res.droppedNames).toEqual([name]);
			expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('blocklisted'));
		});
	});

	describe.each([
		['starts with digit', '1FOO'],
		['contains hyphen', 'FOO-BAR'],
		['contains space', 'FOO BAR'],
		['empty string', ''],
		['contains equals sign', 'FOO=BAR'],
		['contains dot', 'FOO.BAR'],
	])('drops invalid var name (%s)', (_label, name) => {
		it('drops the var and logs a warn with "not a valid"', () => {
			const onLog = vi.fn();
			const res = sanitizeCustomEnvVars({ [name]: 'x' }, onLog);
			expect(res.sanitized).toEqual({});
			expect(res.droppedNames).toEqual([name]);
			expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('not a valid'));
		});
	});

	it('drops blocklisted vars case-insensitively (Windows env vars are case-insensitive)', () => {
		// Windows env var lookup is case-insensitive — `Path` and `PATH`
		// refer to the same slot, so a case-sensitive blocklist would let an
		// attacker bypass the guard with `path` or `PaTh`. Verify both
		// lowercase and mixed-case variants get dropped and logged.
		const onLog = vi.fn();
		const res = sanitizeCustomEnvVars(
			{
				path: '/opt/my-bin',
				PaTh: '/opt/other',
				LD_preload: 'evil.so',
				ld_library_path: '/tmp/evil',
			},
			onLog
		);
		expect(res.sanitized).toEqual({});
		// droppedNames preserves the original casing so operators see what
		// the user actually typed.
		expect(res.droppedNames).toEqual(['path', 'PaTh', 'LD_preload', 'ld_library_path']);
		expect(onLog).toHaveBeenCalledTimes(4);
		for (const call of onLog.mock.calls) {
			expect(call[0]).toBe('warn');
			expect(call[1]).toMatch(/blocklisted/);
		}
	});

	it('preserves the order of dropped names', () => {
		const res = sanitizeCustomEnvVars({
			GOOD: 'ok',
			PATH: 'bad',
			'BAD NAME': 'nope',
			LD_PRELOAD: 'evil',
		});
		expect(res.droppedNames).toEqual(['PATH', 'BAD NAME', 'LD_PRELOAD']);
		expect(res.sanitized).toEqual({ GOOD: 'ok' });
	});

	it('mixes valid, blocked, and invalid vars correctly', () => {
		const onLog = vi.fn();
		const res = sanitizeCustomEnvVars(
			{
				ANTHROPIC_API_KEY: 'valid',
				NODE_OPTIONS: '--inspect', // blocked
				'1BAD': 'invalid', // invalid regex
				OTHER_VAR: 'valid',
			},
			onLog
		);
		expect(res.sanitized).toEqual({
			ANTHROPIC_API_KEY: 'valid',
			OTHER_VAR: 'valid',
		});
		expect(res.droppedNames.sort()).toEqual(['1BAD', 'NODE_OPTIONS'].sort());
		expect(onLog).toHaveBeenCalledTimes(2);
	});

	it('does not invoke onLog when no vars are dropped', () => {
		const onLog = vi.fn();
		sanitizeCustomEnvVars({ OK: '1' }, onLog);
		expect(onLog).not.toHaveBeenCalled();
	});

	it('exposes the canonical blocklist for callers/tests', () => {
		const blocked = getBlockedEnvVarNames();
		expect(blocked.has('PATH')).toBe(true);
		expect(blocked.has('LD_PRELOAD')).toBe(true);
		expect(blocked.has('LD_LIBRARY_PATH')).toBe(true);
		expect(blocked.has('DYLD_INSERT_LIBRARIES')).toBe(true);
		expect(blocked.has('NODE_OPTIONS')).toBe(true);
		expect(blocked.has('HOME')).toBe(true);
		expect(blocked.has('USER')).toBe(true);
		expect(blocked.has('SHELL')).toBe(true);
		// Sanity: the canonical list should not include orthogonal vars.
		expect(blocked.has('ANTHROPIC_API_KEY')).toBe(false);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// 11C — readPromptFile path traversal
// ────────────────────────────────────────────────────────────────────────────

import * as yaml from 'js-yaml';
import { parseCueConfigDocument } from '../../../main/cue/config/cue-config-normalizer';

describe('Phase 11C — prompt_file path containment', () => {
	let tmpDir: string;
	let projectRoot: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cue-sec-'));
		projectRoot = path.join(tmpDir, 'project');
		fs.mkdirSync(path.join(projectRoot, '.maestro', 'prompts'), { recursive: true });
		fs.writeFileSync(path.join(projectRoot, '.maestro', 'prompts', 'ok.md'), 'hello');
		// Sibling file outside the project root — what a traversal would target.
		fs.writeFileSync(path.join(tmpDir, 'secret.md'), 'SECRET');
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function parseWithPromptFile(promptFile: string) {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 't',
					event: 'time.heartbeat',
					interval_minutes: 1,
					prompt_file: promptFile,
				},
			],
		});
		const doc = parseCueConfigDocument(raw, projectRoot);
		expect(doc).not.toBeNull();
		return doc!.subscriptions[0];
	}

	it('resolves a legitimate prompt_file reference to its contents', () => {
		const sub = parseWithPromptFile('.maestro/prompts/ok.md');
		expect(sub.prompt).toBe('hello');
		expect(sub.promptSpec.file).toBe('.maestro/prompts/ok.md');
	});

	it('refuses to read a prompt file outside the project root via relative traversal', () => {
		const sub = parseWithPromptFile('../secret.md');
		// readPromptFile returns undefined → resolvedPrompt becomes '' → prompt is ''.
		expect(sub.prompt).toBe('');
		// promptSpec still carries the (refused) file reference for downstream
		// materializeCueConfig to surface as a warning.
		expect(sub.promptSpec.file).toBe('../secret.md');
	});

	it('refuses to read a prompt file via absolute path outside the project root', () => {
		const sub = parseWithPromptFile(path.join(tmpDir, 'secret.md'));
		expect(sub.prompt).toBe('');
	});

	it('allows an absolute path that happens to be inside the project root', () => {
		const sub = parseWithPromptFile(path.join(projectRoot, '.maestro', 'prompts', 'ok.md'));
		expect(sub.prompt).toBe('hello');
	});

	it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
		'resolves prompt_file references whose casing differs from projectRoot on case-insensitive filesystems',
		() => {
			// Only meaningful on case-insensitive FSes (macOS / Windows). A
			// case-sensitive `startsWith` would false-negative reject a legit
			// path when the projectRoot happens to be cased differently than
			// the prompt-file reference — the filesystem treats them as the
			// same file, so the containment guard must too.
			const raw = yaml.dump({
				subscriptions: [
					{
						name: 't',
						event: 'time.heartbeat',
						interval_minutes: 1,
						// Legitimate in-root path, but upper-cased — should
						// still resolve to the real file's contents.
						prompt_file: path.join(projectRoot, '.maestro', 'prompts', 'OK.MD').toUpperCase(),
					},
				],
			});
			const doc = parseCueConfigDocument(raw, projectRoot);
			expect(doc).not.toBeNull();
			// Path casing beyond the root prefix may not match a real file
			// on disk, so `prompt` can still be '' if the upper-cased
			// filename doesn't exist — what we're asserting is the
			// CONTAINMENT guard didn't reject it. `readPromptFile` returning
			// '' (file not found) vs undefined (containment rejection) means
			// the promptSpec.file is still recorded. Easier to test: swap the
			// root itself to a case-variant and check the file resolves.
			const upperRoot = projectRoot; // keep FS-matching casing
			// Intentionally mismatch case on the ROOT passed in, but keep
			// the prompt_file reference lowercase-consistent with disk. If
			// our guard rejected case-variant roots, this would return ''.
			const rawMismatched = yaml.dump({
				subscriptions: [
					{
						name: 't',
						event: 'time.heartbeat',
						interval_minutes: 1,
						prompt_file: '.maestro/prompts/ok.md',
					},
				],
			});
			const docMismatched = parseCueConfigDocument(rawMismatched, upperRoot.toUpperCase());
			expect(docMismatched?.subscriptions[0].prompt).toBe('hello');
		}
	);
});

// ────────────────────────────────────────────────────────────────────────────
// 11D — DB file permissions
// ────────────────────────────────────────────────────────────────────────────
//
// Emulate the existing cue-db.test.ts mock strategy: better-sqlite3 is a
// native module that does not load under vitest, so we mock it. The guard we
// care about is the `fs.chmodSync(dbPath, 0o600)` call immediately after
// `new Database(dbPath)`. We verify (a) chmod was called with 0o600, and (b)
// when chmod throws, initialization still completes and a warn log is emitted.

const runCalls: unknown[][] = [];
const mockStatement = {
	run: vi.fn((...args: unknown[]) => {
		runCalls.push(args);
		return { changes: 1 };
	}),
	get: vi.fn(),
	all: vi.fn(() => []),
};
const mockDb = {
	pragma: vi.fn((query: string) => {
		// Phase 01: initCueDb's additive-column migration calls
		// `pragma('table_info(cue_events)')`. Return the full column set so the
		// migration sees no missing columns and stays a no-op under the mock.
		if (typeof query === 'string' && query.startsWith('table_info(cue_events)')) {
			return [
				{ name: 'id' },
				{ name: 'type' },
				{ name: 'trigger_name' },
				{ name: 'session_id' },
				{ name: 'subscription_name' },
				{ name: 'status' },
				{ name: 'created_at' },
				{ name: 'completed_at' },
				{ name: 'payload' },
				{ name: 'pipeline_id' },
				{ name: 'chain_root_id' },
				{ name: 'parent_event_id' },
			];
		}
		// Phase 01 — same idea for the persisted queue table; return the full
		// column set so the additive migration is a no-op under the mock.
		if (typeof query === 'string' && query.startsWith('table_info(cue_event_queue)')) {
			return [
				{ name: 'id' },
				{ name: 'session_id' },
				{ name: 'subscription_name' },
				{ name: 'event_json' },
				{ name: 'prompt' },
				{ name: 'output_prompt' },
				{ name: 'cli_output_json' },
				{ name: 'action' },
				{ name: 'command_json' },
				{ name: 'chain_depth' },
				{ name: 'queued_at' },
				{ name: 'chain_root_id' },
				{ name: 'parent_event_id' },
			];
		}
		return undefined;
	}),
	prepare: vi.fn(() => mockStatement),
	close: vi.fn(),
};

vi.mock('better-sqlite3', () => ({
	default: class MockDatabase {
		constructor() {
			/* noop */
		}
		pragma = mockDb.pragma;
		prepare = mockDb.prepare;
		close = mockDb.close;
	},
}));

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => os.tmpdir()),
	},
}));

// Import AFTER vi.mock so the mocked better-sqlite3 binding is used.
import { initCueDb, closeCueDb } from '../../../main/cue/cue-db';

// On Windows, POSIX modes are largely ignored by NTFS and a chmod-check test
// would produce an ambiguous result. Skip the permission-bit assertion there;
// the error-path test still runs because we exercise the chmod failure via a
// non-existent DB path (which throws ENOENT on every platform).
const isPosix = process.platform !== 'win32';

describe('Phase 11D — cue-db file permissions', () => {
	const createdFiles: string[] = [];
	// initCueDb calls fs.mkdirSync(dirname(dbPath), { recursive: true }) when
	// the parent directory does not exist. The chmod-failure test points at a
	// non-existent dir so the tmpdir gets a new subdirectory created on every
	// run — track those so afterEach cleans them up instead of leaving them
	// behind in the user's tmpdir.
	const createdDirs: string[] = [];

	beforeEach(() => {
		vi.clearAllMocks();
		runCalls.length = 0;
		closeCueDb();
	});

	afterEach(() => {
		closeCueDb();
		while (createdFiles.length > 0) {
			const file = createdFiles.pop()!;
			try {
				fs.unlinkSync(file);
			} catch {
				// best effort
			}
		}
		while (createdDirs.length > 0) {
			const dir = createdDirs.pop()!;
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// best effort
			}
		}
	});

	it.skipIf(!isPosix)('chmods the DB file to 0o600 immediately after opening', () => {
		// better-sqlite3 is mocked (no real DB file created). Pre-create an
		// empty file at the path so the real fs.chmodSync call inside
		// initCueDb has something to tighten.
		const dbPath = path.join(os.tmpdir(), `maestro-cue-chmod-${Date.now()}-${Math.random()}.db`);
		fs.writeFileSync(dbPath, '');
		// Start from an intentionally loose mode so the post-init mode proves
		// the chmod call actually happened.
		fs.chmodSync(dbPath, 0o644);
		createdFiles.push(dbPath);

		initCueDb(undefined, dbPath);

		const stat = fs.statSync(dbPath);
		// Only the low 9 bits (owner/group/other rwx) are the permission bits.
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it('continues initialization and logs a warn when chmod fails', () => {
		const onLog = vi.fn();
		// Point at a path whose parent does not exist — `new Database()` is
		// mocked so it does not care, but `fs.chmodSync` will throw ENOENT
		// because there is no file at the path to chmod. Exactly the error
		// shape we want to exercise.
		const parentDir = path.join(
			os.tmpdir(),
			`maestro-cue-chmod-missing-${Date.now()}-${Math.random()}`
		);
		const dbPath = path.join(parentDir, 'inner.db');
		// initCueDb will create `parentDir` via mkdirSync(recursive) even
		// though the DB file itself is never created (better-sqlite3 is
		// mocked). Register it for afterEach cleanup so the tmpdir stays tidy.
		createdDirs.push(parentDir);

		expect(() => initCueDb(onLog, dbPath)).not.toThrow();

		expect(onLog).toHaveBeenCalledWith('warn', expect.stringMatching(/chmod 0o600 failed/));
		// Pragma (WAL) still ran — initialization did not abort when chmod failed.
		expect(mockDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
	});
});
