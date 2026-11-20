/**
 * Tests for the side question IPC handler (`sideQuestion:ask`, `/btw`).
 *
 * The handler must answer from a throwaway fork of the tab's session (never a
 * plain resume, which would write the question into the tab's conversation),
 * with tools off, and refuse agents that cannot fork rather than resume them.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';
import {
	registerSideQuestionHandlers,
	type SideQuestionRequest,
	type SideQuestionResult,
} from '../../../../main/ipc/handlers/sideQuestion';
import { groomContext } from '../../../../main/utils/context-groomer';
import type { ProcessManager } from '../../../../main/process-manager';
import type { AgentDetector } from '../../../../main/agents';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
}));

vi.mock('../../../../main/utils/context-groomer', () => ({
	groomContext: vi.fn(),
}));

const mockGroomContext = groomContext as unknown as Mock;

function invokeAsk(config: Partial<SideQuestionRequest>): Promise<SideQuestionResult> {
	const registered = (ipcMain.handle as Mock).mock.calls.find(
		([channel]) => channel === 'sideQuestion:ask'
	);
	expect(registered).toBeDefined();
	const handler = registered![1] as (
		event: unknown,
		config: SideQuestionRequest
	) => Promise<SideQuestionResult>;
	return handler({}, {
		question: 'what was the second file we changed?',
		agentType: 'claude-code',
		cwd: '/repo',
		agentSessionId: 'sess-1',
		...config,
	} as SideQuestionRequest);
}

describe('sideQuestion IPC handler', () => {
	let getAgent: Mock;
	let settingsGet: Mock;

	beforeEach(() => {
		vi.clearAllMocks();
		mockGroomContext.mockResolvedValue({ response: '  src/foo.ts  ' });
		getAgent = vi.fn().mockResolvedValue({
			id: 'claude-code',
			name: 'Claude Code',
			available: true,
			ephemeralForkArgs: ['--fork-session', '--no-session-persistence'],
		});

		settingsGet = vi.fn((_key: string, fallback: unknown) => fallback);
		registerSideQuestionHandlers({
			getProcessManager: () => ({}) as unknown as ProcessManager,
			getAgentDetector: () => ({ getAgent }) as unknown as AgentDetector,
			agentConfigsStore: { get: vi.fn(() => ({})) } as never,
			settingsStore: { get: settingsGet } as never,
		});
	});

	it('answers from a tool-less, read-only fork of the tab session', async () => {
		const result = await invokeAsk({ customModel: 'opus', customEffort: 'high' });

		expect(result).toEqual({ success: true, answer: 'src/foo.ts' });
		const [options] = mockGroomContext.mock.calls[0];
		expect(options.agentSessionId).toBe('sess-1');
		expect(options.ephemeralFork).toBe(true);
		expect(options.disableTools).toBe(true);
		expect(options.readOnlyMode).toBe(true);
		expect(options.sessionCustomModel).toBe('opus');
		expect(options.sessionCustomEffort).toBe('high');
		expect(options.prompt).toContain('what was the second file we changed?');
		// The TUI path cannot follow a fork; side questions always run --print.
		expect(options.claudeTokenSource).toBeUndefined();
	});

	it('refuses an agent that cannot fork instead of resuming its real session', async () => {
		getAgent.mockResolvedValue({ id: 'codex', name: 'Codex', available: true });

		const result = await invokeAsk({ agentType: 'codex' });

		expect(result.success).toBe(false);
		expect(result.error).toContain('cannot fork');
		expect(mockGroomContext).not.toHaveBeenCalled();
	});

	it('refuses an empty question', async () => {
		const result = await invokeAsk({ question: '   ' });

		expect(result.success).toBe(false);
		expect(mockGroomContext).not.toHaveBeenCalled();
	});

	it('passes the SSH store through so a remote agent is never asked locally', async () => {
		await invokeAsk({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } });

		const [options] = mockGroomContext.mock.calls[0];
		expect(options.sessionSshRemoteConfig).toEqual({ enabled: true, remoteId: 'r1' });
		expect(options.sshStore).toBeDefined();
	});

	it('allows an agent installed only on the SSH remote', async () => {
		getAgent.mockResolvedValue({
			id: 'claude-code',
			name: 'Claude Code',
			available: false,
			ephemeralForkArgs: ['--fork-session', '--no-session-persistence'],
		});

		const local = await invokeAsk({});
		expect(local.success).toBe(false);
		expect(mockGroomContext).not.toHaveBeenCalled();

		const remote = await invokeAsk({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } });
		expect(remote.success).toBe(true);
		expect(mockGroomContext).toHaveBeenCalledTimes(1);
	});

	it('forwards the global Shell Configuration vars', async () => {
		settingsGet.mockImplementation((key: string, fallback: unknown) =>
			key === 'shellEnvVars' ? { HTTPS_PROXY: 'http://proxy:8080' } : fallback
		);

		await invokeAsk({});

		const [options] = mockGroomContext.mock.calls[0];
		expect(options.globalShellEnvVars).toEqual({ HTTPS_PROXY: 'http://proxy:8080' });
	});

	it('reports a failed turn instead of throwing', async () => {
		mockGroomContext.mockRejectedValue(new Error('rate limited'));

		const result = await invokeAsk({});

		expect(result).toEqual({ success: false, error: 'rate limited' });
	});
});
