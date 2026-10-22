/**
 * @file send.test.ts
 * @description Tests for the send CLI command
 *
 * Tests the send command functionality including:
 * - Sending a message to create a new agent session
 * - Resuming an existing agent session
 * - JSON response format with usage stats and context usage
 * - Error handling for missing agents and CLIs
 * - Unsupported agent types
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { SessionInfo } from '../../../shared/types';

const desktop = vi.hoisted(() => ({
	connect: vi.fn(),
	sendCommand: vi.fn(),
	disconnect: vi.fn(),
}));

// Most cases exercise standalone CLI spawning. Individual cases enable the
// desktop connection to cover host-backed send and older desktop fallback.
vi.mock('../../../cli/services/maestro-client', () => ({
	MaestroClient: class {
		connect = desktop.connect;
		sendCommand = desktop.sendCommand;
		disconnect = desktop.disconnect;
	},
	UnsupportedCommandError: class UnsupportedCommandError extends Error {},
	withMaestroClient: vi.fn(),
}));

// Mock agent-spawner
vi.mock('../../../cli/services/agent-spawner', () => ({
	spawnAgent: vi.fn(),
	detectAgent: vi.fn(),
}));

vi.mock('../../../cli/services/agent-run-capture', () => ({
	captureCliRun: vi.fn(async (_input: unknown, run: () => Promise<unknown>) => run()),
	settlementFromAgentResult: vi.fn(),
}));

// Mock system-prompt so we can assert it gets called (or skipped on --no-system-prompt)
vi.mock('../../../cli/services/system-prompt', () => ({
	prepareMaestroSystemPromptCli: vi.fn(),
}));

vi.mock('../../../cli/services/auto-turn', () => ({
	resolveCliAutoTurn: vi.fn(),
}));

// The consult budget is a real file in the Maestro data directory, and
// MAESTRO_USER_DATA in an agent's shell points that at the LIVE one. The guard
// runs against a temp directory in services/consult-budget-guard.test.ts; here
// it only answers.
vi.mock('../../../cli/services/consult-budget-guard', () => ({
	admitCliConsult: vi.fn(),
}));

// Mock storage
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
	getSessionById: vi.fn(),
	addHistoryEntry: vi.fn(),
	readHarnessTierDefaults: vi.fn(() => ({})),
}));

// Mock prompt-loader so the synopsis turn gets a fixed prompt
vi.mock('../../../cli/services/prompt-loader', () => ({
	getCliPrompt: vi.fn().mockResolvedValue('SYNOPSIS PROMPT'),
}));

// Mock usage-aggregator
vi.mock('../../../shared/maestro-lib/parsers/usage-aggregator', () => ({
	estimateContextUsage: vi.fn(),
}));

// Mock agent definitions
vi.mock('../../../shared/maestro-lib/providers/definitions', () => ({
	getAgentDefinition: vi.fn((agentId: string) => {
		const defs: Record<string, { name: string; binaryName: string }> = {
			'claude-code': { name: 'Claude Code', binaryName: 'claude' },
			codex: { name: 'Codex', binaryName: 'codex' },
			opencode: { name: 'OpenCode', binaryName: 'opencode' },
			'factory-droid': { name: 'Factory Droid', binaryName: 'droid' },
		};
		return defs[agentId] || undefined;
	}),
}));

import { send } from '../../../cli/commands/send';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { UnsupportedCommandError } from '../../../cli/services/maestro-client';
import { spawnAgent, detectAgent } from '../../../cli/services/agent-spawner';
import {
	resolveAgentId,
	getSessionById,
	addHistoryEntry,
	readHarnessTierDefaults,
} from '../../../cli/services/storage';
import { autoTurnReport } from '../../../shared/autoTurn';
import { estimateContextUsage } from '../../../shared/maestro-lib/parsers/usage-aggregator';
import { prepareMaestroSystemPromptCli } from '../../../cli/services/system-prompt';
import { resolveCliAutoTurn } from '../../../cli/services/auto-turn';
import { admitCliConsult } from '../../../cli/services/consult-budget-guard';
import { CONSULT_BUDGET_EXHAUSTED_CODE } from '../../../shared/consultBudget';
import { CALLER_AGENT_ID_ENV_VAR } from '../../../shared/agentDelegation';
import { QUERY_SOURCE_ENV_VAR } from '../../../shared/querySource';

/** The place in a consult chain every admitted send below hands its target. */
const TARGET_CHAIN = { chainId: 'chain-test', depth: 1 };

