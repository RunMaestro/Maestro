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
import { runLocalTask } from '../../../../main/local-models/task-router';
import { getConfiguredLocalModelEndpoints } from '../../../../main/local-models/endpoint-service';
import { captureException } from '../../../../main/utils/sentry';
import { QWEN3_1_7B_ID, getLocalModel } from '../../../../shared/local-models/model-catalog';
import { AI_COMMAND_LOCAL_HISTORY_LIMIT } from '../../../../shared/aiCommand';
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
		(id: string) =>
			`${id === 'ai-command-local' ? 'LOCAL' : 'PROMPT'} {{OS}} {{SHELL}} {{CWD}} {{IS_GIT_REPO}} {{REMOTE_LINE}} {{RECENT_COMMANDS}} {{USER_REQUEST}}`
	),
}));

// The Local Models router answers `use-utility-agent` (the default assignment)
// unless a test says otherwise, so every agent-path test runs unchanged.
vi.mock('../../../../main/local-models/task-router', () => ({
	runLocalTask: vi.fn(),
}));

vi.mock('../../../../main/local-models/endpoint-service', () => ({
	getConfiguredLocalModelEndpoints: vi.fn(() => []),
}));

vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../../../main/utils/context-groomer', () => ({
	groomContext: vi.fn(),
}));

const mockGroomContext = groomContext as unknown as Mock;
const mockRunLocalTask = runLocalTask as unknown as Mock;

