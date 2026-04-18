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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockRmdirSync = vi.fn();

vi.mock('fs', () => ({
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
	writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
	mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
	unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
	readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
	rmdirSync: (...args: unknown[]) => mockRmdirSync(...args),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('chokidar', () => ({
	watch: vi.fn(() => ({
		on: vi.fn().mockReturnThis(),
		close: vi.fn(),
	})),
}));

import {
	deleteCueConfigFile,
	readCueConfigFile,
	removeEmptyPromptsDir,
	resolveCueConfigPath,
	writeCueConfigFile,
	writeCuePromptFile,
} from '../../../main/cue/config/cue-config-repository';

const PROJECT_ROOT = '/projects/test';
const CANONICAL = path.join(PROJECT_ROOT, '.maestro/cue.yaml');
const LEGACY = path.join(PROJECT_ROOT, 'maestro-cue.yaml');
const MAESTRO_DIR = path.join(PROJECT_ROOT, '.maestro');
const PROMPTS_DIR = path.join(PROJECT_ROOT, '.maestro/prompts');

describe('cue-config-repository', () => {
	beforeEach(() => {
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

			const result = writeCuePromptFile(PROJECT_ROOT, '.maestro/prompts/sub-1.md', 'prompt body 1');

			const expectedAbs = path.join(PROJECT_ROOT, '.maestro/prompts/sub-1.md');
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
			const expectedParent = path.join(PROJECT_ROOT, '.maestro/prompts/nested/dir');
			mockExistsSync.mockImplementation((p: string) => p !== expectedParent);

			writeCuePromptFile(PROJECT_ROOT, nested, 'nested body');

			// The parent dir is created with { recursive: true } which covers all
			// intermediate directories (including .maestro/prompts) in one call.
			expect(mockMkdirSync).toHaveBeenCalledWith(expectedParent, { recursive: true });
			expect(mockWriteFileSync).toHaveBeenCalledWith(
				path.join(PROJECT_ROOT, nested),
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