describe('send command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	const mockAgent = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
		id: 'agent-abc-123',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/path/to/project',
		projectRoot: '/path/to/project',
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		desktop.connect.mockRejectedValue(new Error('desktop unavailable'));
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		// Default: system-prompt builder returns undefined so existing assertions
		// that don't include `appendSystemPrompt` keep passing (vitest treats
		// undefined-valued object keys as absent in `toHaveBeenCalledWith`).
		vi.mocked(prepareMaestroSystemPromptCli).mockResolvedValue(undefined);
		vi.mocked(admitCliConsult).mockReturnValue({ allowed: true, chain: TARGET_CHAIN });
		// A test run started from an agent's own shell inherits its caller
		// identity and its turn's origin, which would turn every entry here into
		// an AGENT or CUE entry. Blank reads as absent.
		vi.stubEnv(CALLER_AGENT_ID_ENV_VAR, '');
		vi.stubEnv(QUERY_SOURCE_ENV_VAR, '');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each([
		{ live: false },
		{ live: true },
		{ live: false, nativeId: 'native-codex' },
		{ live: true, nativeId: 'native-codex' },
	])(
		'keeps a no-tab send on the agent default with $live and native $nativeId',
		async ({ live, nativeId }) => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			const agent = {
				...mockAgent(),
				activeTabId: 'foreign',
				aiTabs: [{ id: 'foreign', tabProvider: 'codex', agentSessionId: 'native-codex' }],
			};
			vi.mocked(getSessionById).mockReturnValue(agent);
			vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
			vi.mocked(spawnAgent).mockResolvedValue({ success: true, response: 'standalone' });
			if (live) {
				desktop.connect.mockResolvedValue(undefined);
				desktop.sendCommand.mockResolvedValue({
					available: true,
					success: true,
					response: 'desktop',
				});
			}
			await send('agent-abc', 'hello', { history: false, session: nativeId });
			expect(detectAgent).toHaveBeenCalledWith('claude-code');
			if (live) {
				expect(desktop.sendCommand.mock.calls[0][0]).toMatchObject({
					type: 'plugins_send_agent',
					agentId: 'agent-abc-123',
				});
				expect(desktop.sendCommand.mock.calls[0][0]).not.toHaveProperty('tabId');
				expect(spawnAgent).not.toHaveBeenCalled();
			} else {
				expect(spawnAgent).toHaveBeenCalledWith(
					'claude-code',
					agent.cwd,
					'hello',
					nativeId,
					expect.any(Object)
				);
			}
		}
	);

	it('falls back to standalone spawning when an older desktop rejects the host verb', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		desktop.connect.mockResolvedValue(undefined);
		desktop.sendCommand.mockRejectedValue(new UnsupportedCommandError('plugins_send_agent'));
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'standalone answer',
			agentSessionId: 'provider-1',
		});

		await send('agent-abc', 'hello', { synopsis: false });

		expect(spawnAgent).toHaveBeenCalledOnce();
		expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
			success: true,
			response: 'standalone answer',
		});
		expect(addHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'USER', fullResponse: 'standalone answer', success: true })
		);
	});

	it.each(['opencode', 'factory-droid'] as const)(
		'refuses required plugin tools for the unverified %s provider before dispatch',
		async (toolType) => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			vi.mocked(getSessionById).mockReturnValue(mockAgent({ toolType }));
			vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/agent' });
			desktop.connect.mockResolvedValue(undefined);
			await send('agent-abc', 'report', { requirePluginTools: true });
			expect(desktop.connect).not.toHaveBeenCalled();
			expect(desktop.sendCommand).not.toHaveBeenCalled();
			expect(spawnAgent).not.toHaveBeenCalled();
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				success: false,
				code: 'PLUGIN_TOOLS_UNAVAILABLE',
			});
			expect(processExitSpy).toHaveBeenCalledWith(1);
		}
	);

	it.each(['ssh', 'interactive', 'dynamic'] as const)(
		'refuses required plugin tools for an unsupported %s mode before dispatch',
		async (mode) => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			vi.mocked(getSessionById).mockReturnValue(
				mockAgent(
					mode === 'ssh'
						? { toolType: 'codex', sessionSshRemoteConfig: { enabled: true, remoteId: 'host' } }
						: { enableMaestroP: true, maestroPMode: mode }
				)
			);
			vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/agent' });
			desktop.connect.mockResolvedValue(undefined);
			await send('agent-abc', 'report', { requirePluginTools: true });
			expect(desktop.sendCommand).not.toHaveBeenCalled();
			expect(spawnAgent).not.toHaveBeenCalled();
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				success: false,
				code: 'PLUGIN_TOOLS_UNAVAILABLE',
			});
			expect(processExitSpy).toHaveBeenCalledWith(1);
		}
	);

	it('requires the authenticated desktop plugin path when requested', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent({ toolType: 'codex' }));
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/codex' });
		await send('agent-abc', 'report', { requirePluginTools: true });
		expect(spawnAgent).not.toHaveBeenCalled();
		expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
			success: false,
			code: 'PLUGIN_TOOLS_UNAVAILABLE',
		});
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('does not fall back when the desktop has no active plugin tools', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent({ toolType: 'codex' }));
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/codex' });
		desktop.connect.mockResolvedValue(undefined);
		desktop.sendCommand.mockResolvedValue({
			available: false,
			error: 'Plugin headless runner unavailable',
		});
		await send('agent-abc', 'report', { requirePluginTools: true });
		expect(spawnAgent).not.toHaveBeenCalled();
		expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
			success: false,
			error: 'Plugin headless runner unavailable',
		});
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('does not fall back to an older desktop without the authenticated host verb', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent({ toolType: 'codex' }));
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/codex' });
		desktop.connect.mockResolvedValue(undefined);
		desktop.sendCommand.mockRejectedValue(new UnsupportedCommandError('plugins_send_agent'));
		await send('agent-abc', 'report', { requirePluginTools: true });
		expect(spawnAgent).not.toHaveBeenCalled();
		expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
			success: false,
		});
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('uses the host result for a required plugin-tool run', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent({ toolType: 'codex' }));
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/codex' });
		desktop.connect.mockResolvedValue(undefined);
		desktop.sendCommand.mockResolvedValue({
			available: true,
			success: true,
			response: '{"messageIds":["123"]}',
			sessionId: 'provider-1',
		});
		await send('agent-abc', 'report', { requirePluginTools: true, synopsis: false });
		expect(spawnAgent).not.toHaveBeenCalled();
		expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
			success: true,
			response: '{"messageIds":["123"]}',
			sessionId: 'provider-1',
		});
	});

	it('records a desktop-backed send with the canonical synopsis without repeating the main prompt', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent({ toolType: 'codex' }));
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/codex' });
		desktop.connect.mockResolvedValue(undefined);
		desktop.sendCommand.mockResolvedValue({
			available: true,
			success: true,
			response: 'Completed report',
			sessionId: 'provider-1',
		});
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: '**Summary:** Reported it.',
		});
		await send('agent-abc', 'report', { requirePluginTools: true });
		expect(desktop.sendCommand).toHaveBeenCalledOnce();
		expect(spawnAgent).toHaveBeenCalledExactlyOnceWith(
			'codex',
			'/path/to/project',
			'SYNOPSIS PROMPT',
			'provider-1',
			expect.objectContaining({
				querySource: 'auto',
				customModel: 'gpt-6-luna',
				customEffort: 'low',
			})
		);
		expect(addHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'USER', summary: 'Reported it.', success: true })
		);
	});

	it('accepts only a host-observed receipt for the requested tool and agent', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent({ toolType: 'codex' }));
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/codex' });
		desktop.connect.mockResolvedValue(undefined);
		desktop.sendCommand.mockResolvedValue({
			available: true,
			success: true,
			response: 'done',
			toolReceipts: [
				{
					runId: 'a'.repeat(32),
					agentId: 'agent-abc-123',
					toolId: 'sh.maestro.relay/send',
					messageIds: ['123'],
				},
			],
		});
		await send('agent-abc', 'report', { requireToolReceipt: 'sh.maestro.relay/send' });
		expect(desktop.sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				requiredToolId: 'sh.maestro.relay/send',
				requirePluginTools: true,
			}),
			'plugins_send_agent_result',
			61 * 60_000
		);
		expect(spawnAgent).not.toHaveBeenCalled();
		expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
			success: true,
			toolReceipts: [{ agentId: 'agent-abc-123', messageIds: ['123'] }],
		});
	});

	it('rejects model-written IDs and receipts from another agent or tool', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent({ toolType: 'codex' }));
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/codex' });
		desktop.connect.mockResolvedValue(undefined);
		for (const toolReceipts of [
			[],
			[
				{
					runId: 'a'.repeat(32),
					agentId: 'agent-other',
					toolId: 'sh.maestro.relay/send',
					messageIds: ['123'],
				},
			],
			[
				{
					runId: 'a'.repeat(32),
					agentId: 'agent-abc-123',
					toolId: 'other/send',
					messageIds: ['123'],
				},
			],
			[
				{
					runId: 'a'.repeat(32),
					agentId: 'agent-abc-123',
					toolId: 'sh.maestro.relay/send',
					messageIds: [],
				},
			],
		]) {
			consoleSpy.mockClear();
			desktop.sendCommand.mockResolvedValueOnce({
				available: true,
				success: true,
				response: '{"messageIds":["invented"]}',
				toolReceipts,
			});
			await send('agent-abc', 'report', { requireToolReceipt: 'sh.maestro.relay/send' });
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				success: false,
				response: null,
				error: 'Required plugin tool returned no delivery receipt',
			});
		}
		expect(spawnAgent).not.toHaveBeenCalled();
	});

	it('keeps a failed provider run failed even if a tool receipt was observed', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent({ toolType: 'codex' }));
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/codex' });
		desktop.connect.mockResolvedValue(undefined);
		desktop.sendCommand.mockResolvedValue({
			available: true,
			success: false,
			error: 'provider failed after the tool call',
			toolReceipts: [
				{
					runId: 'a'.repeat(32),
					agentId: 'agent-abc-123',
					toolId: 'sh.maestro.relay/send',
					messageIds: ['123'],
				},
			],
		});
		await send('agent-abc', 'report', { requireToolReceipt: 'sh.maestro.relay/send' });
		expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
			success: false,
			response: null,
			error: 'provider failed after the tool call',
			toolReceipts: [{ messageIds: ['123'] }],
		});
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('reports an ambiguous desktop disconnect without starting a duplicate run', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		desktop.connect.mockResolvedValue(undefined);
		desktop.sendCommand.mockRejectedValue(new Error('Connection closed'));

		await send('agent-abc', 'hello', {});

		expect(spawnAgent).not.toHaveBeenCalled();
		expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
			success: false,
			error: 'Connection closed',
		});
	});

	it('should query an agent and return JSON response for new session', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Hello from Claude!',
			agentSessionId: 'session-xyz-789',
			usageStats: {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 200,
				cacheCreationInputTokens: 100,
				totalCostUsd: 0.05,
				contextWindow: 200000,
			},
		});
		vi.mocked(estimateContextUsage).mockReturnValue(1);

		await send('agent-abc', 'Hello world', {});

		expect(resolveAgentId).toHaveBeenCalledWith('agent-abc');
		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/path/to/project',
			'Hello world',
			undefined,
			{ readOnlyMode: undefined, signal: expect.any(AbortSignal), consultChain: TARGET_CHAIN }
		);

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toEqual({
			agentId: 'agent-abc-123',
			agentName: 'Test Agent',
			sessionId: 'session-xyz-789',
			response: 'Hello from Claude!',
			success: true,
			usage: {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 200,
				cacheCreationInputTokens: 100,
				totalCostUsd: 0.05,
				contextWindow: 200000,
				contextUsagePercent: 1,
			},
		});
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('should resume an existing session when --session is provided', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Follow-up response',
			agentSessionId: 'session-xyz-789',
			usageStats: {
				inputTokens: 5000,
				outputTokens: 1000,
				cacheReadInputTokens: 3000,
				cacheCreationInputTokens: 500,
				totalCostUsd: 0.12,
				contextWindow: 200000,
			},
		});
		vi.mocked(estimateContextUsage).mockReturnValue(4);

		await send('agent-abc', 'Continue from before', { session: 'session-xyz-789' });

		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/path/to/project',
			'Continue from before',
			'session-xyz-789',
			{ readOnlyMode: undefined, signal: expect.any(AbortSignal), consultChain: TARGET_CHAIN }
		);

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(output.sessionId).toBe('session-xyz-789');
		expect(output.usage.contextUsagePercent).toBe(4);
	});

	describe('New Session Message', () => {
		const withMessage = () => mockAgent({ newSessionMessage: 'Always check linting' });

		beforeEach(() => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
			vi.mocked(spawnAgent).mockResolvedValue({
				success: true,
				response: 'ok',
				agentSessionId: 'session-xyz-789',
			});
		});

		it('prefixes the message when the send opens a new session', async () => {
			vi.mocked(getSessionById).mockReturnValue(withMessage());

			await send('agent-abc', 'Run the report', {});

			expect(spawnAgent).toHaveBeenCalledWith(
				'claude-code',
				'/path/to/project',
				'Always check linting\n\n---\n\nRun the report',
				undefined,
				expect.anything()
			);
		});

		it('leaves the message alone when --session resumes a conversation', async () => {
			vi.mocked(getSessionById).mockReturnValue(withMessage());

			await send('agent-abc', 'Run the report', { session: 'session-xyz-789' });

			expect(spawnAgent).toHaveBeenCalledWith(
				'claude-code',
				'/path/to/project',
				'Run the report',
				'session-xyz-789',
				expect.anything()
			);
		});
	});

	it('should use the agent cwd from Maestro session', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent({ cwd: '/custom/project/path' }));
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Done',
			agentSessionId: 'session-new',
		});

		await send('agent-abc', 'Do something', {});

		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/custom/project/path',
			'Do something',
			undefined,
			{ readOnlyMode: undefined, signal: expect.any(AbortSignal), consultChain: TARGET_CHAIN }
		);
	});

	it('should work with codex agent type', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-codex-1');
		vi.mocked(getSessionById).mockReturnValue(
			mockAgent({ id: 'agent-codex-1', toolType: 'codex' })
		);
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/codex' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Codex response',
			agentSessionId: 'codex-session',
		});

		await send('agent-codex', 'Use codex', {});

		expect(detectAgent).toHaveBeenCalledWith('codex');
		expect(spawnAgent).toHaveBeenCalledWith('codex', expect.any(String), 'Use codex', undefined, {
			signal: expect.any(AbortSignal),
			readOnlyMode: undefined,
			consultChain: TARGET_CHAIN,
		});
	});

	it('should pass readOnlyMode when --read-only flag is set', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Read-only response',
			agentSessionId: 'session-ro',
		});

		await send('agent-abc', 'Analyze this code', { readOnly: true });

		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/path/to/project',
			'Analyze this code',
			undefined,
			{ readOnlyMode: true, signal: expect.any(AbortSignal), consultChain: TARGET_CHAIN }
		);
	});

	it('should exit with error when agent ID is not found', async () => {
		vi.mocked(resolveAgentId).mockImplementation(() => {
			throw new Error('Agent not found: bad-id');
		});

		await send('bad-id', 'Hello', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('AGENT_NOT_FOUND');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should exit with error for unsupported agent type', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-term-1');
		vi.mocked(getSessionById).mockReturnValue(
			mockAgent({ id: 'agent-term-1', toolType: 'terminal' })
		);

		await send('agent-term', 'Hello', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('AGENT_UNSUPPORTED');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should exit with error when Claude CLI is not found', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: false });

		await send('agent-abc', 'Hello', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('CLAUDE_CODE_NOT_FOUND');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should handle agent failure with error in response', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: false,
			error: 'Agent crashed',
			agentSessionId: 'failed-session',
			usageStats: {
				inputTokens: 100,
				outputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.01,
				contextWindow: 200000,
			},
		});
		vi.mocked(estimateContextUsage).mockReturnValue(0);
		const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await send('agent-abc', 'Bad request', {});

		// A caller that only reads stderr must still see the failure (#1770).
		expect(stderrSpy).toHaveBeenCalledWith('maestro-cli send failed: Agent crashed');
		stderrSpy.mockRestore();
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.error).toBe('Agent crashed');
		expect(output.agentId).toBe('agent-abc-123');
		expect(output.sessionId).toBe('failed-session');
		expect(output.response).toBeNull();
		expect(output.usage).not.toBeNull();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('reports how the turn ended and keeps exit code 1 for a crash', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: false,
			outcome: 'crashed',
			error: 'Agent crashed',
		});

		await send('agent-abc', 'Bad request', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.outcome).toBe('crashed');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('exits 130, the shell convention for an interrupt, when the turn was interrupted', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: false,
			outcome: 'interrupted',
			error: 'Interrupted',
		});

		await send('agent-abc', 'Long request', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.outcome).toBe('interrupted');
		expect(processExitSpy).toHaveBeenCalledWith(130);
		expect(processExitSpy).not.toHaveBeenCalledWith(1);
	});

	it('cancels a desktop-backed run on Ctrl+C without starting a fallback', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent({ toolType: 'codex' }));
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/codex' });
		desktop.connect.mockResolvedValue(undefined);
		desktop.sendCommand.mockImplementation(
			() =>
				new Promise((_, reject) => {
					desktop.disconnect.mockImplementationOnce(() => reject(new Error('Client disconnected')));
					queueMicrotask(() => process.emit('SIGINT'));
				})
		);
		const listenersBefore = process.listenerCount('SIGINT');

		await send('agent-abc', 'Long request', { requirePluginTools: true });

		expect(desktop.disconnect).toHaveBeenCalled();
		expect(spawnAgent).not.toHaveBeenCalled();
		expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
			success: false,
			outcome: 'interrupted',
		});
		expect(processExitSpy).toHaveBeenCalledWith(130);
		expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
	});

	it('reports a warning outcome as a success', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			outcome: 'completed-with-warning',
			response: 'answer',
		});

		await send('agent-abc', 'Request', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toMatchObject({
			success: true,
			outcome: 'completed-with-warning',
			response: 'answer',
		});
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('builds and passes the Maestro system prompt by default', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		const agent = mockAgent();
		vi.mocked(getSessionById).mockReturnValue(agent);
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(prepareMaestroSystemPromptCli).mockResolvedValue('the maestro context');
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'ok',
			agentSessionId: 'session-1',
		});

		await send('agent-abc', 'hello', {});

		// The chain the send was admitted to, so the prompt can state what is left of it.
		expect(prepareMaestroSystemPromptCli).toHaveBeenCalledWith(agent, {
			consultChain: TARGET_CHAIN,
		});
		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/path/to/project',
			'hello',
			undefined,
			expect.objectContaining({ appendSystemPrompt: 'the maestro context' })
		);
	});

	it('skips building the Maestro system prompt when --no-system-prompt is set', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'ok',
			agentSessionId: 'session-1',
		});

		// Commander negates `--no-system-prompt` to `systemPrompt: false`
		await send('agent-abc', 'hello', { systemPrompt: false });

		expect(prepareMaestroSystemPromptCli).not.toHaveBeenCalled();
		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/path/to/project',
			'hello',
			undefined,
			expect.objectContaining({ appendSystemPrompt: undefined })
		);
	});

	it('still injects the system prompt on resume (parity with desktop)', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(prepareMaestroSystemPromptCli).mockResolvedValue('still here on resume');
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'ok',
			agentSessionId: 'session-xyz',
		});

		await send('agent-abc', 'follow-up', { session: 'session-xyz' });

		expect(prepareMaestroSystemPromptCli).toHaveBeenCalled();
		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/path/to/project',
			'follow-up',
			'session-xyz',
			expect.objectContaining({ appendSystemPrompt: 'still here on resume' })
		);
	});

	it('continues without the system prompt when prepareMaestroSystemPromptCli returns undefined (non-fatal)', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(prepareMaestroSystemPromptCli).mockResolvedValue(undefined);
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'ok',
			agentSessionId: 'session-1',
		});

		await send('agent-abc', 'hello', {});

		expect(prepareMaestroSystemPromptCli).toHaveBeenCalled();
		expect(spawnAgent).toHaveBeenCalled();
		const callArgs = vi.mocked(spawnAgent).mock.calls[0];
		expect(callArgs[4]?.appendSystemPrompt).toBeUndefined();
		// And the send must still succeed end-to-end
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
	});

	it('should handle null usage stats gracefully', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'OK',
			agentSessionId: 'session-no-stats',
		});

		await send('agent-abc', 'Simple message', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(output.usage).toBeNull();
	});

	// A send the CLI spawns itself to an agent set to the Auto model: the
	// desktop's router decides the turn, and the harness never sees the word.
	describe('an agent on the Auto model', () => {
		const LOCAL = { type: 'source' as const, endpointId: 'maestro-server', model: 'qwen3.5-4b' };
		const OWN = { type: 'source' as const, endpointId: 'ep-ollama', model: 'qwen3:latest' };
		const spawnOptions = () => vi.mocked(spawnAgent).mock.calls[0][4];

		const ready = (overrides: Partial<SessionInfo> = {}) => {
			const agent = mockAgent({ customModel: 'auto', customEffort: 'high', ...overrides });
			vi.mocked(resolveAgentId).mockReturnValue(agent.id);
			vi.mocked(getSessionById).mockReturnValue(agent);
			vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
			vi.mocked(spawnAgent).mockResolvedValue({ success: true, response: 'done' });
			return agent;
		};
		const resolvesTo = (turn: Record<string, unknown>) =>
			vi.mocked(resolveCliAutoTurn).mockResolvedValue({
				notes: [],
				warnings: [],
				stamp: { status: 'routed' },
				...turn,
			} as never);

		it('routes the message and spawns on the model and effort it resolves to', async () => {
			const agent = ready();
			resolvesTo({ model: 'haiku', effort: 'low' });

			await send('agent-abc', 'rename the helper', { synopsis: false, history: false });

			expect(resolveCliAutoTurn).toHaveBeenCalledWith({
				agent,
				prompt: 'rename the helper',
				agentEffort: 'high',
				client: null,
			});
			expect(spawnOptions()).toMatchObject({ customModel: 'haiku', customEffort: 'low' });
		});

		it('never passes the word auto: no decision is no model at all', async () => {
			ready();
			resolvesTo({ model: undefined, effort: 'high', stamp: { status: 'no-decision' } });

			await send('agent-abc', 'rename the helper', { synopsis: false, history: false });

			expect(spawnOptions()!.customModel).toBeUndefined();
			expect(spawnOptions()!.customEffort).toBe('high');
		});

		it("launches on the tier's place, and on the agent's own when the tier names none", async () => {
			ready({ runOn: OWN });
			resolvesTo({ model: 'qwen3.5-4b', runOn: LOCAL });
			await send('agent-abc', 'rename the helper', { synopsis: false, history: false });
			expect(spawnOptions()).toMatchObject({ customModel: 'qwen3.5-4b', runOn: LOCAL });

			vi.mocked(spawnAgent).mockClear();
			resolvesTo({ model: 'qwen3:latest' });
			await send('agent-abc', 'rename the helper', { synopsis: false, history: false });
			expect(spawnOptions()).toMatchObject({ runOn: OWN });
		});

		it('fails the send by name, and spawns nothing, when the tier target cannot be used', async () => {
			ready();
			resolvesTo({
				refusal: { code: 'tier-unsupported-source', message: 'The "low" tier target cannot run.' },
			});
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			await send('agent-abc', 'rename the helper', { synopsis: false, history: false });

			expect(spawnAgent).not.toHaveBeenCalled();
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				success: false,
				error: 'The "low" tier target cannot run.',
			});
			expect(processExitSpy).toHaveBeenCalledWith(1);
			errorSpy.mockRestore();
		});

		it('says on stderr when the provider could not act on what the router chose', async () => {
			ready();
			resolvesTo({
				warnings: ['copilot-cli has no model tier mapping, so tier="high" was ignored.'],
			});
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			await send('agent-abc', 'rename the helper', { synopsis: false, history: false });

			expect(errorSpy).toHaveBeenCalledWith(
				'Warning: copilot-cli has no model tier mapping, so tier="high" was ignored.'
			);
			errorSpy.mockRestore();
		});

		it('leaves a send the desktop runs to the desktop, which routes it there', async () => {
			ready();
			desktop.connect.mockResolvedValue(undefined);
			desktop.sendCommand.mockResolvedValue({ available: true, success: true, response: 'done' });

			await send('agent-abc', 'rename the helper', { synopsis: false, history: false });

			expect(resolveCliAutoTurn).not.toHaveBeenCalled();
			expect(spawnAgent).not.toHaveBeenCalled();
		});

		it('routes nothing for an agent on a named model', async () => {
			ready({ customModel: 'opus' });

			await send('agent-abc', 'rename the helper', { synopsis: false, history: false });

			expect(resolveCliAutoTurn).not.toHaveBeenCalled();
			expect(spawnOptions()).toMatchObject({ customModel: 'opus', customEffort: 'high' });
		});
	});

	// `--model <model>`: this one turn's model, in place of the agent's own.
	// `auto` routes the turn the way an agent set to Auto is routed.
	describe('--model', () => {
		const spawnOptions = () => vi.mocked(spawnAgent).mock.calls[0][4];
		const output = () => JSON.parse(consoleSpy.mock.calls[0][0]);

		const ready = (overrides: Partial<SessionInfo> = {}) => {
			const agent = mockAgent({ customModel: 'opus', customEffort: 'high', ...overrides });
			vi.mocked(resolveAgentId).mockReturnValue(agent.id);
			vi.mocked(getSessionById).mockReturnValue(agent);
			vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
			vi.mocked(spawnAgent).mockResolvedValue({ success: true, response: 'done' });
			vi.mocked(readHarnessTierDefaults).mockReturnValue({});
			return agent;
		};
		/** A routed turn as the resolver answers it, with the router's decision on its stamp. */
		const routedTurn = {
			model: 'haiku',
			effort: 'low',
			notes: [],
			warnings: [],
			stamp: {
				status: 'routed' as const,
				route: {
					tier: 'low' as const,
					effort: 'low' as const,
					engine: 'Embedding router',
					calibrated: false,
				},
			},
		};

		it("spawns on the named model in place of the agent's own, and routes nothing", async () => {
			ready();

			await send('agent-abc', 'rename the helper', {
				model: 'sonnet',
				synopsis: false,
				history: false,
			});

			expect(resolveCliAutoTurn).not.toHaveBeenCalled();
			expect(spawnOptions()).toMatchObject({ customModel: 'sonnet', customEffort: 'high' });
			expect(output()).not.toHaveProperty('auto');
		});

		it('keeps the named model for this turn even when the agent is set to Auto', async () => {
			ready({ customModel: 'auto' });

			await send('agent-abc', 'rename the helper', {
				model: 'sonnet',
				synopsis: false,
				history: false,
			});

			expect(resolveCliAutoTurn).not.toHaveBeenCalled();
			expect(spawnOptions()).toMatchObject({ customModel: 'sonnet' });
		});

		it('routes an auto turn for an agent on a named model, and reports what Auto did', async () => {
			const agent = ready();
			vi.mocked(resolveCliAutoTurn).mockResolvedValue(routedTurn as never);

			await send('agent-abc', 'rename the helper', {
				model: 'auto',
				synopsis: false,
				history: false,
			});

			expect(resolveCliAutoTurn).toHaveBeenCalledWith({
				agent,
				prompt: 'rename the helper',
				agentEffort: 'high',
				client: null,
			});
			// The harness is handed the routed model, never the word and never the agent's own.
			expect(spawnOptions()).toMatchObject({ customModel: 'haiku', customEffort: 'low' });
			expect(output()).toMatchObject({
				success: true,
				auto: autoTurnReport(routedTurn as never),
			});
			expect(output().auto).toEqual({
				label: 'Auto → low · haiku',
				detail: expect.stringContaining('Embedding router chose tier low, effort low.'),
			});
		});

		it('reads the word auto whatever its case', async () => {
			ready();
			vi.mocked(resolveCliAutoTurn).mockResolvedValue(routedTurn as never);

			await send('agent-abc', 'rename the helper', {
				model: 'Auto',
				synopsis: false,
				history: false,
			});

			expect(resolveCliAutoTurn).toHaveBeenCalledOnce();
			expect(spawnOptions()).toMatchObject({ customModel: 'haiku' });
		});

		it('refuses auto by name, before anything is started, for an agent Auto cannot act on', async () => {
			ready({ toolType: 'opencode', customModel: undefined, customEffort: undefined });
			desktop.connect.mockResolvedValue(undefined);

			await send('agent-abc', 'rename the helper', {
				model: 'auto',
				synopsis: false,
				history: false,
			});

			expect(output()).toMatchObject({ success: false, code: 'AUTO_MODEL_UNAVAILABLE' });
			expect(output().error).toMatch(/^--model auto: Auto would change nothing for this agent/);
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(desktop.connect).not.toHaveBeenCalled();
			expect(desktop.sendCommand).not.toHaveBeenCalled();
			expect(resolveCliAutoTurn).not.toHaveBeenCalled();
			expect(spawnAgent).not.toHaveBeenCalled();
		});

		it('allows auto for that provider once one of its tiers is mapped to a model', async () => {
			ready({
				toolType: 'opencode',
				customModel: undefined,
				tierTargets: { medium: { type: 'provider-model', model: 'some-model' } },
			});
			vi.mocked(resolveCliAutoTurn).mockResolvedValue({
				...routedTurn,
				model: 'some-model',
			} as never);

			await send('agent-abc', 'rename the helper', {
				model: 'auto',
				synopsis: false,
				history: false,
			});

			expect(processExitSpy).not.toHaveBeenCalledWith(1);
			expect(spawnOptions()).toMatchObject({ customModel: 'some-model' });
		});

		it.each(['-x', '', ' sonnet', 'sonnet ', 'son\nnet'])(
			'refuses %j as a model name before anything is started',
			async (model) => {
				ready();
				desktop.connect.mockResolvedValue(undefined);

				await send('agent-abc', 'rename the helper', { model, synopsis: false, history: false });

				expect(output()).toMatchObject({ success: false, code: 'INVALID_MODEL' });
				expect(processExitSpy).toHaveBeenCalledWith(1);
				expect(desktop.connect).not.toHaveBeenCalled();
				expect(resolveCliAutoTurn).not.toHaveBeenCalled();
				expect(spawnAgent).not.toHaveBeenCalled();
			}
		);

		it('hands the model to the desktop when the desktop runs the send, and passes its Auto report on', async () => {
			ready();
			desktop.connect.mockResolvedValue(undefined);
			const auto = { label: 'Auto → low · haiku', detail: 'Auto: the router chose tier low.' };
			desktop.sendCommand.mockResolvedValue({
				available: true,
				success: true,
				response: 'done',
				auto,
			});

			await send('agent-abc', 'rename the helper', {
				model: 'auto',
				synopsis: false,
				history: false,
			});

			expect(desktop.sendCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'plugins_send_agent',
					agentId: 'agent-abc-123',
					prompt: 'rename the helper',
					model: 'auto',
				}),
				'plugins_send_agent_result',
				expect.any(Number)
			);
			// The desktop routes a send it runs; the CLI asks nothing and spawns nothing.
			expect(resolveCliAutoTurn).not.toHaveBeenCalled();
			expect(spawnAgent).not.toHaveBeenCalled();
			expect(output()).toMatchObject({ success: true, response: 'done', auto });
		});

		it('hands a named model to the desktop too', async () => {
			ready();
			desktop.connect.mockResolvedValue(undefined);
			desktop.sendCommand.mockResolvedValue({ available: true, success: true, response: 'done' });

			await send('agent-abc', 'rename the helper', {
				model: 'sonnet',
				synopsis: false,
				history: false,
			});

			expect(desktop.sendCommand.mock.calls[0][0]).toMatchObject({ model: 'sonnet' });
			expect(output()).not.toHaveProperty('auto');
		});

		it('sends no model field to the desktop without --model', async () => {
			ready();
			desktop.connect.mockResolvedValue(undefined);
			desktop.sendCommand.mockResolvedValue({ available: true, success: true, response: 'done' });

			await send('agent-abc', 'rename the helper', { synopsis: false, history: false });

			expect(desktop.sendCommand.mock.calls[0][0]).not.toHaveProperty('model');
		});
	});

	describe('history', () => {
		const ready = (overrides: Partial<SessionInfo> = {}) => {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			vi.mocked(getSessionById).mockReturnValue(mockAgent(overrides));
			vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		};

		it('writes a USER entry summarized by a synopsis turn resumed on the same session', async () => {
			ready();
			vi.mocked(spawnAgent)
				.mockResolvedValueOnce({
					success: true,
					response: 'Fixed the bug.',
					agentSessionId: 'session-xyz-789',
				})
				.mockResolvedValueOnce({
					success: true,
					response:
						'**Summary:** Fixed the tooltip clipping in FilePreview.\n\n**Details:** Moved the portal.',
				});

			await send('agent-abc', 'Fix it', {});

			expect(spawnAgent).toHaveBeenCalledTimes(2);
			const synopsisCall = vi.mocked(spawnAgent).mock.calls[1];
			expect(synopsisCall[2]).toBe('SYNOPSIS PROMPT');
			expect(synopsisCall[3]).toBe('session-xyz-789');
			expect(synopsisCall[4]).toMatchObject({
				querySource: 'auto',
				signal: expect.any(AbortSignal),
			});
			expect(addHistoryEntry).toHaveBeenCalledTimes(1);
			const entry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(entry).toMatchObject({
				type: 'USER',
				sessionId: 'agent-abc-123',
				agentSessionId: 'session-xyz-789',
				projectPath: '/path/to/project',
				success: true,
				summary: 'Fixed the tooltip clipping in FilePreview.',
			});
			expect(typeof entry.elapsedTimeMs).toBe('number');
			// stdout still carries only the turn's JSON
			expect(consoleSpy).toHaveBeenCalledTimes(1);
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('writes an AGENT entry naming the sender when another agent runs the send', async () => {
			vi.stubEnv(CALLER_AGENT_ID_ENV_VAR, 'agent-caller-1');
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			vi.mocked(getSessionById).mockImplementation((id) =>
				id === 'agent-caller-1'
					? mockAgent({ id: 'agent-caller-1', name: 'Conductor' })
					: mockAgent()
			);
			vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
			vi.mocked(spawnAgent).mockResolvedValue({
				success: true,
				response: 'Fixed the bug.',
				agentSessionId: 'session-1',
			});

			await send('agent-abc', 'Fix it', { synopsis: false });

			const entry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(entry).toMatchObject({
				type: 'AGENT',
				sessionId: 'agent-abc-123',
				sourceAgentName: 'Conductor',
				summary: 'Sent by Conductor: Fixed the bug.',
				fullResponse: 'Fixed the bug.',
				success: true,
			});
		});

		it('marks a failed send from another agent as a failed AGENT entry', async () => {
			vi.stubEnv(CALLER_AGENT_ID_ENV_VAR, 'agent-caller-1');
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			vi.mocked(getSessionById).mockImplementation((id) =>
				id === 'agent-caller-1'
					? mockAgent({ id: 'agent-caller-1', name: 'Conductor' })
					: mockAgent()
			);
			vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
			const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.mocked(spawnAgent).mockResolvedValue({ success: false, error: 'boom' });

			await send('agent-abc', 'Do it', {});

			const entry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(entry).toMatchObject({
				type: 'AGENT',
				success: false,
				summary: 'Sent by Conductor: Send failed: boom',
			});
			errSpy.mockRestore();
		});

		it('names a calling agent that no longer exists by its id', async () => {
			vi.stubEnv(CALLER_AGENT_ID_ENV_VAR, 'agent-gone-9');
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			vi.mocked(getSessionById).mockImplementation((id) =>
				id === 'agent-gone-9' ? undefined : mockAgent()
			);
			vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
			vi.mocked(spawnAgent).mockResolvedValue({
				success: true,
				response: 'Done',
				agentSessionId: 'session-1',
			});

			await send('agent-abc', 'Do it', { synopsis: false });

			const entry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(entry).toMatchObject({ type: 'AGENT', sourceAgentName: 'agent-gone-9' });
		});

		it('writes a CUE entry and keeps the turn Cue-sourced when Cue started the send', async () => {
			vi.stubEnv(QUERY_SOURCE_ENV_VAR, 'cue');
			ready();
			vi.mocked(spawnAgent).mockResolvedValue({
				success: true,
				response: 'Triaged the queue.',
				agentSessionId: 'session-1',
			});

			await send('agent-abc', 'Triage', { synopsis: false });

			expect(vi.mocked(spawnAgent).mock.calls[0][4]).toMatchObject({ querySource: 'cue' });
			const entry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(entry).toMatchObject({
				type: 'CUE',
				summary: 'Triaged the queue.',
				success: true,
			});
			expect(entry.sourceAgentName).toBeUndefined();
			// Setting these would pair the entry with the run's own `cue_events`
			// row and hide that row from the History panel.
			expect(entry.cueTriggerName).toBeUndefined();
			expect(entry.cueEventType).toBeUndefined();
		});

		it('records a Cue-started send as CUE even when an agent ran the command', async () => {
			vi.stubEnv(QUERY_SOURCE_ENV_VAR, 'cue');
			vi.stubEnv(CALLER_AGENT_ID_ENV_VAR, 'agent-caller-1');
			ready();
			const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.mocked(spawnAgent).mockResolvedValue({ success: false, error: 'boom' });

			await send('agent-abc', 'Do it', {});

			const entry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(entry).toMatchObject({ type: 'CUE', success: false, summary: 'Send failed: boom' });
			expect(entry.sourceAgentName).toBeUndefined();
			errSpy.mockRestore();
		});

		it('leaves the turn origin unset for a send a user-sourced turn ran', async () => {
			vi.stubEnv(QUERY_SOURCE_ENV_VAR, 'user');
			ready();
			vi.mocked(spawnAgent).mockResolvedValue({
				success: true,
				response: 'Done',
				agentSessionId: 'session-1',
			});

			await send('agent-abc', 'Do it', { synopsis: false });

			expect(vi.mocked(spawnAgent).mock.calls[0][4]?.querySource).toBeUndefined();
			expect(vi.mocked(addHistoryEntry).mock.calls[0][0].type).toBe('USER');
		});

		it('writes a USER entry with no sender when no agent is calling', async () => {
			ready();
			vi.mocked(spawnAgent).mockResolvedValue({
				success: true,
				response: 'Done',
				agentSessionId: 'session-1',
			});

			await send('agent-abc', 'Do it', { synopsis: false });

			const entry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(entry.type).toBe('USER');
			expect(entry.summary).toBe('Done');
			expect(entry.sourceAgentName).toBeUndefined();
		});

		it('writes nothing with --no-history', async () => {
			ready();
			vi.mocked(spawnAgent).mockResolvedValue({
				success: true,
				response: 'Done',
				agentSessionId: 'session-1',
			});

			await send('agent-abc', 'Do it', { history: false });

			expect(spawnAgent).toHaveBeenCalledTimes(1);
			expect(addHistoryEntry).not.toHaveBeenCalled();
		});

		it('skips the synopsis turn with --no-synopsis and uses the response', async () => {
			ready();
			vi.mocked(spawnAgent).mockResolvedValue({
				success: true,
				response: '\nFirst line of the answer\nmore detail',
				agentSessionId: 'session-1',
			});

			await send('agent-abc', 'Do it', { synopsis: false });

			expect(spawnAgent).toHaveBeenCalledTimes(1);
			const entry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(entry.summary).toBe('First line of the answer');
			expect(entry.fullResponse).toBe('\nFirst line of the answer\nmore detail');
		});

		it('still writes an entry from the response when the synopsis reports NOTHING_TO_REPORT', async () => {
			ready();
			vi.mocked(spawnAgent)
				.mockResolvedValueOnce({
					success: true,
					response: 'There are 4 Python files.',
					agentSessionId: 'session-1',
				})
				.mockResolvedValueOnce({ success: true, response: 'NOTHING_TO_REPORT' });

			await send('agent-abc', 'count files', {});

			const entry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(entry.summary).toBe('There are 4 Python files.');
			expect(entry.fullResponse).toBe('There are 4 Python files.');
		});

		it('falls back to the response when the synopsis turn prints a provider error', async () => {
			ready();
			vi.mocked(spawnAgent)
				.mockResolvedValueOnce({
					success: true,
					response: 'Refactored the parser.',
					agentSessionId: 'session-1',
				})
				.mockResolvedValueOnce({ success: true, response: 'Prompt is too long' });

			await send('agent-abc', 'refactor', {});

			const entry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(entry.summary).toBe('Refactored the parser.');
			expect(entry.fullResponse).toBe('Refactored the parser.');
		});

		it('still writes an entry from the response when the synopsis turn throws', async () => {
			ready();
			const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.mocked(spawnAgent)
				.mockResolvedValueOnce({
					success: true,
					response: 'Refactored the parser.',
					agentSessionId: 'session-1',
				})
				.mockRejectedValueOnce(new Error('spawn ENOENT'));

			await send('agent-abc', 'refactor', {});

			expect(addHistoryEntry).toHaveBeenCalledTimes(1);
			const entry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(entry).toMatchObject({
				success: true,
				summary: 'Refactored the parser.',
				fullResponse: 'Refactored the parser.',
			});
			expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('spawn ENOENT'));
			expect(processExitSpy).not.toHaveBeenCalled();
			errSpy.mockRestore();
		});

		it('keeps the agent model for the synopsis when the cheap tier would shrink the context window', async () => {
			ready({ customModel: 'opus[1m]' });
			vi.mocked(spawnAgent)
				.mockResolvedValueOnce({ success: true, response: 'Done', agentSessionId: 'session-1' })
				.mockResolvedValueOnce({ success: true, response: '**Summary:** Did it.' });

			await send('agent-abc', 'Do it', {});

			expect(vi.mocked(spawnAgent).mock.calls[1][4]).toMatchObject({ customModel: 'opus[1m]' });
		});

		it("runs the turn and its synopsis on the agent's Run on target", async () => {
			const runOn = { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' };
			ready({ runOn });
			vi.mocked(spawnAgent)
				.mockResolvedValueOnce({ success: true, response: 'Done', agentSessionId: 'session-1' })
				.mockResolvedValueOnce({ success: true, response: '**Summary:** Did it.' });

			await send('agent-abc', 'Do it', {});

			// The synopsis resumes the turn's conversation. Without the target it
			// would send that conversation to the provider's cloud.
			expect(vi.mocked(spawnAgent).mock.calls[0][4]).toMatchObject({ runOn });
			expect(vi.mocked(spawnAgent).mock.calls[1][4]).toMatchObject({ runOn });
		});

		it('keeps the synopsis turn read-only after a --read-only send', async () => {
			ready();
			vi.mocked(spawnAgent)
				.mockResolvedValueOnce({ success: true, response: 'Plan', agentSessionId: 'session-1' })
				.mockResolvedValueOnce({ success: true, response: '**Summary:** Planned it.' });

			await send('agent-abc', 'Plan it', { readOnly: true });

			// Both turns run on one session: a synopsis without the flag would hold
			// full permissions on a conversation the caller asked to keep read-only.
			expect(vi.mocked(spawnAgent).mock.calls[0][4]).toMatchObject({ readOnlyMode: true });
			expect(vi.mocked(spawnAgent).mock.calls[1][4]).toMatchObject({ readOnlyMode: true });
		});

		it('does not make the synopsis turn read-only for an ordinary send', async () => {
			ready();
			vi.mocked(spawnAgent)
				.mockResolvedValueOnce({ success: true, response: 'Done', agentSessionId: 'session-1' })
				.mockResolvedValueOnce({ success: true, response: '**Summary:** Did it.' });

			await send('agent-abc', 'Do it', {});

			expect(vi.mocked(spawnAgent).mock.calls[1][4]?.readOnlyMode).toBeUndefined();
		});

		it('records a failed turn without a synopsis turn', async () => {
			ready();
			const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.mocked(spawnAgent).mockResolvedValue({ success: false, error: 'boom' });

			await send('agent-abc', 'Do it', {});

			expect(spawnAgent).toHaveBeenCalledTimes(1);
			const entry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(entry).toMatchObject({ success: false, summary: 'Send failed: boom' });
			expect(processExitSpy).toHaveBeenCalledWith(1);
			errSpy.mockRestore();
		});

		it('records an interrupted turn without a synopsis turn', async () => {
			ready();
			const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.mocked(spawnAgent).mockResolvedValue({
				success: false,
				error: 'Interrupted',
				outcome: 'interrupted',
				agentSessionId: 'session-1',
			});

			await send('agent-abc', 'Do it', {});

			expect(spawnAgent).toHaveBeenCalledTimes(1);
			const entry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(entry).toMatchObject({ success: false, summary: 'Send interrupted' });
			expect(processExitSpy).toHaveBeenCalledWith(130);
			errSpy.mockRestore();
		});

		it('keeps the send successful when the history write throws', async () => {
			ready();
			const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.mocked(spawnAgent).mockResolvedValue({
				success: true,
				response: 'Done',
				agentSessionId: 'session-1',
			});
			vi.mocked(addHistoryEntry).mockImplementationOnce(() => {
				throw new Error('disk full');
			});

			await send('agent-abc', 'Do it', { synopsis: false });

			expect(processExitSpy).not.toHaveBeenCalled();
			expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('disk full'));
			errSpy.mockRestore();
		});
	});

	// A send from an agent's shell is a consult made while working on a user
	// message. It spends that message's budget, and a chain that is out refuses
	// it loudly: a silent no-op would read as a peer with nothing to say.
	describe('the consult budget', () => {
		const refusal = {
			allowed: false as const,
			code: CONSULT_BUDGET_EXHAUSTED_CODE,
			message:
				'Consultation budget exhausted, so nothing was sent: the agents working on this message have spent 25 of 25 consults and delegations.',
		};

		function ready(): void {
			vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
			vi.mocked(getSessionById).mockReturnValue(mockAgent());
			vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
			vi.mocked(spawnAgent).mockResolvedValue({
				success: true,
				response: 'Done',
				agentSessionId: 'session-1',
			});
		}

		it('refuses with the JSON error shape and a non-zero exit, and reaches nobody', async () => {
			ready();
			desktop.connect.mockResolvedValue(undefined);
			vi.mocked(admitCliConsult).mockReturnValue(refusal);

			await send('agent-abc', 'What do you think?', {});

			expect(consoleSpy).toHaveBeenCalledOnce();
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toEqual({
				success: false,
				error: refusal.message,
				code: CONSULT_BUDGET_EXHAUSTED_CODE,
			});
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(spawnAgent).not.toHaveBeenCalled();
			expect(desktop.sendCommand).not.toHaveBeenCalled();
			expect(desktop.disconnect).toHaveBeenCalled();
			// Nothing was sent, so the target's History must not say something was.
			expect(addHistoryEntry).not.toHaveBeenCalled();
		});

		it('names the budget, the number spent and the setting in the error', async () => {
			ready();
			vi.mocked(admitCliConsult).mockReturnValue({
				...refusal,
				message: `${refusal.message} The budget is the maxConsultationsPerTurn setting.`,
			});

			await send('agent-abc', 'What do you think?', {});

			const { error } = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(error).toContain('Consultation budget');
			expect(error).toContain('25 of 25');
			expect(error).toContain('maxConsultationsPerTurn');
		});

		it('spends once per send, from the environment the command runs in', async () => {
			ready();

			await send('agent-abc', 'What do you think?', { synopsis: false });

			expect(admitCliConsult).toHaveBeenCalledExactlyOnceWith();
		});

		// Checked last: a send that was never going to start must not cost the
		// chain one of its consults.
		it('spends nothing on a model name it refuses', async () => {
			ready();

			await send('agent-abc', 'What do you think?', { model: '-x' });

			expect(admitCliConsult).not.toHaveBeenCalled();
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({ code: 'INVALID_MODEL' });
		});

		it('spends nothing on a plugin-tool run that has no desktop to run on', async () => {
			ready();

			await send('agent-abc', 'What do you think?', { requirePluginTools: true });

			expect(admitCliConsult).not.toHaveBeenCalled();
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				code: 'PLUGIN_TOOLS_UNAVAILABLE',
			});
		});

		it('hands the agent it spawns its place in the chain, so its own consults are counted', async () => {
			ready();

			await send('agent-abc', 'What do you think?', { synopsis: false });

			expect(vi.mocked(spawnAgent).mock.calls[0][4]).toMatchObject({ consultChain: TARGET_CHAIN });
		});

		// The desktop spawns the agent on this route, so the chain cannot ride the
		// CLI's own environment: it has to be in the message.
		it('hands the desktop the same place in the chain when the desktop runs the send', async () => {
			ready();
			desktop.connect.mockResolvedValue(undefined);
			desktop.sendCommand.mockResolvedValue({ available: true, success: true, response: 'done' });

			await send('agent-abc', 'What do you think?', { synopsis: false });

			expect(desktop.sendCommand).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'plugins_send_agent', consultChain: TARGET_CHAIN }),
				'plugins_send_agent_result',
				expect.any(Number)
			);
			expect(spawnAgent).not.toHaveBeenCalled();
		});
	});
});
