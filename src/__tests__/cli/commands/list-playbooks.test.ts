/**
 * @file list-playbooks.test.ts
 * @description Tests for the list-playbooks CLI command
 *
 * Tests all functionality of the list-playbooks command including:
 * - Listing playbooks for a specific agent
 * - Listing all playbooks grouped by agent
 * - JSON output mode
 * - Filename normalization (.md extension)
 * - Empty playbooks handling
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Playbook, SessionInfo } from '../../../shared/types';

// Mock the playbooks service
vi.mock('../../../cli/services/playbooks', () => ({
	readPlaybooks: vi.fn(),
	listAllPlaybooks: vi.fn(),
}));

// Mock the storage service
vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(),
	resolveAgentId: vi.fn((id: string) => id),
	readSessions: vi.fn(),
}));

// Mock the formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatPlaybooks: vi.fn((playbooks, agentName, folderPath) => {
		if (playbooks.length === 0) {
			return 'No playbooks found.';
		}
		const header = agentName ? `Playbooks for ${agentName}:\n` : 'Playbooks:\n';
		return header + playbooks.map((p: any) => `${p.name} (${p.documents.length} docs)`).join('\n');
	}),
	formatPlaybooksByAgent: vi.fn((groups) => {
		const agentsWithPlaybooks = groups.filter((g: any) => g.playbooks.length > 0);
		if (agentsWithPlaybooks.length === 0) {
			return 'No playbooks found.';
		}
		return agentsWithPlaybooks
			.map((g: any) => `${g.agentName}:\n` + g.playbooks.map((p: any) => `  ${p.name}`).join('\n'))
			.join('\n\n');
	}),
	formatError: vi.fn((msg) => `Error: ${msg}`),
}));

import { listPlaybooks } from '../../../cli/commands/list-playbooks';
import { readPlaybooks, listAllPlaybooks } from '../../../cli/services/playbooks';
import { getSessionById, resolveAgentId, readSessions } from '../../../cli/services/storage';
import {
	formatPlaybooks,
	formatPlaybooksByAgent,
	formatError,
} from '../../../cli/output/formatter';

describe('list-playbooks command', () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let processExitSpy: ReturnType<typeof vi.spyOn>;

	const mockPlaybook = (overrides: Partial<Playbook> = {}): Playbook => ({
		id: 'pb-123',
		name: 'Test Playbook',
		documents: [{ filename: 'doc1.md', resetOnCompletion: false }],
		loopEnabled: false,
		maxLoops: null,
		...overrides,
	});

	const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
		id: 'agent-1',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/path/to/project',
		autoRunFolderPath: '/path/to/playbooks',
		...overrides,
	});

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

	describe('listing playbooks for a specific agent', () => {
		it('should list playbooks for a specific agent in human-readable format', () => {
			const mockAgent = mockSession({
				id: 'agent-1',
				name: 'My Agent',
				autoRunFolderPath: '/playbooks',
			});
			const mockPbs = [
				mockPlaybook({
					id: 'pb-1',
					name: 'Playbook One',
					documents: [{ filename: 'doc1.md', resetOnCompletion: false }],
				}),
				mockPlaybook({
					id: 'pb-2',
					name: 'Playbook Two',
					documents: [{ filename: 'doc2.md', resetOnCompletion: true }],
				}),
			];

			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(getSessionById).mockReturnValue(mockAgent);

			listPlaybooks({ agent: 'agent-1' });

			expect(resolveAgentId).toHaveBeenCalledWith('agent-1');
			expect(readPlaybooks).toHaveBeenCalledWith('agent-1');
			expect(getSessionById).toHaveBeenCalledWith('agent-1');
			expect(formatPlaybooks).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ id: 'pb-1', name: 'Playbook One' }),
					expect.objectContaining({ id: 'pb-2', name: 'Playbook Two' }),
				]),
				'My Agent',
				'/playbooks'
			);
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('should handle agent with no autoRunFolderPath', () => {
			const mockAgent = mockSession({
				id: 'agent-1',
				name: 'My Agent',
				autoRunFolderPath: undefined,
			});
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([mockPlaybook()]);
			vi.mocked(getSessionById).mockReturnValue(mockAgent);

			listPlaybooks({ agent: 'agent-1' });

			expect(formatPlaybooks).toHaveBeenCalledWith(expect.any(Array), 'My Agent', undefined);
		});

		it('should handle agent that does not exist (getSessionById returns undefined)', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([mockPlaybook()]);
			vi.mocked(getSessionById).mockReturnValue(undefined);

			listPlaybooks({ agent: 'agent-1' });

			expect(formatPlaybooks).toHaveBeenCalledWith(expect.any(Array), undefined, undefined);
		});

		it('should handle empty playbooks for agent', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1' });

			expect(formatPlaybooks).toHaveBeenCalledWith([], 'Test Agent', '/path/to/playbooks');
			expect(consoleSpy).toHaveBeenCalledWith('No playbooks found.');
		});

		it('should output JSON for specific agent when --json flag is used', () => {
			const mockAgent = mockSession({
				id: 'agent-1',
				name: 'Agent JSON',
				autoRunFolderPath: '/json/path',
			});
			const mockPbs = [
				mockPlaybook({
					id: 'pb-json-1',
					name: 'JSON Playbook',
					documents: [
						{ filename: 'readme', resetOnCompletion: false },
						{ filename: 'tasks.md', resetOnCompletion: true },
					],
					loopEnabled: true,
					maxLoops: 5,
				}),
			];

			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(getSessionById).mockReturnValue(mockAgent);

			listPlaybooks({ agent: 'agent-1', json: true });

			expect(consoleSpy).toHaveBeenCalledTimes(1);
			const outputCall = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(outputCall);

			expect(parsed).toHaveLength(1);
			expect(parsed[0]).toEqual({
				id: 'pb-json-1',
				name: 'JSON Playbook',
				agentId: 'agent-1',
				agentName: 'Agent JSON',
				folderPath: '/json/path',
				loopEnabled: true,
				maxLoops: 5,
				documents: [
					{ filename: 'readme.md', resetOnCompletion: false },
					{ filename: 'tasks.md', resetOnCompletion: true },
				],
			});
		});

		it('should normalize filenames without .md extension in JSON output', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([
				mockPlaybook({
					documents: [
						{ filename: 'no-extension', resetOnCompletion: false },
						{ filename: 'already.md', resetOnCompletion: true },
					],
				}),
			]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].documents[0].filename).toBe('no-extension.md');
			expect(parsed[0].documents[1].filename).toBe('already.md');
		});

		it('should normalize filenames without .md extension in human-readable output', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([
				mockPlaybook({
					documents: [{ filename: 'no-extension', resetOnCompletion: false }],
				}),
			]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1' });

			// Check that formatPlaybooks was called with normalized filenames
			const callArgs = vi.mocked(formatPlaybooks).mock.calls[0];
			expect(callArgs[0][0].documents[0].filename).toBe('no-extension.md');
		});
	});

	describe('listing all playbooks grouped by agent', () => {
		it('should list all playbooks grouped by agent in human-readable format', () => {
			const mockPbs = [
				{ ...mockPlaybook({ id: 'pb-1', name: 'Playbook A' }), sessionId: 'agent-1' },
				{ ...mockPlaybook({ id: 'pb-2', name: 'Playbook B' }), sessionId: 'agent-1' },
				{ ...mockPlaybook({ id: 'pb-3', name: 'Playbook C' }), sessionId: 'agent-2' },
			];
			const mockSessionsList = [
				mockSession({ id: 'agent-1', name: 'Agent One' }),
				mockSession({ id: 'agent-2', name: 'Agent Two' }),
			];

			vi.mocked(listAllPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(readSessions).mockReturnValue(mockSessionsList);

			listPlaybooks({});

			expect(listAllPlaybooks).toHaveBeenCalled();
			expect(readSessions).toHaveBeenCalled();
			expect(formatPlaybooksByAgent).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({
						agentId: 'agent-1',
						agentName: 'Agent One',
						playbooks: expect.arrayContaining([
							expect.objectContaining({ id: 'pb-1', name: 'Playbook A' }),
							expect.objectContaining({ id: 'pb-2', name: 'Playbook B' }),
						]),
					}),
					expect.objectContaining({
						agentId: 'agent-2',
						agentName: 'Agent Two',
						playbooks: expect.arrayContaining([
							expect.objectContaining({ id: 'pb-3', name: 'Playbook C' }),
						]),
					}),
				])
			);
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('should handle empty playbooks list', () => {
			vi.mocked(listAllPlaybooks).mockReturnValue([]);
			vi.mocked(readSessions).mockReturnValue([]);

			listPlaybooks({});

			expect(formatPlaybooksByAgent).toHaveBeenCalledWith([]);
			expect(consoleSpy).toHaveBeenCalledWith('No playbooks found.');
		});

		it('should use "Unknown Agent" when session is not found', () => {
			const mockPbs = [
				{ ...mockPlaybook({ id: 'pb-1', name: 'Orphan Playbook' }), sessionId: 'unknown-agent' },
			];
			vi.mocked(listAllPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(readSessions).mockReturnValue([]);

			listPlaybooks({});

			const callArgs = vi.mocked(formatPlaybooksByAgent).mock.calls[0][0];
			expect(callArgs[0].agentName).toBe('Unknown Agent');
		});

		it('should output JSON for all playbooks when --json flag is used', () => {
			const mockPbs = [
				{
					...mockPlaybook({
						id: 'pb-1',
						name: 'Global PB 1',
						loopEnabled: true,
						maxLoops: 3,
						documents: [{ filename: 'tasks', resetOnCompletion: false }],
					}),
					sessionId: 'agent-1',
				},
				{
					...mockPlaybook({
						id: 'pb-2',
						name: 'Global PB 2',
						documents: [{ filename: 'work.md', resetOnCompletion: true }],
					}),
					sessionId: 'agent-2',
				},
			];
			const mockSessionsList = [
				mockSession({ id: 'agent-1', name: 'Agent Alpha', autoRunFolderPath: '/alpha/playbooks' }),
				mockSession({ id: 'agent-2', name: 'Agent Beta', autoRunFolderPath: '/beta/playbooks' }),
			];

			vi.mocked(listAllPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(readSessions).mockReturnValue(mockSessionsList);

			listPlaybooks({ json: true });

			expect(consoleSpy).toHaveBeenCalledTimes(1);
			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);

			expect(parsed).toHaveLength(2);
			expect(parsed[0]).toEqual({
				id: 'pb-1',
				name: 'Global PB 1',
				agentId: 'agent-1',
				agentName: 'Agent Alpha',
				folderPath: '/alpha/playbooks',
				loopEnabled: true,
				maxLoops: 3,
				documents: [{ filename: 'tasks.md', resetOnCompletion: false }],
			});
			expect(parsed[1]).toEqual({
				id: 'pb-2',
				name: 'Global PB 2',
				agentId: 'agent-2',
				agentName: 'Agent Beta',
				folderPath: '/beta/playbooks',
				loopEnabled: false,
				maxLoops: null,
				documents: [{ filename: 'work.md', resetOnCompletion: true }],
			});
		});

		it('should handle session not found in JSON output', () => {
			const mockPbs = [
				{ ...mockPlaybook({ id: 'pb-1', name: 'Orphan' }), sessionId: 'missing-agent' },
			];
			vi.mocked(listAllPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(readSessions).mockReturnValue([]);

			listPlaybooks({ json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].agentName).toBeUndefined();
			expect(parsed[0].folderPath).toBeUndefined();
		});

		it('should normalize filenames in grouped output', () => {
			const mockPbs = [
				{
					...mockPlaybook({
						documents: [{ filename: 'no-ext', resetOnCompletion: false }],
					}),
					sessionId: 'agent-1',
				},
			];
			vi.mocked(listAllPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(readSessions).mockReturnValue([mockSession({ id: 'agent-1' })]);

			listPlaybooks({});

			const callArgs = vi.mocked(formatPlaybooksByAgent).mock.calls[0][0];
			expect(callArgs[0].playbooks[0].documents[0].filename).toBe('no-ext.md');
		});
	});

	describe('error handling', () => {
		it('should handle resolveAgentId throwing an error', () => {
			vi.mocked(resolveAgentId).mockImplementation(() => {
				throw new Error('Agent not found: xyz');
			});

			expect(() => listPlaybooks({ agent: 'xyz' })).toThrow('process.exit(1)');

			expect(consoleErrorSpy).toHaveBeenCalled();
			expect(formatError).toHaveBeenCalledWith('Failed to list playbooks: Agent not found: xyz');
		});

		it('should handle resolveAgentId error with JSON output', () => {
			vi.mocked(resolveAgentId).mockImplementation(() => {
				throw new Error('Agent not found: xyz');
			});

			expect(() => listPlaybooks({ agent: 'xyz', json: true })).toThrow('process.exit(1)');

			const errorOutput = consoleErrorSpy.mock.calls[0][0];
			expect(JSON.parse(errorOutput)).toEqual({ error: 'Agent not found: xyz' });
		});

		it('should handle readPlaybooks throwing an error', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockImplementation(() => {
				throw new Error('Storage error');
			});

			expect(() => listPlaybooks({ agent: 'agent-1' })).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Failed to list playbooks: Storage error');
		});

		it('should handle listAllPlaybooks throwing an error', () => {
			vi.mocked(listAllPlaybooks).mockImplementation(() => {
				throw new Error('Failed to read playbooks directory');
			});

			expect(() => listPlaybooks({})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith(
				'Failed to list playbooks: Failed to read playbooks directory'
			);
		});

		it('should handle listAllPlaybooks error with JSON output', () => {
			vi.mocked(listAllPlaybooks).mockImplementation(() => {
				throw new Error('Failed to read playbooks directory');
			});

			expect(() => listPlaybooks({ json: true })).toThrow('process.exit(1)');

			const errorOutput = consoleErrorSpy.mock.calls[0][0];
			expect(JSON.parse(errorOutput)).toEqual({ error: 'Failed to read playbooks directory' });
		});

		it('should handle non-Error throws', () => {
			vi.mocked(listAllPlaybooks).mockImplementation(() => {
				throw 'string error';
			});

			expect(() => listPlaybooks({})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Failed to list playbooks: Unknown error');
		});

		it('should handle non-Error throws with JSON output', () => {
			vi.mocked(listAllPlaybooks).mockImplementation(() => {
				throw { custom: 'object error' };
			});

			expect(() => listPlaybooks({ json: true })).toThrow('process.exit(1)');

			const errorOutput = consoleErrorSpy.mock.calls[0][0];
			expect(JSON.parse(errorOutput)).toEqual({ error: 'Unknown error' });
		});
	});

	describe('edge cases', () => {
		it('should handle playbook with empty documents array', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([mockPlaybook({ documents: [] })]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1' });

			const callArgs = vi.mocked(formatPlaybooks).mock.calls[0];
			expect(callArgs[0][0].documents).toEqual([]);
		});

		it('should handle multiple agents with varying playbook counts', () => {
			const mockPbs = [
				{ ...mockPlaybook({ id: 'pb-1' }), sessionId: 'agent-1' },
				{ ...mockPlaybook({ id: 'pb-2' }), sessionId: 'agent-1' },
				{ ...mockPlaybook({ id: 'pb-3' }), sessionId: 'agent-1' },
				{ ...mockPlaybook({ id: 'pb-4' }), sessionId: 'agent-2' },
			];
			const mockSessionsList = [
				mockSession({ id: 'agent-1', name: 'Agent One' }),
				mockSession({ id: 'agent-2', name: 'Agent Two' }),
			];

			vi.mocked(listAllPlaybooks).mockReturnValue(mockPbs);
			vi.mocked(readSessions).mockReturnValue(mockSessionsList);

			listPlaybooks({});

			const callArgs = vi.mocked(formatPlaybooksByAgent).mock.calls[0][0];
			expect(callArgs.find((g: any) => g.agentId === 'agent-1').playbooks).toHaveLength(3);
			expect(callArgs.find((g: any) => g.agentId === 'agent-2').playbooks).toHaveLength(1);
		});

		it('should handle playbook with null maxLoops', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([
				mockPlaybook({ loopEnabled: true, maxLoops: null }),
			]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].loopEnabled).toBe(true);
			expect(parsed[0].maxLoops).toBe(null);
		});

		it('should handle playbook with specific maxLoops value', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([mockPlaybook({ loopEnabled: true, maxLoops: 10 })]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].loopEnabled).toBe(true);
			expect(parsed[0].maxLoops).toBe(10);
		});

		it('should handle special characters in playbook names', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([
				mockPlaybook({ name: 'Playbook with "quotes" and <brackets>' }),
			]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].name).toBe('Playbook with "quotes" and <brackets>');
		});

		it('should handle unicode characters in playbook names', () => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([mockPlaybook({ name: '日本語プレイブック 🎭' })]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].name).toBe('日本語プレイブック 🎭');
		});

		it('should handle very long filenames', () => {
			const longFilename = 'a'.repeat(200);
			vi.mocked(resolveAgentId).mockReturnValue('agent-1');
			vi.mocked(readPlaybooks).mockReturnValue([
				mockPlaybook({ documents: [{ filename: longFilename, resetOnCompletion: false }] }),
			]);
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			listPlaybooks({ agent: 'agent-1', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed[0].documents[0].filename).toBe(longFilename + '.md');
		});

		it('should handle partial agent ID resolution', () => {
			vi.mocked(resolveAgentId).mockReturnValue('full-agent-id-1234');
			vi.mocked(readPlaybooks).mockReturnValue([mockPlaybook()]);
			vi.mocked(getSessionById).mockReturnValue(mockSession({ id: 'full-agent-id-1234' }));

			listPlaybooks({ agent: 'full-agent' });

			expect(resolveAgentId).toHaveBeenCalledWith('full-agent');
			expect(readPlaybooks).toHaveBeenCalledWith('full-agent-id-1234');
		});
	});
});
