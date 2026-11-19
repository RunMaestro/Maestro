// Source: src/__tests__/main/cue/cue-config-repository.test.ts
// Source: src/__tests__/main/cue/cue-config-reconciliation.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import * as path from 'path';
import { deleteCueConfigFile } from '../../../main/cue/config/cue-config-repository';
import { readCueConfigFile } from '../../../main/cue/config/cue-config-repository';
import { readCuePromptFile } from '../../../main/cue/config/cue-config-repository';
import { removeEmptyPromptsDir } from '../../../main/cue/config/cue-config-repository';
import { resolveCueConfigPath } from '../../../main/cue/config/cue-config-repository';
import { writeCueConfigFile } from '../../../main/cue/config/cue-config-repository';
import { writeCuePromptFile } from '../../../main/cue/config/cue-config-repository';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { watch } from 'chokidar';
import { watchCueConfigFile } from '../../../main/cue/config/cue-config-repository';
import { logger } from '../../../main/utils/logger';
import { writeCueYamlAtomicSync } from '../../../main/cue/cue-yaml-write';
const configFs = vi.hoisted(() => ({ fake: false }));
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockRmdirSync = vi.fn();

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		existsSync: (...args: unknown[]) =>
			configFs.fake ? mockExistsSync(...args) : Reflect.apply(actual.existsSync, actual, args),
		readFileSync: (...args: unknown[]) =>
			configFs.fake ? mockReadFileSync(...args) : Reflect.apply(actual.readFileSync, actual, args),
		writeFileSync: (...args: unknown[]) =>
			configFs.fake
				? mockWriteFileSync(...args)
				: Reflect.apply(actual.writeFileSync, actual, args),
		mkdirSync: (...args: unknown[]) =>
			configFs.fake ? mockMkdirSync(...args) : Reflect.apply(actual.mkdirSync, actual, args),
		unlinkSync: (...args: unknown[]) =>
			configFs.fake ? mockUnlinkSync(...args) : Reflect.apply(actual.unlinkSync, actual, args),
		readdirSync: (...args: unknown[]) =>
			configFs.fake ? mockReaddirSync(...args) : Reflect.apply(actual.readdirSync, actual, args),
		rmdirSync: (...args: unknown[]) =>
			configFs.fake ? mockRmdirSync(...args) : Reflect.apply(actual.rmdirSync, actual, args),
	};
});
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));
vi.mock('chokidar', () => ({
	watch: vi.fn(() => ({
		on: vi.fn().mockReturnThis(),
		close: vi.fn(),
	})),
}));
describe('cue-config-repository', () => {
	const PROJECT_ROOT = '/projects/test';
	const CANONICAL = path.join(PROJECT_ROOT, '.maestro/cue.yaml');
	const LEGACY = path.join(PROJECT_ROOT, 'maestro-cue.yaml');
	const MAESTRO_DIR = path.join(PROJECT_ROOT, '.maestro');
	// Prompt-file operations in the product canonicalize via `path.resolve(...)`
	// for their containment guard, so on Windows these carry the CWD drive letter.
	// Route the expected value through the same primitive so the assertion stays
	// platform-symmetric (a no-op transform on POSIX).
	const PROMPTS_DIR = path.resolve(path.join(PROJECT_ROOT, '.maestro/prompts'));

	describe('cue-config-repository', () => {
		afterEach(() => {
			configFs.fake = false;
		});
		beforeEach(() => {
			configFs.fake = true;
			vi.clearAllMocks();
		});

		describe('resolveCueConfigPath', () => {
			it('returns canonical path when .maestro/cue.yaml exists', () => {
				mockExistsSync.mockImplementation((p: string) => p === CANONICAL);

				expect(resolveCueConfigPath(PROJECT_ROOT)).toBe(CANONICAL);
			});

			it('falls back to legacy path when only legacy exists', () => {
				mockExistsSync.mockImplementation((p: string) => p === LEGACY);

				expect(resolveCueConfigPath(PROJECT_ROOT)).toBe(LEGACY);
			});

			it('prefers canonical over legacy when both exist', () => {
				mockExistsSync.mockImplementation((p: string) => p === CANONICAL || p === LEGACY);

				expect(resolveCueConfigPath(PROJECT_ROOT)).toBe(CANONICAL);
			});

			it('returns null when neither file exists', () => {
				mockExistsSync.mockReturnValue(false);

				expect(resolveCueConfigPath(PROJECT_ROOT)).toBeNull();
			});
		});

		describe('readCueConfigFile', () => {
			it('reads canonical file content when present', () => {
				mockExistsSync.mockImplementation((p: string) => p === CANONICAL);
				mockReadFileSync.mockReturnValue('subscriptions: []\n');

				const result = readCueConfigFile(PROJECT_ROOT);

				expect(result).toEqual({ filePath: CANONICAL, raw: 'subscriptions: []\n' });
				expect(mockReadFileSync).toHaveBeenCalledWith(CANONICAL, 'utf-8');
			});

			it('reads legacy file when canonical is missing', () => {
				mockExistsSync.mockImplementation((p: string) => p === LEGACY);
				mockReadFileSync.mockReturnValue('legacy: true\n');

				const result = readCueConfigFile(PROJECT_ROOT);

				expect(result).toEqual({ filePath: LEGACY, raw: 'legacy: true\n' });
				expect(mockReadFileSync).toHaveBeenCalledWith(LEGACY, 'utf-8');
			});

			it('returns null when no config file exists', () => {
				mockExistsSync.mockReturnValue(false);

				expect(readCueConfigFile(PROJECT_ROOT)).toBeNull();
				expect(mockReadFileSync).not.toHaveBeenCalled();
			});

			// MAESTRO-X9: readFileSync surfaces EINTR instead of restarting the
			// syscall, which aborted CueEngine.start('system-boot') and left Cue
			// disabled for the whole session.
			it('retries when the read is interrupted by a signal (EINTR)', () => {
				mockExistsSync.mockImplementation((p: string) => p === CANONICAL);
				const eintr = Object.assign(new Error('EINTR: interrupted system call, read'), {
					code: 'EINTR',
				});
				mockReadFileSync.mockImplementationOnce(() => {
					throw eintr;
				});
				mockReadFileSync.mockReturnValue('subscriptions: []\n');

				const result = readCueConfigFile(PROJECT_ROOT);

				expect(result).toEqual({ filePath: CANONICAL, raw: 'subscriptions: []\n' });
				expect(mockReadFileSync).toHaveBeenCalledTimes(2);
			});

			it('gives up after the retry bound when EINTR persists', () => {
				mockExistsSync.mockImplementation((p: string) => p === CANONICAL);
				const eintr = Object.assign(new Error('EINTR: interrupted system call, read'), {
					code: 'EINTR',
				});
				mockReadFileSync.mockImplementation(() => {
					throw eintr;
				});

				expect(() => readCueConfigFile(PROJECT_ROOT)).toThrow(/EINTR/);
				expect(mockReadFileSync).toHaveBeenCalledTimes(3);
			});

			it('does not retry non-EINTR read errors', () => {
				mockExistsSync.mockImplementation((p: string) => p === CANONICAL);
				const eacces = Object.assign(new Error('EACCES: permission denied, read'), {
					code: 'EACCES',
				});
				mockReadFileSync.mockImplementation(() => {
					throw eacces;
				});

				expect(() => readCueConfigFile(PROJECT_ROOT)).toThrow(/EACCES/);
				expect(mockReadFileSync).toHaveBeenCalledTimes(1);
			});
		});

		describe('writeCueConfigFile', () => {
			it('writes to the canonical path', () => {
				mockExistsSync.mockReturnValue(true); // .maestro/ already exists

				const result = writeCueConfigFile(PROJECT_ROOT, 'subscriptions: []');

				expect(result).toBe(CANONICAL);
				expect(mockWriteFileSync).toHaveBeenCalledWith(CANONICAL, 'subscriptions: []', 'utf-8');
			});

			it('creates .maestro/ if missing before writing', () => {
				mockExistsSync.mockImplementation((p: string) => p !== MAESTRO_DIR);

				writeCueConfigFile(PROJECT_ROOT, 'content');

				expect(mockMkdirSync).toHaveBeenCalledWith(MAESTRO_DIR, { recursive: true });
				expect(mockWriteFileSync).toHaveBeenCalledWith(CANONICAL, 'content', 'utf-8');
			});

			it('always writes the canonical path even when only legacy exists', () => {
				mockExistsSync.mockImplementation((p: string) => p === LEGACY || p === MAESTRO_DIR);

				writeCueConfigFile(PROJECT_ROOT, 'content');

				expect(mockWriteFileSync).toHaveBeenCalledWith(CANONICAL, 'content', 'utf-8');
				expect(mockWriteFileSync).not.toHaveBeenCalledWith(
					LEGACY,
					expect.anything(),
					expect.anything()
				);
			});
		});

		describe('deleteCueConfigFile', () => {
			it('deletes canonical file when present and returns true', () => {
				mockExistsSync.mockImplementation((p: string) => p === CANONICAL);

				const result = deleteCueConfigFile(PROJECT_ROOT);

				expect(result).toBe(true);
				expect(mockUnlinkSync).toHaveBeenCalledWith(CANONICAL);
			});

			it('deletes legacy file when canonical is missing', () => {
				mockExistsSync.mockImplementation((p: string) => p === LEGACY);

				const result = deleteCueConfigFile(PROJECT_ROOT);

				expect(result).toBe(true);
				expect(mockUnlinkSync).toHaveBeenCalledWith(LEGACY);
			});

			it('returns false when no config file exists', () => {
				mockExistsSync.mockReturnValue(false);

				const result = deleteCueConfigFile(PROJECT_ROOT);

				expect(result).toBe(false);
				expect(mockUnlinkSync).not.toHaveBeenCalled();
			});
		});

		describe('writeCuePromptFile', () => {
			it('writes a prompt file under .maestro/prompts/', () => {
				mockExistsSync.mockReturnValue(true); // all dirs exist

				const result = writeCuePromptFile(
					PROJECT_ROOT,
					'.maestro/prompts/sub-1.md',
					'prompt body 1'
				);

				const expectedAbs = path.resolve(path.join(PROJECT_ROOT, '.maestro/prompts/sub-1.md'));
				expect(result).toBe(expectedAbs);
				expect(mockWriteFileSync).toHaveBeenCalledWith(expectedAbs, 'prompt body 1', 'utf-8');
			});

			it('creates the prompts directory if missing', () => {
				mockExistsSync.mockImplementation((p: string) => p !== PROMPTS_DIR);

				writeCuePromptFile(PROJECT_ROOT, '.maestro/prompts/sub-1.md', 'body');

				expect(mockMkdirSync).toHaveBeenCalledWith(PROMPTS_DIR, { recursive: true });
			});

			it('creates parent directories for nested prompt paths', () => {
				const nested = '.maestro/prompts/nested/dir/sub.md';
				const expectedParent = path.resolve(path.join(PROJECT_ROOT, '.maestro/prompts/nested/dir'));
				mockExistsSync.mockImplementation((p: string) => p !== expectedParent);

				writeCuePromptFile(PROJECT_ROOT, nested, 'nested body');

				// The parent dir is created with { recursive: true } which covers all
				// intermediate directories (including .maestro/prompts) in one call.
				expect(mockMkdirSync).toHaveBeenCalledWith(expectedParent, { recursive: true });
				expect(mockWriteFileSync).toHaveBeenCalledWith(
					path.resolve(path.join(PROJECT_ROOT, nested)),
					'nested body',
					'utf-8'
				);
			});

			it('does not call mkdirSync if directories already exist', () => {
				mockExistsSync.mockReturnValue(true);

				writeCuePromptFile(PROJECT_ROOT, '.maestro/prompts/sub-1.md', 'body');

				expect(mockMkdirSync).not.toHaveBeenCalled();
			});

			it('throws for an absolute relativePath', () => {
				expect(() => writeCuePromptFile(PROJECT_ROOT, '/etc/passwd', 'content')).toThrow(
					'relativePath must be relative'
				);
				expect(mockWriteFileSync).not.toHaveBeenCalled();
			});

			it('throws for a path that resolves outside the prompts directory', () => {
				expect(() => writeCuePromptFile(PROJECT_ROOT, '.maestro/other/file.md', 'content')).toThrow(
					'resolves outside the prompts directory'
				);
				expect(mockWriteFileSync).not.toHaveBeenCalled();
			});

			it('throws for a path traversal attempt', () => {
				expect(() =>
					writeCuePromptFile(PROJECT_ROOT, '.maestro/prompts/../../etc/passwd', 'content')
				).toThrow('resolves outside the prompts directory');
				expect(mockWriteFileSync).not.toHaveBeenCalled();
			});
		});

		describe('readCuePromptFile', () => {
			it('returns the file content when the prompt file exists', () => {
				mockReadFileSync.mockReturnValue('body on disk');

				const result = readCuePromptFile(PROJECT_ROOT, '.maestro/prompts/sub-1.md');

				expect(result).toBe('body on disk');
				expect(mockReadFileSync).toHaveBeenCalledWith(
					path.resolve(path.join(PROJECT_ROOT, '.maestro/prompts/sub-1.md')),
					'utf-8'
				);
			});

			it('returns null when the prompt file is missing (read throws)', () => {
				mockReadFileSync.mockImplementation(() => {
					throw Object.assign(new Error('missing'), { code: 'ENOENT' });
				});

				expect(readCuePromptFile(PROJECT_ROOT, '.maestro/prompts/missing.md')).toBeNull();
			});

			it('returns null for a path outside the prompts directory without reading', () => {
				expect(readCuePromptFile(PROJECT_ROOT, '.maestro/other/file.md')).toBeNull();
				expect(mockReadFileSync).not.toHaveBeenCalled();
			});

			it('returns null for an absolute path without reading', () => {
				expect(readCuePromptFile(PROJECT_ROOT, '/etc/passwd')).toBeNull();
				expect(mockReadFileSync).not.toHaveBeenCalled();
			});
		});

		describe('removeEmptyPromptsDir', () => {
			it('removes .maestro/prompts/ when it exists and is empty', () => {
				mockExistsSync.mockReturnValue(true);
				mockReaddirSync.mockReturnValue([]);

				const removed = removeEmptyPromptsDir(PROJECT_ROOT);

				expect(removed).toBe(true);
				expect(mockRmdirSync).toHaveBeenCalledWith(PROMPTS_DIR);
			});

			it('leaves the directory alone when non-empty', () => {
				mockExistsSync.mockReturnValue(true);
				mockReaddirSync.mockReturnValue(['stray.txt']);

				const removed = removeEmptyPromptsDir(PROJECT_ROOT);

				expect(removed).toBe(false);
				expect(mockRmdirSync).not.toHaveBeenCalled();
			});

			it('returns false when the directory does not exist', () => {
				mockExistsSync.mockReturnValue(false);

				const removed = removeEmptyPromptsDir(PROJECT_ROOT);

				expect(removed).toBe(false);
				expect(mockRmdirSync).not.toHaveBeenCalled();
			});

			it('swallows rmdirSync errors and returns false', () => {
				mockExistsSync.mockReturnValue(true);
				mockReaddirSync.mockReturnValue([]);
				mockRmdirSync.mockImplementation(() => {
					throw new Error('EACCES');
				});

				const removed = removeEmptyPromptsDir(PROJECT_ROOT);

				expect(removed).toBe(false);
			});
		});
	});
});
describe('cue-config-reconciliation', () => {
	describe('YAML reconciliation when native notifications are lost', () => {
		let root: string;
		let config: string;
		let cleanup: () => void;
		beforeEach(() => {
			vi.mocked(watch).mockImplementation(
				() =>
					Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as ReturnType<
						typeof watch
					>
			);
			fs.mkdirSync('.build', { recursive: true });
			root = fs.mkdtempSync(path.resolve('.build/cue-reconcile-test-'));
			fs.mkdirSync(path.join(root, '.maestro'));
			config = path.join(root, '.maestro/cue.yaml');
			fs.writeFileSync(config, 'subscriptions: []\n');
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.mocked(watch).mockReset();
			cleanup?.();
			vi.useRealTimers();
			vi.restoreAllMocks();
			fs.rmSync(root, { recursive: true, force: true });
		});
		it('recovers changed bytes despite equal size and timestamp, once, with an informational log', () => {
			fs.writeFileSync(config, 'subscriptions: [a]\n');
			const stamp = fs.statSync(config).mtime;
			const info = vi.spyOn(logger, 'info');
			const onChange = vi.fn();
			const onWarning = vi.fn();
			cleanup = watchCueConfigFile(root, onChange, { onWarning });
			writeCueYamlAtomicSync(config, 'subscriptions: [b]\n');
			fs.utimesSync(config, stamp, stamp);
			vi.advanceTimersByTime(31_000);
			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onWarning).not.toHaveBeenCalled();
			expect(info).toHaveBeenCalledWith(
				expect.stringContaining('Missed config change'),
				'CueConfig'
			);
			vi.advanceTimersByTime(60_000);
			expect(onChange).toHaveBeenCalledTimes(1);
		});

		it('detects creation/deletion and stops health polling on teardown', () => {
			fs.unlinkSync(config);
			const onChange = vi.fn();
			cleanup = watchCueConfigFile(root, onChange);
			writeCueYamlAtomicSync(config, 'subscriptions: []\n');
			vi.advanceTimersByTime(31_000);
			expect(onChange).toHaveBeenCalledTimes(1);
			fs.unlinkSync(config);
			vi.advanceTimersByTime(30_000);
			expect(onChange).toHaveBeenCalledTimes(2);
			cleanup();
			writeCueYamlAtomicSync(config, 'subscriptions: [a]\n');
			vi.advanceTimersByTime(60_000);
			expect(onChange).toHaveBeenCalledTimes(2);
		});

		it('retries a failed reload rather than marking stale runtime content reconciled', () => {
			const onChange = vi.fn().mockImplementationOnce(() => {
				throw new Error('reload unavailable');
			});
			const onWarning = vi.fn();
			cleanup = watchCueConfigFile(root, onChange, { onWarning });
			writeCueYamlAtomicSync(config, 'subscriptions: [a]\n');
			vi.advanceTimersByTime(31_000);
			expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('Config reload failed'));
			vi.advanceTimersByTime(30_000);
			expect(onChange).toHaveBeenCalledTimes(2);
		});
		it('alarms on watcher errors while retaining missed-change recovery', () => {
			const onChange = vi.fn();
			const onWarning = vi.fn();
			cleanup = watchCueConfigFile(root, onChange, { onWarning });
			const watcher = vi.mocked(watch).mock.results.at(-1)!.value;
			watcher.emit('error', new Error('ENOSPC: watcher unavailable'));
			expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('Config watcher unhealthy'));
			writeCueYamlAtomicSync(config, 'subscriptions: [a]\n');
			vi.advanceTimersByTime(31_000);
			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onWarning).toHaveBeenCalledTimes(1);
		});
		it('ignores a late native notification for loaded YAML using chokidar path separators', () => {
			const loaded = readCueConfigFile(root);
			const onChange = vi.fn();
			cleanup = watchCueConfigFile(root, onChange, { getLoadedConfigFile: () => loaded });
			const watcher = vi.mocked(watch).mock.results.at(-1)!.value;
			watcher.emit('change', config.replace(/\\/g, '/'));
			vi.advanceTimersByTime(1000);
			expect(onChange).not.toHaveBeenCalled();
		});
	});
});