const LOCAL_SOURCE = { type: 'local', modelId: QWEN3_1_7B_ID } as const;
const ENDPOINT_SOURCE = { type: 'endpoint', endpointId: 'ep-1', model: 'qwen3:latest' } as const;

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
		mockRunLocalTask.mockResolvedValue({ status: 'use-utility-agent' });
		(getConfiguredLocalModelEndpoints as Mock).mockReturnValue([]);
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

	it('uses the configured utility provider without leaking the tab provider configuration', async () => {
		settingsValues.utilityAgentId = 'codex';
		settingsValues.utilityModelId = 'gpt-model';
		await invokeSuggest({
			customPath: '/bin/claude',
			customArgs: '--claude-flag',
			customEnvVars: { CLAUDE_TOKEN: 'session-only' },
			customModel: 'opus',
			customEffort: 'high',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
		});
		expect(getAgent).toHaveBeenCalledWith('codex');
		expect(mockGroomContext).toHaveBeenCalledWith(
			expect.objectContaining({
				agentType: 'codex',
				sessionCustomModel: 'gpt-model',
				sessionCustomEffort: undefined,
				sessionCustomPath: undefined,
				sessionCustomArgs: undefined,
				sessionCustomEnvVars: undefined,
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
				acceptWorkspaceTrust: true,
			}),
			expect.anything(),
			expect.anything()
		);
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

	it('hands the model turn the remote list, so an SSH agent gets a suggestion at all', async () => {
		// groomContext refuses an SSH agent that arrives without a store to look
		// its remote up in. Without this, every suggestion for an agent on a
		// remote failed before anything ran.
		const remote = { id: 'r1', name: 'build-box', host: 'build.example.com', enabled: true };
		settingsValues.sshRemotes = [remote];

		await invokeSuggest({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			sshRemoteName: 'build-box',
		});

		const [options] = mockGroomContext.mock.calls[0];
		expect(options.sessionSshRemoteConfig).toEqual({ enabled: true, remoteId: 'r1' });
		expect(options.sshStore.getSshRemotes()).toEqual([remote]);
	});

	// The suggestion runs in the agent's own directory, and can be the first TUI
	// spawn there (#1872).
	it("accepts claude's folder trust for the agent's own directory", async () => {
		await invokeSuggest({});

		expect(mockGroomContext.mock.calls[0][0].acceptWorkspaceTrust).toBe(true);
	});

	it('passes no remote list for a local agent', async () => {
		await invokeSuggest();

		expect(mockGroomContext.mock.calls[0][0].sshStore).toBeUndefined();
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

	describe('Local Models assignment (ai-command)', () => {
		function okVerdict(extra: Record<string, unknown>) {
			return { status: 'ok', text: '', source: LOCAL_SOURCE, durationMs: 12, ...extra };
		}

		it('asks the router before the provider, and leaves the agent path alone for the default', async () => {
			const result = await invokeSuggest({});

			expect(mockRunLocalTask).toHaveBeenCalledTimes(1);
			expect(mockRunLocalTask.mock.calls[0][0]).toBe('ai-command');
			// `use-utility-agent`: the tab's own provider answers, exactly as before.
			expect(mockGroomContext).toHaveBeenCalledTimes(1);
			expect(mockGroomContext.mock.calls[0][0].prompt).toMatch(/^PROMPT /);
			expect(result).toEqual({ success: true, command: 'du -sh *' });
		});

		it('hands the router the short local prompt, a JSON schema, a token cap, and a timeout', async () => {
			mockRunLocalTask.mockResolvedValue(okVerdict({ json: { command: 'ls', explanation: '' } }));

			await invokeSuggest({ request: 'list the files' });

			const input = mockRunLocalTask.mock.calls[0][1];
			expect(input.prompt).toMatch(/^LOCAL /);
			expect(input.prompt).toContain('/repo');
			expect(input.prompt).toContain('list the files');
			expect(input.jsonSchema).toMatchObject({ required: ['command', 'explanation'] });
			expect(input.maxTokens).toBeLessThanOrEqual(512);
			expect(input.signal).toBeInstanceOf(AbortSignal);
		});

		it('shows a local model only the newest commands', async () => {
			mockRunLocalTask.mockResolvedValue(okVerdict({ json: { command: 'ls', explanation: '' } }));
			const recentCommands = Array.from({ length: 8 }, (_, i) => ({ command: `cmd-${i}` }));

			await invokeSuggest({ recentCommands });

			const prompt: string = mockRunLocalTask.mock.calls[0][1].prompt;
			const shown = recentCommands.filter(({ command }) => prompt.includes(command));
			expect(shown).toEqual(recentCommands.slice(-AI_COMMAND_LOCAL_HISTORY_LIMIT));
		});

		it('returns the command, its explanation, and the local model that wrote it', async () => {
			mockRunLocalTask.mockResolvedValue(
				okVerdict({
					json: {
						command: '```bash\n$ du -sh * | sort -rh\n```',
						explanation: 'Lists everything here by size.',
					},
				})
			);

			const result = await invokeSuggest({});

			expect(result).toEqual({
				success: true,
				// The same cleanup an agent's reply gets.
				command: 'du -sh * | sort -rh',
				explanation: 'Lists everything here by size.',
				producedBy: getLocalModel(QWEN3_1_7B_ID)!.displayName,
			});
			expect(mockGroomContext).not.toHaveBeenCalled();
		});

		it('names an endpoint source as model on endpoint', async () => {
			(getConfiguredLocalModelEndpoints as Mock).mockReturnValue([{ id: 'ep-1', name: 'Ollama' }]);
			mockRunLocalTask.mockResolvedValue(
				okVerdict({ source: ENDPOINT_SOURCE, json: { command: 'ls', explanation: 'Lists files.' } })
			);

			const result = await invokeSuggest({});

			expect(result.producedBy).toBe('qwen3:latest on Ollama');
		});

		it('does not need the tab provider to be installed', async () => {
			getAgent.mockResolvedValue({ id: 'codex', available: false });
			mockRunLocalTask.mockResolvedValue(okVerdict({ json: { command: 'ls', explanation: '' } }));

			const result = await invokeSuggest({ agentType: 'codex' });

			expect(result.success).toBe(true);
			expect(getAgent).not.toHaveBeenCalled();
		});

		it('accepts a bare line from an endpoint that ignored the schema', async () => {
			mockRunLocalTask.mockResolvedValue(okVerdict({ text: 'git status' }));

			const result = await invokeSuggest({});

			expect(result).toMatchObject({ success: true, command: 'git status' });
			expect(result.explanation).toBeUndefined();
		});

		it('fails rather than proposing a reply with no command in it', async () => {
			mockRunLocalTask.mockResolvedValue(okVerdict({ text: '{"command": "du -sh' }));

			const result = await invokeSuggest({});

			expect(result.success).toBe(false);
			expect(result.command).toBeUndefined();
			expect(mockGroomContext).not.toHaveBeenCalled();
		});

		it('refuses when the task is off, and says where the switch is', async () => {
			mockRunLocalTask.mockResolvedValue({ status: 'off' });

			const result = await invokeSuggest({});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/switched off/);
			expect(result.error).toMatch(/Settings > Models > System Two/);
			// Off is the user choosing no model: the tab's provider is not used instead.
			expect(mockGroomContext).not.toHaveBeenCalled();
		});

		it('reports an unavailable source with its reason and never falls back to the agent', async () => {
			mockRunLocalTask.mockResolvedValue({
				status: 'unavailable',
				source: LOCAL_SOURCE,
				reason: 'Qwen3 is not downloaded. Download it in Settings.',
				code: 'model-not-installed',
			});

			const result = await invokeSuggest({});

			expect(result).toEqual({
				success: false,
				error: 'Qwen3 is not downloaded. Download it in Settings.',
			});
			expect(mockGroomContext).not.toHaveBeenCalled();
		});

		it('reports a timeout on the assigned model as a failure', async () => {
			mockRunLocalTask.mockResolvedValue({ status: 'cancelled', source: LOCAL_SOURCE });

			const result = await invokeSuggest({});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/too long/);
			expect(mockGroomContext).not.toHaveBeenCalled();
		});

		it('reports an unexpected engine failure and still answers the composer', async () => {
			const boom = new Error('llama exploded');
			mockRunLocalTask.mockRejectedValue(boom);

			const result = await invokeSuggest({});

			expect(result).toEqual({ success: false, error: 'llama exploded' });
			expect(captureException).toHaveBeenCalledWith(boom);
			expect(mockGroomContext).not.toHaveBeenCalled();
		});
	});
});
