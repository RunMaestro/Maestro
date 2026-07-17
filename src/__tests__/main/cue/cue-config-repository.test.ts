/**
 * Tests for cue-config-repository.
 *
 * Verifies that the repository owns all `.maestro/cue.yaml` and
 * `.maestro/prompts/` filesystem operations behind a typed API:
 * - resolve / read / write / delete config files
 * - canonical-vs-legacy fallback on read
 * - canonical-only behaviour on write (implicit migration)
 * - directory creation for `.maestro/` and `.maestro/prompts/`
 * - prompt file write with arbitrary nested paths
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockWatcher = {
	on: vi.fn().mockReturnThis(),
	once: vi.fn().mockReturnThis(),
	close: vi.fn(),
};
const mockRmdirSync = vi.fn();

vi.mock('fs', () => ({
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
	writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
	mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
	readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
	rmdirSync: (...args: unknown[]) => mockRmdirSync(...args),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('chokidar', () => ({
	watch: vi.fn(() => mockWatcher),
}));

import {
	readCueConfigFile,
	readCuePromptFile,
	removeEmptyPromptsDir,
	removeEmptyMaestroDir,
	resolveCueConfigPath,
	writeCuePromptFile,
	watchCueConfigFile,
} from '../../../main/cue/config/cue-config-repository';
import { captureException } from '../../../main/utils/sentry';

const PROJECT_ROOT = '/projects/test';
const CANONICAL = path.join(PROJECT_ROOT, '.maestro/cue.yaml');
const LEGACY = path.join(PROJECT_ROOT, 'maestro-cue.yaml');
const MAESTRO_DIR = path.join(PROJECT_ROOT, '.maestro');
const RESOLVED_MAESTRO_DIR = path.resolve(MAESTRO_DIR);
// Prompt-file operations in the product canonicalize via `path.resolve(...)`
// for their containment guard, so on Windows these carry the CWD drive letter.
// Route the expected value through the same primitive so the assertion stays
// platform-symmetric (a no-op transform on POSIX).
const PROMPTS_DIR = path.resolve(path.join(PROJECT_ROOT, '.maestro/prompts'));

describe('cue-config-repository', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockReaddirSync.mockReset();
		mockRmdirSync.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
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
	});

	describe('writeCuePromptFile', () => {
		it('writes a prompt file under .maestro/prompts/', () => {
			mockExistsSync.mockReturnValue(true); // all dirs exist

			const result = writeCuePromptFile(PROJECT_ROOT, '.maestro/prompts/sub-1.md', 'prompt body 1');

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

		it('reports a readdirSync error and returns false', () => {
			const error = new Error('EACCES');
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockImplementation(() => {
				throw error;
			});

			expect(removeEmptyPromptsDir(PROJECT_ROOT)).toBe(false);
			expect(mockRmdirSync).not.toHaveBeenCalled();
			expect(captureException).toHaveBeenCalledWith(error, {
				operation: 'removeEmptyPromptsDir',
				dir: PROMPTS_DIR,
			});
		});

		it('reports an rmdirSync error and returns false', () => {
			const error = new Error('EACCES');
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([]);
			mockRmdirSync.mockImplementation(() => {
				throw error;
			});

			expect(removeEmptyPromptsDir(PROJECT_ROOT)).toBe(false);
			expect(captureException).toHaveBeenCalledWith(error, {
				operation: 'removeEmptyPromptsDir',
				dir: PROMPTS_DIR,
			});
		});
	});

	describe('removeEmptyMaestroDir', () => {
		it('removes .maestro/ when it exists and is empty', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([]);

			expect(removeEmptyMaestroDir(PROJECT_ROOT)).toBe(true);
			expect(mockRmdirSync).toHaveBeenCalledWith(RESOLVED_MAESTRO_DIR);
		});

		it('leaves the directory alone when non-empty', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(['other-config.yaml']);

			expect(removeEmptyMaestroDir(PROJECT_ROOT)).toBe(false);
			expect(mockRmdirSync).not.toHaveBeenCalled();
		});

		it('returns false when the directory does not exist', () => {
			mockExistsSync.mockReturnValue(false);

			expect(removeEmptyMaestroDir(PROJECT_ROOT)).toBe(false);
			expect(mockReaddirSync).not.toHaveBeenCalled();
			expect(mockRmdirSync).not.toHaveBeenCalled();
		});

		it.each(['readdirSync', 'rmdirSync'] as const)(
			'reports a %s error and returns false',
			(operation) => {
				const error = new Error('EACCES');
				mockExistsSync.mockReturnValue(true);
				mockReaddirSync.mockReturnValue([]);
				if (operation === 'readdirSync') {
					mockReaddirSync.mockImplementation(() => {
						throw error;
					});
				} else {
					mockRmdirSync.mockImplementation(() => {
						throw error;
					});
				}

				expect(removeEmptyMaestroDir(PROJECT_ROOT)).toBe(false);
				expect(captureException).toHaveBeenCalledWith(error, {
					operation: 'removeEmptyMaestroDir',
					dir: RESOLVED_MAESTRO_DIR,
				});
			}
		);
	});
});

describe('watchCueConfigFile', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	function triggerChange(): void {
		const call = mockWatcher.on.mock.calls.find(([event]) => event === 'change');
		expect(call).toBeDefined();
		(call![1] as () => void)();
	}

	it('is trailing-edge only and reschedules to the final file event', () => {
		const onChange = vi.fn();
		watchCueConfigFile(PROJECT_ROOT, onChange);

		triggerChange();
		vi.advanceTimersByTime(999);
		expect(onChange).not.toHaveBeenCalled();

		triggerChange();
		vi.advanceTimersByTime(999);
		expect(onChange).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('cancels a queued callback during teardown and rejects later events', () => {
		const onChange = vi.fn();
		const stop = watchCueConfigFile(PROJECT_ROOT, onChange);

		triggerChange();
		stop();
		vi.advanceTimersByTime(1000);
		triggerChange();
		vi.advanceTimersByTime(1000);

		expect(onChange).not.toHaveBeenCalled();
		expect(mockWatcher.close).toHaveBeenCalledOnce();
	});
});
