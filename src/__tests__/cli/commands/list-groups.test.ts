/**
 * @file list-groups.test.ts
 * @description Tests for the list-groups CLI command
 *
 * Tests all functionality of the list-groups command including:
 * - Human-readable output formatting
 * - JSON output mode
 * - Empty groups handling
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Group } from '../../../shared/types';

// Mock the storage service
vi.mock('../../../cli/services/storage', () => ({
	readGroups: vi.fn(),
}));

// Mock the formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatGroups: vi.fn((groups) =>
		groups.length === 0
			? 'No groups found'
			: `Groups:\n${groups.map((g: any) => `${g.emoji} ${g.name}`).join('\n')}`
	),
	formatError: vi.fn((msg) => `Error: ${msg}`),
}));

import { listGroups } from '../../../cli/commands/list-groups';
import { readGroups } from '../../../cli/services/storage';
import { formatGroups, formatError } from '../../../cli/output/formatter';

describe('list-groups command', () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let processExitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi
			.spyOn(process, 'exit')
			.mockImplementation((code?: string | number | null | undefined) => {
				throw new Error(`process.exit(${code})`);
			});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	describe('human-readable output', () => {
		it('should display groups in human-readable format', () => {
			const mockGroups: Group[] = [
				{ id: 'group-1', name: 'Frontend', emoji: '🎨', collapsed: false },
				{ id: 'group-2', name: 'Backend', emoji: '⚙️', collapsed: true },
			];
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listGroups({});

			expect(readGroups).toHaveBeenCalled();
			expect(formatGroups).toHaveBeenCalledWith([
				{ id: 'group-1', name: 'Frontend', emoji: '🎨', collapsed: false },
				{ id: 'group-2', name: 'Backend', emoji: '⚙️', collapsed: true },
			]);
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('should handle empty groups list', () => {
			vi.mocked(readGroups).mockReturnValue([]);

			listGroups({});

			expect(formatGroups).toHaveBeenCalledWith([]);
			expect(consoleSpy).toHaveBeenCalledWith('No groups found');
		});

		it('should display a single group', () => {
			const mockGroups: Group[] = [
				{ id: 'group-single', name: 'Solo Group', emoji: '🌟', collapsed: false },
			];
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listGroups({});

			expect(formatGroups).toHaveBeenCalledWith([
				{ id: 'group-single', name: 'Solo Group', emoji: '🌟', collapsed: false },
			]);
		});

		it('should pass collapsed state to formatter', () => {
			const mockGroups: Group[] = [
				{ id: 'g1', name: 'Expanded', emoji: '📂', collapsed: false },
				{ id: 'g2', name: 'Collapsed', emoji: '📁', collapsed: true },
			];
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listGroups({});

			expect(formatGroups).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ collapsed: false }),
					expect.objectContaining({ collapsed: true }),
				])
			);
		});
	});

	describe('JSON output', () => {
		it('should output JSON when json option is true', () => {
			const mockGroups: Group[] = [
				{ id: 'group-1', name: 'Test Group', emoji: '🔧', collapsed: false },
			];
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listGroups({ json: true });

			expect(formatGroups).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledTimes(1);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed).toEqual([
				{ id: 'group-1', name: 'Test Group', emoji: '🔧', collapsed: false },
			]);
		});

		it('includes parentGroupId for nested groups', () => {
			vi.mocked(readGroups).mockReturnValue([
				{ id: 'company', name: 'Company', emoji: '🏢', collapsed: false },
				{
					id: 'project',
					name: 'Project',
					emoji: '📁',
					collapsed: false,
					parentGroupId: 'company',
				},
			]);

			listGroups({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			expect(JSON.parse(output)[1]).toMatchObject({ parentGroupId: 'company' });
		});

		it('should output empty JSON array for no groups', () => {
			vi.mocked(readGroups).mockReturnValue([]);

			listGroups({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed).toEqual([]);
		});

		it('should output multiple groups as JSON array', () => {
			const mockGroups: Group[] = [
				{ id: 'g1', name: 'Group One', emoji: '1️⃣', collapsed: false },
				{ id: 'g2', name: 'Group Two', emoji: '2️⃣', collapsed: true },
				{ id: 'g3', name: 'Group Three', emoji: '3️⃣', collapsed: false },
			];
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listGroups({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed).toHaveLength(3);
			expect(parsed[0].id).toBe('g1');
			expect(parsed[1].id).toBe('g2');
			expect(parsed[2].id).toBe('g3');
		});

		it('should format JSON with indentation', () => {
			const mockGroups: Group[] = [{ id: 'g1', name: 'Test', emoji: '🧪', collapsed: false }];
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listGroups({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			// JSON.stringify with null, 2 produces indented output
			expect(output).toContain('\n');
			expect(output).toContain('  ');
		});

		it('should include all group properties in JSON output', () => {
			const mockGroups: Group[] = [
				{ id: 'full-group', name: 'Full Group', emoji: '✨', collapsed: true },
			];
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listGroups({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed[0]).toHaveProperty('id', 'full-group');
			expect(parsed[0]).toHaveProperty('name', 'Full Group');
			expect(parsed[0]).toHaveProperty('emoji', '✨');
			expect(parsed[0]).toHaveProperty('collapsed', true);
		});
	});

	describe('error handling', () => {
		it('should handle storage read errors in human-readable mode', () => {
			const error = new Error('Storage read failed');
			vi.mocked(readGroups).mockImplementation(() => {
				throw error;
			});

			expect(() => listGroups({})).toThrow('process.exit(1)');

			expect(consoleErrorSpy).toHaveBeenCalled();
			expect(formatError).toHaveBeenCalledWith('Failed to list groups: Storage read failed');
		});

		it('should handle storage read errors in JSON mode', () => {
			const error = new Error('JSON storage error');
			vi.mocked(readGroups).mockImplementation(() => {
				throw error;
			});

			expect(() => listGroups({ json: true })).toThrow('process.exit(1)');

			expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
			const errorOutput = consoleErrorSpy.mock.calls[0][0];
			const parsed = JSON.parse(errorOutput);
			expect(parsed.error).toBe('JSON storage error');
		});

		it('should handle non-Error objects thrown', () => {
			vi.mocked(readGroups).mockImplementation(() => {
				throw 'String error';
			});

			expect(() => listGroups({})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Failed to list groups: Unknown error');
		});

		it('should handle non-Error objects in JSON mode', () => {
			vi.mocked(readGroups).mockImplementation(() => {
				throw { custom: 'error object' };
			});

			expect(() => listGroups({ json: true })).toThrow('process.exit(1)');

			const errorOutput = consoleErrorSpy.mock.calls[0][0];
			const parsed = JSON.parse(errorOutput);
			expect(parsed.error).toBe('Unknown error');
		});

		it('should exit with code 1 on error', () => {
			vi.mocked(readGroups).mockImplementation(() => {
				throw new Error('Exit test');
			});

			expect(() => listGroups({})).toThrow('process.exit(1)');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('edge cases', () => {
		it('should handle groups with empty emoji', () => {
			const mockGroups: Group[] = [
				{ id: 'no-emoji', name: 'No Emoji Group', emoji: '', collapsed: false },
			];
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listGroups({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed[0].emoji).toBe('');
		});

		it('should handle groups with special characters in name', () => {
			const mockGroups: Group[] = [
				{ id: 'special', name: 'Group "with" <special> & chars', emoji: '🔥', collapsed: false },
			];
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listGroups({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed[0].name).toBe('Group "with" <special> & chars');
		});

		it('should handle groups with unicode names', () => {
			const mockGroups: Group[] = [
				{ id: 'unicode', name: '日本語グループ', emoji: '🇯🇵', collapsed: false },
			];
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listGroups({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed[0].name).toBe('日本語グループ');
		});

		it('should handle options object with json: false', () => {
			const mockGroups: Group[] = [{ id: 'test', name: 'Test', emoji: '📝', collapsed: false }];
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listGroups({ json: false });

			expect(formatGroups).toHaveBeenCalled();
		});

		it('should handle options object with undefined json', () => {
			const mockGroups: Group[] = [{ id: 'test', name: 'Test', emoji: '📝', collapsed: false }];
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listGroups({ json: undefined });

			expect(formatGroups).toHaveBeenCalled();
		});

		it('should preserve group order from storage', () => {
			const mockGroups: Group[] = [
				{ id: 'z-last', name: 'Z Last', emoji: 'z', collapsed: false },
				{ id: 'a-first', name: 'A First', emoji: 'a', collapsed: false },
				{ id: 'm-middle', name: 'M Middle', emoji: 'm', collapsed: false },
			];
			vi.mocked(readGroups).mockReturnValue(mockGroups);

			listGroups({ json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed[0].id).toBe('z-last');
			expect(parsed[1].id).toBe('a-first');
			expect(parsed[2].id).toBe('m-middle');
		});
	});
});
