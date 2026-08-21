/**
 * Tests for the AI Command Mode IPC handler (`aiCommand:suggest`).
 *
 * The handler is only the model round trip: it builds a prompt, runs it through
 * the shared grooming runner, and extracts one command line from the reply. It
 * must never execute anything, and it must describe the machine the command
 * will actually land on - which is the remote's, not ours, when the agent runs
 * over SSH.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';
import {
	registerAiCommandHandlers,
	type AiCommandSuggestRequest,
	type AiCommandSuggestResult,
} from '../../../../main/ipc/handlers/aiCommand';
import { groomContext } from '../../../../main/utils/context-groomer';
import type { ProcessManager } from '../../../../main/process-manager';
import type { AgentDetector } from '../../../../main/agents';

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
}));

vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn(
		() => 'PROMPT {{OS}} {{SHELL}} {{CWD}} {{IS_GIT_REPO}} {{REMOTE_LINE}} {{USER_REQUEST}}'
	),
}));

vi.mock('../../../../main/utils/context-groomer', () => ({
	groomContext: vi.fn(),
}));

const mockGroomContext = groomContext as unknown as Mock;

/** Invoke the registered `aiCommand:suggest` handler the way ipcMain would. */
function invokeSuggest(config: Partial<AiCommandSuggestRequest>): Promise<AiCommandSuggestResult> {
	const registered = (ipcMain.handle as Mock).mock.calls.find(
		([channel]) => channel === 'aiCommand:suggest'
	);
	expect(registered).toBeDefined();
	const handler = registered![1] as (
		event: unknown,
		config: AiCommandSuggestRequest
	) => Promise<AiCommandSuggestResult>;
	return handler({}, {
		request: 'find the biggest files here',
		agentType: 'claude-code',
		cwd: '/repo',
		...config,
	} as AiCommandSuggestRequest);
}

describe('aiCommand IPC handler', () => {
	let getAgent: Mock;
	let settingsValues: Record<string, unknown>;

	beforeEach(() => {
		vi.clearAllMocks();
		settingsValues = {};
		mockGroomContext.mockResolvedValue({ response: 'du -sh *' });
		getAgent = vi.fn().mockResolvedValue({ id: 'claude-code', available: true });

		registerAiCommandHandlers({
			getProcessManager: () => ({}) as unknown as ProcessManager,
			getAgentDetector: () => ({ getAgent }) as unknown as AgentDetector,
			agentConfigsStore: {
				get: vi.fn(() => ({ 'claude-code': { customModel: 'ignored' } })),
			} as never,
			settingsStore: {
				get: vi.fn((key: string, fallback: unknown) => settingsValues[key] ?? fallback),
			} as never,
		});
	});

	it('registers the suggest channel', () => {
		expect(ipcMain.handle).toHaveBeenCalledWith('aiCommand:suggest', expect.any(Function));
	});

	it('returns the extracted command line for a successful suggestion', async () => {
		mockGroomContext.mockResolvedValue({ response: '```bash\ndu -sh * | sort -h\n```' });

		const result = await invokeSuggest({});

		expect(result).toEqual({ success: true, command: 'du -sh * | sort -h' });
	});

	it('runs the suggestion read-only with tools disabled, so the model names work instead of doing it', async () => {
		await invokeSuggest({ customModel: 'opus', customEffort: 'high' });

		expect(mockGroomContext).toHaveBeenCalledTimes(1);
		const [options] = mockGroomContext.mock.calls[0];
		expect(options.readOnlyMode).toBe(true);
		expect(options.disableTools).toBe(true);
		// The tab's own provider and settings, not a hard-coded agent.
		expect(options.agentType).toBe('claude-code');
		expect(options.sessionCustomModel).toBe('opus');
		expect(options.sessionCustomEffort).toBe('high');
		expect(options.projectRoot).toBe('/repo');
	});

	it('names the configured shell so the prompt and the eventual run agree', async () => {
		settingsValues.defaultShell = '/bin/zsh';

		await invokeSuggest({});

		expect(mockGroomContext.mock.calls[0][0].prompt).toContain('/bin/zsh');
	});

	it('prefers an explicit custom shell path over the selected shell', async () => {
		settingsValues.defaultShell = '/bin/zsh';
		settingsValues.customShellPath = '/opt/homebrew/bin/fish';

		await invokeSuggest({});

		const prompt = mockGroomContext.mock.calls[0][0].prompt;
		expect(prompt).toContain('/opt/homebrew/bin/fish');
		expect(prompt).not.toContain('/bin/zsh');
	});

	it('describes the remote rather than this machine when the agent runs over SSH', async () => {
		settingsValues.defaultShell = '/bin/zsh';

		await invokeSuggest({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			sshRemoteName: 'build-box',
		});

		const prompt = mockGroomContext.mock.calls[0][0].prompt;
		// The local shell is not the one the command will run in.
		expect(prompt).not.toContain('/bin/zsh');
		expect(prompt).toContain('build-box');
	});

	it('rejects an empty request without calling the model', async () => {
		const result = await invokeSuggest({ request: '   ' });

		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
		expect(mockGroomContext).not.toHaveBeenCalled();
	});

	it('reports an unavailable provider instead of spawning it', async () => {
		getAgent.mockResolvedValue({ id: 'codex', available: false });

		const result = await invokeSuggest({ agentType: 'codex' });

		expect(result.success).toBe(false);
		expect(result.error).toContain('codex');
		expect(mockGroomContext).not.toHaveBeenCalled();
	});

	it('surfaces a model failure as an error result rather than throwing at the renderer', async () => {
		mockGroomContext.mockRejectedValue(new Error('agent timed out'));

		const result = await invokeSuggest({});

		expect(result).toEqual({ success: false, error: 'agent timed out' });
	});

	it('fails rather than proposing an empty run when nothing usable comes back', async () => {
		mockGroomContext.mockResolvedValue({ response: '   \n\n  ' });

		const result = await invokeSuggest({});

		expect(result.success).toBe(false);
		expect(result.command).toBeUndefined();
	});
});
