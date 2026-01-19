/**
 * @file playbooks.test.ts
 * @description Tests for the playbooks CLI service
 *
 * Tests all functionality of the playbooks service including:
 * - readPlaybooks: Reading playbooks for a session
 * - getPlaybook: Getting a specific playbook by ID
 * - resolvePlaybookId: Resolving partial playbook IDs
 * - findPlaybookById: Finding playbooks across all agents
 * - listAllPlaybooks: Listing all playbooks from all sessions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Playbook } from '../../../shared/types';

// Mock the fs module
vi.mock('fs', () => ({
	readFileSync: vi.fn(),
	readdirSync: vi.fn(),
	existsSync: vi.fn(),
}));

// Mock the storage service - must mock getConfigDirectory
vi.mock('../../../cli/services/storage', () => ({
	getConfigDirectory: vi.fn(() => '/mock/config'),
}));

import {
	readPlaybooks,
	getPlaybook,
	resolvePlaybookId,
	findPlaybookById,
	listAllPlaybooks,
} from '../../../cli/services/playbooks';

describe('playbooks service', () => {
	const mockPlaybook = (overrides: Partial<Playbook> = {}): Playbook => ({
		id: 'playbook-123',
		name: 'Test Playbook',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		documents: [{ filename: 'doc1.md', resetOnCompletion: false }],
		loopEnabled: false,
		maxLoops: null,
		prompt: 'Test prompt',
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('readPlaybooks', () => {
		it('should read playbooks from the correct file path', () => {
			const playbook = mockPlaybook();
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [playbook] }));

			const result = readPlaybooks('session-1');

			expect(fs.readFileSync).toHaveBeenCalledWith(
				path.join('/mock/config', 'playbooks', 'session-1.json'),
				'utf-8'
			);
			expect(result).toEqual([playbook]);
		});

		it('should return empty array when playbooks array is empty', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [] }));

			const result = readPlaybooks('session-1');

			expect(result).toEqual([]);
		});

		it('should return empty array when playbooks property is not an array', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: 'not-an-array' }));

			const result = readPlaybooks('session-1');

			expect(result).toEqual([]);
		});

		it('should return empty array when playbooks property is null', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: null }));

			const result = readPlaybooks('session-1');

			expect(result).toEqual([]);
		});

		it('should return empty array when file does not exist (ENOENT)', () => {
			const error = new Error('File not found') as NodeJS.ErrnoException;
			error.code = 'ENOENT';
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw error;
			});

			const result = readPlaybooks('session-1');

			expect(result).toEqual([]);
		});

		it('should throw error for other file system errors', () => {
			const error = new Error('Permission denied') as NodeJS.ErrnoException;
			error.code = 'EACCES';
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw error;
			});

			expect(() => readPlaybooks('session-1')).toThrow('Permission denied');
		});

		it('should return multiple playbooks correctly', () => {
			const playbooks = [
				mockPlaybook({ id: 'pb-1', name: 'First' }),
				mockPlaybook({ id: 'pb-2', name: 'Second' }),
				mockPlaybook({ id: 'pb-3', name: 'Third' }),
			];
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks }));

			const result = readPlaybooks('session-1');

			expect(result).toHaveLength(3);
			expect(result[0].name).toBe('First');
			expect(result[2].name).toBe('Third');
		});
	});

	describe('getPlaybook', () => {
		it('should return playbook by exact ID match', () => {
			const playbook = mockPlaybook({ id: 'exact-id-123' });
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [playbook] }));

			const result = getPlaybook('session-1', 'exact-id-123');

			expect(result).toEqual(playbook);
		});

		it('should return playbook by prefix match when single match', () => {
			const playbooks = [mockPlaybook({ id: 'abc-123-xyz' }), mockPlaybook({ id: 'def-456-xyz' })];
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks }));

			const result = getPlaybook('session-1', 'abc');

			expect(result?.id).toBe('abc-123-xyz');
		});

		it('should return undefined when no match found', () => {
			const playbook = mockPlaybook({ id: 'playbook-123' });
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [playbook] }));

			const result = getPlaybook('session-1', 'nonexistent');

			expect(result).toBeUndefined();
		});

		it('should return undefined when multiple prefix matches exist', () => {
			const playbooks = [mockPlaybook({ id: 'test-123' }), mockPlaybook({ id: 'test-456' })];
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks }));

			const result = getPlaybook('session-1', 'test');

			expect(result).toBeUndefined();
		});

		it('should prefer exact match over prefix match', () => {
			const playbooks = [
				mockPlaybook({ id: 'test', name: 'Exact Match' }),
				mockPlaybook({ id: 'test-extended', name: 'Prefix Match' }),
			];
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks }));

			const result = getPlaybook('session-1', 'test');

			expect(result?.name).toBe('Exact Match');
		});

		it('should return undefined when playbooks is empty', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [] }));

			const result = getPlaybook('session-1', 'any-id');

			expect(result).toBeUndefined();
		});
	});

	describe('resolvePlaybookId', () => {
		it('should return exact match ID', () => {
			const playbook = mockPlaybook({ id: 'exact-playbook-id' });
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [playbook] }));

			const result = resolvePlaybookId('session-1', 'exact-playbook-id');

			expect(result).toBe('exact-playbook-id');
		});

		it('should return ID from single prefix match', () => {
			const playbooks = [
				mockPlaybook({ id: 'unique-prefix-123' }),
				mockPlaybook({ id: 'different-456' }),
			];
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks }));

			const result = resolvePlaybookId('session-1', 'unique');

			expect(result).toBe('unique-prefix-123');
		});

		it('should throw error when playbook not found', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [] }));

			expect(() => resolvePlaybookId('session-1', 'nonexistent')).toThrow(
				'Playbook not found: nonexistent'
			);
		});

		it('should throw error with match list when ambiguous', () => {
			const playbooks = [
				mockPlaybook({ id: 'test-playbook-1', name: 'First Playbook' }),
				mockPlaybook({ id: 'test-playbook-2', name: 'Second Playbook' }),
			];
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks }));

			expect(() => resolvePlaybookId('session-1', 'test')).toThrow(/Ambiguous playbook ID 'test'/);
		});

		it('should include playbook names and truncated IDs in ambiguous error', () => {
			const playbooks = [
				mockPlaybook({ id: 'test-abcdefgh-1', name: 'Alpha Playbook' }),
				mockPlaybook({ id: 'test-ijklmnop-2', name: 'Beta Playbook' }),
			];
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks }));

			try {
				resolvePlaybookId('session-1', 'test');
				expect.fail('Should have thrown');
			} catch (error) {
				expect((error as Error).message).toContain('test-abc');
				expect((error as Error).message).toContain('Alpha Playbook');
				expect((error as Error).message).toContain('test-ijk');
				expect((error as Error).message).toContain('Beta Playbook');
			}
		});

		it('should show Unknown when playbook name is missing in ambiguous error', () => {
			const playbooks = [
				{ ...mockPlaybook({ id: 'test-123' }), name: undefined as unknown as string },
				mockPlaybook({ id: 'test-456', name: 'Has Name' }),
			];
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks }));

			try {
				resolvePlaybookId('session-1', 'test');
				expect.fail('Should have thrown');
			} catch (error) {
				expect((error as Error).message).toContain('Unknown');
				expect((error as Error).message).toContain('Has Name');
			}
		});
	});

	describe('listAllPlaybooks', () => {
		it('should return empty array when playbooks directory does not exist', () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);

			const result = listAllPlaybooks();

			expect(result).toEqual([]);
			expect(fs.readdirSync).not.toHaveBeenCalled();
		});

		it('should list playbooks from all session files', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue([
				'session-1.json',
				'session-2.json',
			] as unknown as fs.Dirent[]);

			const session1Playbooks = [mockPlaybook({ id: 'pb-1', name: 'Playbook 1' })];
			const session2Playbooks = [
				mockPlaybook({ id: 'pb-2', name: 'Playbook 2' }),
				mockPlaybook({ id: 'pb-3', name: 'Playbook 3' }),
			];

			vi.mocked(fs.readFileSync).mockImplementation((filepath) => {
				if (String(filepath).includes('session-1.json')) {
					return JSON.stringify({ playbooks: session1Playbooks });
				}
				if (String(filepath).includes('session-2.json')) {
					return JSON.stringify({ playbooks: session2Playbooks });
				}
				throw new Error(`Unexpected file: ${filepath}`);
			});

			const result = listAllPlaybooks();

			expect(result).toHaveLength(3);
			expect(result.map((p) => p.sessionId)).toEqual(['session-1', 'session-2', 'session-2']);
		});

		it('should skip non-json files', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue([
				'session-1.json',
				'readme.txt',
				'.hidden',
				'session-2.json',
			] as unknown as fs.Dirent[]);

			vi.mocked(fs.readFileSync).mockImplementation((filepath) => {
				if (String(filepath).includes('session-1.json')) {
					return JSON.stringify({ playbooks: [mockPlaybook({ id: 'pb-1' })] });
				}
				if (String(filepath).includes('session-2.json')) {
					return JSON.stringify({ playbooks: [mockPlaybook({ id: 'pb-2' })] });
				}
				throw new Error(`Unexpected file read: ${filepath}`);
			});

			const result = listAllPlaybooks();

			expect(result).toHaveLength(2);
		});

		it('should return empty array on ENOENT error during readdir', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			const error = new Error('Directory not found') as NodeJS.ErrnoException;
			error.code = 'ENOENT';
			vi.mocked(fs.readdirSync).mockImplementation(() => {
				throw error;
			});

			const result = listAllPlaybooks();

			expect(result).toEqual([]);
		});

		it('should throw error for non-ENOENT errors during readdir', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			const error = new Error('Permission denied') as NodeJS.ErrnoException;
			error.code = 'EACCES';
			vi.mocked(fs.readdirSync).mockImplementation(() => {
				throw error;
			});

			expect(() => listAllPlaybooks()).toThrow('Permission denied');
		});

		it('should handle empty playbooks in session files', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue(['session-1.json'] as unknown as fs.Dirent[]);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [] }));

			const result = listAllPlaybooks();

			expect(result).toEqual([]);
		});

		it('should correctly extract session ID from filename', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue([
				'complex-session-id-123.json',
			] as unknown as fs.Dirent[]);
			vi.mocked(fs.readFileSync).mockReturnValue(
				JSON.stringify({ playbooks: [mockPlaybook({ id: 'pb-1' })] })
			);

			const result = listAllPlaybooks();

			expect(result[0].sessionId).toBe('complex-session-id-123');
		});

		it('should include all playbook properties plus sessionId', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue(['session-1.json'] as unknown as fs.Dirent[]);

			const playbook = mockPlaybook({
				id: 'pb-1',
				name: 'My Playbook',
				loopEnabled: true,
				maxLoops: 5,
				prompt: 'Custom prompt',
				documents: [
					{ filename: 'doc1.md', resetOnCompletion: true },
					{ filename: 'doc2.md', resetOnCompletion: false },
				],
			});
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [playbook] }));

			const result = listAllPlaybooks();

			expect(result[0]).toMatchObject({
				...playbook,
				sessionId: 'session-1',
			});
		});
	});

	describe('findPlaybookById', () => {
		it('should find playbook by exact ID match', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue(['session-1.json'] as unknown as fs.Dirent[]);

			const playbook = mockPlaybook({ id: 'exact-match-id' });
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [playbook] }));

			const result = findPlaybookById('exact-match-id');

			expect(result.playbook.id).toBe('exact-match-id');
			expect(result.agentId).toBe('session-1');
		});

		it('should find playbook by prefix match when single match', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue(['session-1.json'] as unknown as fs.Dirent[]);

			const playbooks = [
				mockPlaybook({ id: 'unique-prefix-123' }),
				mockPlaybook({ id: 'different-456' }),
			];
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks }));

			const result = findPlaybookById('unique');

			expect(result.playbook.id).toBe('unique-prefix-123');
		});

		it('should throw error when playbook not found', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue(['session-1.json'] as unknown as fs.Dirent[]);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [] }));

			expect(() => findPlaybookById('nonexistent')).toThrow('Playbook not found: nonexistent');
		});

		it('should throw error with match list when ambiguous across sessions', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue([
				'session-1.json',
				'session-2.json',
			] as unknown as fs.Dirent[]);

			vi.mocked(fs.readFileSync).mockImplementation((filepath) => {
				if (String(filepath).includes('session-1.json')) {
					return JSON.stringify({
						playbooks: [mockPlaybook({ id: 'test-123', name: 'First' })],
					});
				}
				if (String(filepath).includes('session-2.json')) {
					return JSON.stringify({
						playbooks: [mockPlaybook({ id: 'test-456', name: 'Second' })],
					});
				}
				throw new Error(`Unexpected file: ${filepath}`);
			});

			expect(() => findPlaybookById('test')).toThrow(/Ambiguous playbook ID 'test'/);
		});

		it('should include playbook names in ambiguous error message', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue(['session-1.json'] as unknown as fs.Dirent[]);

			const playbooks = [
				mockPlaybook({ id: 'ambig-1', name: 'Alpha' }),
				mockPlaybook({ id: 'ambig-2', name: 'Beta' }),
			];
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks }));

			try {
				findPlaybookById('ambig');
				expect.fail('Should have thrown');
			} catch (error) {
				expect((error as Error).message).toContain('Alpha');
				expect((error as Error).message).toContain('Beta');
			}
		});

		it('should throw when no playbooks directory exists', () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);

			expect(() => findPlaybookById('any-id')).toThrow('Playbook not found: any-id');
		});

		it('should return correct sessionId from containing file', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue([
				'agent-abc-123.json',
				'agent-xyz-789.json',
			] as unknown as fs.Dirent[]);

			vi.mocked(fs.readFileSync).mockImplementation((filepath) => {
				if (String(filepath).includes('agent-abc-123.json')) {
					return JSON.stringify({ playbooks: [] });
				}
				if (String(filepath).includes('agent-xyz-789.json')) {
					return JSON.stringify({
						playbooks: [mockPlaybook({ id: 'target-playbook' })],
					});
				}
				throw new Error(`Unexpected file: ${filepath}`);
			});

			const result = findPlaybookById('target-playbook');

			expect(result.agentId).toBe('agent-xyz-789');
		});
	});

	describe('edge cases', () => {
		it('should handle playbooks with special characters in IDs', () => {
			const playbook = mockPlaybook({ id: 'playbook_with-special.chars!123' });
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [playbook] }));

			const result = getPlaybook('session-1', 'playbook_with-special.chars!123');

			expect(result).toEqual(playbook);
		});

		it('should handle very long playbook IDs', () => {
			const longId = 'a'.repeat(200);
			const playbook = mockPlaybook({ id: longId });
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [playbook] }));

			const result = resolvePlaybookId('session-1', longId);

			expect(result).toBe(longId);
		});

		it('should handle unicode in playbook names', () => {
			const playbook = mockPlaybook({
				id: 'unicode-pb',
				name: '日本語プレイブック 🎮',
			});
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [playbook] }));

			const result = readPlaybooks('session-1');

			expect(result[0].name).toBe('日本語プレイブック 🎮');
		});

		it('should handle playbooks with empty documents array', () => {
			const playbook = mockPlaybook({ id: 'pb-1', documents: [] });
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [playbook] }));

			const result = readPlaybooks('session-1');

			expect(result[0].documents).toEqual([]);
		});

		it('should handle playbooks with worktreeSettings', () => {
			const playbook = mockPlaybook({
				id: 'pb-with-worktree',
				worktreeSettings: {
					branchNameTemplate: 'feature/{{date}}',
					createPROnCompletion: true,
					prTargetBranch: 'main',
				},
			});
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [playbook] }));

			const result = readPlaybooks('session-1');

			expect(result[0].worktreeSettings).toEqual({
				branchNameTemplate: 'feature/{{date}}',
				createPROnCompletion: true,
				prTargetBranch: 'main',
			});
		});

		it('should throw SyntaxError when JSON is invalid', () => {
			// Direct test of readPlaybooks with invalid JSON
			vi.mocked(fs.readFileSync).mockReturnValue('not valid json {');

			expect(() => readPlaybooks('any-session')).toThrow(SyntaxError);
		});

		it('should propagate JSON parse errors from listAllPlaybooks', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue(['broken-session.json'] as unknown as fs.Dirent[]);
			vi.mocked(fs.readFileSync).mockReturnValue('invalid { json');

			expect(() => listAllPlaybooks()).toThrow(SyntaxError);
		});

		it('should handle empty string session ID', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ playbooks: [] }));

			const result = readPlaybooks('');

			// Should still work, just with empty session ID in path
			expect(fs.readFileSync).toHaveBeenCalledWith(
				path.join('/mock/config', 'playbooks', '.json'),
				'utf-8'
			);
			expect(result).toEqual([]);
		});
	});
});
