/**
 * @file show-playbook.test.ts
 * @description Tests for the show-playbook CLI command
 *
 * Tests all functionality of the show-playbook command including:
 * - Displaying playbook details with documents and tasks
 * - JSON output mode
 * - Document task counting
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionInfo, Playbook } from '../../../shared/types';

// Mock the services
vi.mock('../../../cli/services/playbooks', () => ({
	findPlaybookById: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(),
}));

vi.mock('../../../cli/services/agent-spawner', () => ({
	readDocAndGetTasks: vi.fn(),
}));

// Mock the formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatPlaybookDetail: vi.fn((detail) => `Playbook: ${detail.name}\nAgent: ${detail.agentName}`),
	formatError: vi.fn((msg) => `Error: ${msg}`),
}));

import { showPlaybook } from '../../../cli/commands/show-playbook';
import { findPlaybookById } from '../../../cli/services/playbooks';
import { getSessionById } from '../../../cli/services/storage';
import { readDocAndGetTasks } from '../../../cli/services/agent-spawner';
import { formatPlaybookDetail, formatError } from '../../../cli/output/formatter';

describe('show-playbook command', () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let processExitSpy: ReturnType<typeof vi.spyOn>;

	const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
		id: 'agent-123',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/path/to/project',
		projectRoot: '/path/to/project',
		groupId: undefined,
		autoRunFolderPath: '/path/to/playbooks',
		...overrides,
	});

	const mockPlaybook = (overrides: Partial<Playbook> = {}): Playbook => ({
		id: 'playbook-123',
		name: 'Test Playbook',
		documents: [
			{ filename: 'doc1.md', resetOnCompletion: false },
			{ filename: 'doc2.md', resetOnCompletion: true },
		],
		loopEnabled: false,
		maxLoops: null,
		prompt: null,
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

	describe('basic display', () => {
		it('should display playbook details in human-readable format', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook(),
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readDocAndGetTasks).mockReturnValue({ tasks: ['Task 1', 'Task 2'] });

			showPlaybook('playbook-123', {});

			expect(findPlaybookById).toHaveBeenCalledWith('playbook-123');
			expect(formatPlaybookDetail).toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('should include document details with task counts', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook(),
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readDocAndGetTasks)
				.mockReturnValueOnce({ tasks: ['Task 1', 'Task 2', 'Task 3'] })
				.mockReturnValueOnce({ tasks: ['Task A'] });

			showPlaybook('playbook-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.documents).toHaveLength(2);
			expect(parsed.documents[0].taskCount).toBe(3);
			expect(parsed.documents[1].taskCount).toBe(1);
			expect(parsed.totalTasks).toBe(4);
		});

		it('should add .md extension if not present', () => {
			const playbook = mockPlaybook({
				documents: [{ filename: 'doc-without-extension', resetOnCompletion: false }],
			});
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook,
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readDocAndGetTasks).mockReturnValue({ tasks: [] });

			showPlaybook('playbook-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.documents[0].filename).toBe('doc-without-extension.md');
		});

		it('should not duplicate .md extension', () => {
			const playbook = mockPlaybook({
				documents: [{ filename: 'doc.md', resetOnCompletion: false }],
			});
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook,
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readDocAndGetTasks).mockReturnValue({ tasks: [] });

			showPlaybook('playbook-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.documents[0].filename).toBe('doc.md');
		});
	});

	describe('loop settings', () => {
		it('should include loop settings in output', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook({ loopEnabled: true, maxLoops: 5 }),
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readDocAndGetTasks).mockReturnValue({ tasks: [] });

			showPlaybook('playbook-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.loopEnabled).toBe(true);
			expect(parsed.maxLoops).toBe(5);
		});

		it('should include null maxLoops for infinite loop', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook({ loopEnabled: true, maxLoops: null }),
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readDocAndGetTasks).mockReturnValue({ tasks: [] });

			showPlaybook('playbook-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.loopEnabled).toBe(true);
			expect(parsed.maxLoops).toBe(null);
		});
	});

	describe('prompt handling', () => {
		it('should include custom prompt in output', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook({ prompt: 'Custom instructions for the agent' }),
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readDocAndGetTasks).mockReturnValue({ tasks: [] });

			showPlaybook('playbook-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.prompt).toBe('Custom instructions for the agent');
		});

		it('should include null prompt when not set', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook({ prompt: null }),
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readDocAndGetTasks).mockReturnValue({ tasks: [] });

			showPlaybook('playbook-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.prompt).toBe(null);
		});
	});

	describe('agent without autoRunFolderPath', () => {
		it('should return empty tasks when agent has no autoRunFolderPath', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook(),
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(mockSession({ autoRunFolderPath: undefined }));

			showPlaybook('playbook-123', { json: true });

			expect(readDocAndGetTasks).not.toHaveBeenCalled();

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.documents[0].taskCount).toBe(0);
			expect(parsed.documents[0].tasks).toEqual([]);
		});
	});

	describe('JSON output', () => {
		it('should output JSON when json option is true', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook(),
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readDocAndGetTasks).mockReturnValue({ tasks: [] });

			showPlaybook('playbook-123', { json: true });

			expect(formatPlaybookDetail).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledTimes(1);

			const output = consoleSpy.mock.calls[0][0];
			expect(() => JSON.parse(output)).not.toThrow();
		});

		it('should include all properties in JSON output', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook({
					id: 'pb-full',
					name: 'Full Playbook',
					loopEnabled: true,
					maxLoops: 3,
					prompt: 'Do the thing',
					documents: [{ filename: 'task.md', resetOnCompletion: true }],
				}),
				agentId: 'agent-full',
			});
			vi.mocked(getSessionById).mockReturnValue(
				mockSession({
					id: 'agent-full',
					name: 'Full Agent',
					autoRunFolderPath: '/playbooks',
				})
			);
			vi.mocked(readDocAndGetTasks).mockReturnValue({ tasks: ['Task 1', 'Task 2'] });

			showPlaybook('pb-full', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.id).toBe('pb-full');
			expect(parsed.name).toBe('Full Playbook');
			expect(parsed.agentId).toBe('agent-full');
			expect(parsed.agentName).toBe('Full Agent');
			expect(parsed.folderPath).toBe('/playbooks');
			expect(parsed.loopEnabled).toBe(true);
			expect(parsed.maxLoops).toBe(3);
			expect(parsed.prompt).toBe('Do the thing');
			expect(parsed.documents).toHaveLength(1);
			expect(parsed.documents[0].resetOnCompletion).toBe(true);
			expect(parsed.documents[0].tasks).toEqual(['Task 1', 'Task 2']);
			expect(parsed.totalTasks).toBe(2);
		});
	});

	describe('error handling', () => {
		it('should throw error when playbook not found', () => {
			vi.mocked(findPlaybookById).mockImplementation(() => {
				throw new Error('Playbook not found: nonexistent');
			});

			expect(() => showPlaybook('nonexistent', {})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Playbook not found: nonexistent');
		});

		it('should throw error when agent not found', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook(),
				agentId: 'missing-agent',
			});
			vi.mocked(getSessionById).mockReturnValue(undefined);

			expect(() => showPlaybook('playbook-123', {})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Agent not found: missing-agent');
		});

		it('should output error as JSON when json option is true', () => {
			vi.mocked(findPlaybookById).mockImplementation(() => {
				throw new Error('Ambiguous playbook ID');
			});

			expect(() => showPlaybook('amb', { json: true })).toThrow('process.exit(1)');

			const errorOutput = consoleErrorSpy.mock.calls[0][0];
			const parsed = JSON.parse(errorOutput);
			expect(parsed.error).toBe('Ambiguous playbook ID');
		});

		it('should handle non-Error objects thrown', () => {
			vi.mocked(findPlaybookById).mockImplementation(() => {
				throw 'String error';
			});

			expect(() => showPlaybook('playbook-123', {})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Unknown error');
		});

		it('should exit with code 1 on error', () => {
			vi.mocked(findPlaybookById).mockImplementation(() => {
				throw new Error('Test error');
			});

			expect(() => showPlaybook('playbook-123', {})).toThrow('process.exit(1)');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('edge cases', () => {
		it('should handle playbook with no documents', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook({ documents: [] }),
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(mockSession());

			showPlaybook('playbook-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.documents).toEqual([]);
			expect(parsed.totalTasks).toBe(0);
		});

		it('should handle partial playbook ID', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook(),
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readDocAndGetTasks).mockReturnValue({ tasks: [] });

			showPlaybook('pb', {});

			expect(findPlaybookById).toHaveBeenCalledWith('pb');
		});

		it('should include resetOnCompletion for each document', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook({
					documents: [
						{ filename: 'reset.md', resetOnCompletion: true },
						{ filename: 'keep.md', resetOnCompletion: false },
					],
				}),
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readDocAndGetTasks).mockReturnValue({ tasks: [] });

			showPlaybook('playbook-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.documents[0].resetOnCompletion).toBe(true);
			expect(parsed.documents[1].resetOnCompletion).toBe(false);
		});

		it('should pass correct params to readDocAndGetTasks', () => {
			vi.mocked(findPlaybookById).mockReturnValue({
				playbook: mockPlaybook({
					documents: [{ filename: 'task.md', resetOnCompletion: false }],
				}),
				agentId: 'agent-123',
			});
			vi.mocked(getSessionById).mockReturnValue(
				mockSession({ autoRunFolderPath: '/my/playbooks' })
			);
			vi.mocked(readDocAndGetTasks).mockReturnValue({ tasks: [] });

			showPlaybook('playbook-123', {});

			expect(readDocAndGetTasks).toHaveBeenCalledWith('/my/playbooks', 'task.md');
		});
	});
});
