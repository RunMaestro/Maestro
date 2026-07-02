/**
 * @file run-doc.test.ts
 * @description Tests for the run-doc CLI command (run raw Auto Run documents
 * headlessly without a saved playbook).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { SessionInfo } from '../../../shared/types';

vi.mock('fs', () => ({
	readFileSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

vi.mock('os', () => ({
	platform: vi.fn(() => 'darwin'),
	homedir: vi.fn(() => '/Users/test'),
}));

vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(),
	resolveAgentId: vi.fn(),
}));

vi.mock('../../../cli/services/batch-processor', () => ({
	runPlaybook: vi.fn(),
}));

vi.mock('../../../cli/services/agent-spawner', () => ({
	detectAgent: vi.fn(),
}));

vi.mock('../../../main/agents/definitions', () => ({
	getAgentDefinition: vi.fn((agentId: string) => {
		const defs: Record<string, { name: string; binaryName: string }> = {
			'claude-code': { name: 'Claude Code', binaryName: 'claude' },
		};
		return defs[agentId] || undefined;
	}),
}));

vi.mock('../../../cli/output/jsonl', () => ({
	emitError: vi.fn((msg, code) => {
		console.error(JSON.stringify({ type: 'error', message: msg, code }));
	}),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatRunEvent: vi.fn((event: any) => `[${event.type}] ${event.message || ''}`),
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatInfo: vi.fn((msg) => `Info: ${msg}`),
	formatWarning: vi.fn((msg) => `Warning: ${msg}`),
}));

vi.mock('../../../shared/cli-activity', () => ({
	isSessionBusyWithCli: vi.fn(),
	getCliActivityForSession: vi.fn(),
}));

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import { runDoc } from '../../../cli/commands/run-doc';
import { getSessionById, resolveAgentId } from '../../../cli/services/storage';
import { runPlaybook as executePlaybook } from '../../../cli/services/batch-processor';
import { detectAgent } from '../../../cli/services/agent-spawner';
import { emitError } from '../../../cli/output/jsonl';
import { formatError, formatInfo } from '../../../cli/output/formatter';
import { isSessionBusyWithCli, getCliActivityForSession } from '../../../shared/cli-activity';

describe('run-doc command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
		id: 'agent-1',
		name: 'Frontend',
		toolType: 'claude-code',
		cwd: '/path/to/project',
		projectRoot: '/path/to/project',
		autoRunFolderPath: '/path/to/playbooks',
		...overrides,
	});

	async function* mockEventGenerator(events: any[]) {
		for (const event of events) {
			yield event;
		}
	}

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi
			.spyOn(process, 'exit')
			.mockImplementation((code?: string | number | null | undefined) => {
				throw new Error(`process.exit(${code})`);
			});

		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/local/bin/claude' });
		vi.mocked(isSessionBusyWithCli).mockReturnValue(false);
		vi.mocked(getCliActivityForSession).mockReturnValue(undefined);
		vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ sessions: [] }));
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(os.platform).mockReturnValue('darwin');
		vi.mocked(os.homedir).mockReturnValue('/Users/test');
		vi.mocked(resolveAgentId).mockReturnValue('agent-1');
		vi.mocked(getSessionById).mockReturnValue(mockSession());
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	it('runs a document relative to the agent Auto Run folder with an ephemeral playbook', async () => {
		vi.mocked(executePlaybook).mockReturnValue(mockEventGenerator([{ type: 'complete' }]));

		await runDoc(['plans/frontend-plan.md'], { agent: 'Frontend' });

		expect(resolveAgentId).toHaveBeenCalledWith('Frontend');
		expect(executePlaybook).toHaveBeenCalledWith(
			mockSession(),
			expect.objectContaining({
				documents: [{ filename: path.join('plans', 'frontend-plan'), resetOnCompletion: false }],
				prompt: '',
				loopEnabled: false,
			}),
			'/path/to/playbooks',
			expect.objectContaining({ writeHistory: true, skipSynopsis: false })
		);
		expect(formatInfo).toHaveBeenCalledWith('Agent: Frontend');
	});

	it('passes loop configuration through to the ephemeral playbook', async () => {
		vi.mocked(executePlaybook).mockReturnValue(mockEventGenerator([]));

		await runDoc(['plan.md'], { agent: 'agent-1', loop: true, maxLoops: '3' });

		expect(executePlaybook).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ loopEnabled: true, maxLoops: 3 }),
			expect.anything(),
			expect.anything()
		);
	});

	it('errors when the agent cannot be resolved', async () => {
		vi.mocked(resolveAgentId).mockImplementation(() => {
			throw new Error('Agent not found: Nope');
		});

		await expect(runDoc(['plan.md'], { agent: 'Nope', json: true })).rejects.toThrow(
			'process.exit(1)'
		);
		expect(emitError).toHaveBeenCalledWith('Agent not found: Nope', 'AGENT_NOT_FOUND');
	});

	it('errors when a document does not exist', async () => {
		vi.mocked(fs.existsSync).mockReturnValue(false);

		await expect(runDoc(['missing.md'], { agent: 'agent-1' })).rejects.toThrow('process.exit(1)');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('File not found'));
	});

	it('errors when a document is not a .md file', async () => {
		await expect(runDoc(['notes.txt'], { agent: 'agent-1' })).rejects.toThrow('process.exit(1)');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('must be a .md file'));
	});

	it('errors when the agent is busy and --wait is not set', async () => {
		vi.mocked(isSessionBusyWithCli).mockReturnValue(true);
		vi.mocked(getCliActivityForSession).mockReturnValue({
			sessionId: 'agent-1',
			playbookId: 'pb-other',
			playbookName: 'Other',
			startedAt: 0,
			pid: 99,
		});

		await expect(runDoc(['plan.md'], { agent: 'agent-1' })).rejects.toThrow('process.exit(1)');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('is busy'));
	});

	it('errors when documents resolve to different folders', async () => {
		// Two absolute docs in different directories, neither inside the Auto Run folder
		await expect(runDoc(['/a/one.md', '/b/two.md'], { agent: 'agent-1' })).rejects.toThrow(
			'process.exit(1)'
		);
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('must be in the same folder'));
	});
});
