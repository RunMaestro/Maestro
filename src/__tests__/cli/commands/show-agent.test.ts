/**
 * @file show-agent.test.ts
 * @description Tests for the show-agent CLI command
 *
 * Tests all functionality of the show-agent command including:
 * - Displaying agent details with history and stats
 * - JSON output mode
 * - Group name resolution
 * - Usage statistics aggregation
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionInfo, Group, HistoryEntry } from '../../../shared/types';

// Mock the storage service
vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(),
	readHistory: vi.fn(),
	readGroups: vi.fn(),
	// The agent list a peer roster is resolved against.
	readSessions: vi.fn(() => []),
	// The harness tier defaults a tier is resolved against, below the agent's own.
	readHarnessTierDefaults: vi.fn(() => ({})),
	// The two layers under an agent's own environment variables: Settings >
	// Environment, and the provider-level set.
	readSettingValue: vi.fn(() => undefined),
	readAgentConfigValue: vi.fn(() => undefined),
	// The saved sources a Run on target is labeled from.
	readLocalModelEndpoints: vi.fn(() => [
		{
			id: 'ep-ollama',
			name: 'Ollama',
			kind: 'ollama',
			baseUrl: 'http://127.0.0.1:11434',
			enabled: true,
		},
	]),
}));

// Mock the formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatAgentDetail: vi.fn((detail) => `Agent: ${detail.name}\nPath: ${detail.cwd}`),
	formatError: vi.fn((msg) => `Error: ${msg}`),
}));

import { showAgent } from '../../../cli/commands/show-agent';
import {
	getSessionById,
	readAgentConfigValue,
	readHarnessTierDefaults,
	readHistory,
	readGroups,
	readSessions,
	readSettingValue,
} from '../../../cli/services/storage';
import { formatAgentDetail, formatError } from '../../../cli/output/formatter';

describe('show-agent command', () => {
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
		autoRunFolderPath: undefined,
		...overrides,
	});

	const mockHistoryEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
		id: 'hist-1',
		sessionId: 'agent-123',
		projectPath: '/path/to/project',
		timestamp: Date.now(),
		type: 'command',
		summary: 'Test command',
		success: true,
		elapsedTimeMs: 1000,
		usageStats: {
			inputTokens: 100,
			outputTokens: 200,
			cacheReadInputTokens: 50,
			cacheCreationInputTokens: 25,
			totalCostUsd: 0.01,
		},
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
		it('should display agent details in human-readable format', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', {});

			expect(getSessionById).toHaveBeenCalledWith('agent-123');
			expect(formatAgentDetail).toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('should include group name when agent belongs to a group', () => {
			const groups: Group[] = [{ id: 'group-1', name: 'Frontend', emoji: '🎨', collapsed: false }];
			vi.mocked(getSessionById).mockReturnValue(mockSession({ groupId: 'group-1' }));
			vi.mocked(readGroups).mockReturnValue(groups);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', {});

			expect(formatAgentDetail).toHaveBeenCalledWith(
				expect.objectContaining({
					groupId: 'group-1',
					groupName: 'Frontend',
				})
			);
		});

		it('should handle agent without group', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession({ groupId: undefined }));
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', {});

			expect(formatAgentDetail).toHaveBeenCalledWith(
				expect.objectContaining({
					groupId: undefined,
					groupName: undefined,
				})
			);
		});
	});

	describe('usage statistics', () => {
		it('should aggregate usage stats from history', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({
					usageStats: {
						inputTokens: 100,
						outputTokens: 200,
						cacheReadInputTokens: 50,
						cacheCreationInputTokens: 25,
						totalCostUsd: 0.01,
					},
				}),
				mockHistoryEntry({
					usageStats: {
						inputTokens: 150,
						outputTokens: 300,
						cacheReadInputTokens: 75,
						cacheCreationInputTokens: 50,
						totalCostUsd: 0.02,
					},
				}),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.totalInputTokens).toBe(250);
			expect(parsed.stats.totalOutputTokens).toBe(500);
			expect(parsed.stats.totalCacheReadTokens).toBe(125);
			expect(parsed.stats.totalCacheCreationTokens).toBe(75);
			expect(parsed.stats.totalCost).toBe(0.03);
		});

		it('should count success and failure entries', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({ success: true }),
				mockHistoryEntry({ success: true }),
				mockHistoryEntry({ success: false }),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.successCount).toBe(2);
			expect(parsed.stats.failureCount).toBe(1);
		});

		it('should aggregate elapsed time', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({ elapsedTimeMs: 1000 }),
				mockHistoryEntry({ elapsedTimeMs: 2000 }),
				mockHistoryEntry({ elapsedTimeMs: 3000 }),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.totalElapsedMs).toBe(6000);
		});

		it('should handle entries without usageStats', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({ usageStats: undefined }),
				mockHistoryEntry({
					usageStats: {
						inputTokens: 100,
						outputTokens: 200,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.01,
					},
				}),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.totalInputTokens).toBe(100);
			expect(parsed.stats.totalOutputTokens).toBe(200);
		});

		it('should handle entries without elapsedTimeMs', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({ elapsedTimeMs: undefined }),
				mockHistoryEntry({ elapsedTimeMs: 1000 }),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.totalElapsedMs).toBe(1000);
		});

		it('should handle entries with undefined success', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({ success: undefined }),
				mockHistoryEntry({ success: true }),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.successCount).toBe(1);
			expect(parsed.stats.failureCount).toBe(0);
		});
	});

	describe('recent history', () => {
		it('should include last 10 history entries sorted by timestamp', () => {
			const history: HistoryEntry[] = Array.from({ length: 15 }, (_, i) =>
				mockHistoryEntry({ id: `hist-${i}`, timestamp: 1000 + i * 100 })
			);

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.recentHistory).toHaveLength(10);
			// Should be sorted by timestamp descending (most recent first)
			expect(parsed.recentHistory[0].id).toBe('hist-14');
			expect(parsed.recentHistory[9].id).toBe('hist-5');
		});

		it('should include cost from history entries', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({ usageStats: { inputTokens: 0, outputTokens: 0, totalCostUsd: 0.05 } }),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.recentHistory[0].cost).toBe(0.05);
		});

		it('should handle history entries without usageStats', () => {
			const history: HistoryEntry[] = [mockHistoryEntry({ usageStats: undefined })];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.recentHistory[0].cost).toBeUndefined();
		});
	});

	describe('JSON output', () => {
		it('should output JSON when json option is true', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(formatAgentDetail).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledTimes(1);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.id).toBe('agent-123');
			expect(parsed.name).toBe('Test Agent');
			expect(parsed.toolType).toBe('claude-code');
		});

		it('should include all agent properties in JSON output', () => {
			vi.mocked(getSessionById).mockReturnValue(
				mockSession({
					id: 'full-agent',
					name: 'Full Agent',
					toolType: 'gemini-cli',
					cwd: '/project',
					projectRoot: '/project/root',
					groupId: 'group-1',
					autoRunFolderPath: '/project/playbooks',
					worktreeConfig: { basePath: '/project-worktrees', watchEnabled: true },
				})
			);
			vi.mocked(readGroups).mockReturnValue([
				{ id: 'group-1', name: 'My Group', emoji: '🔧', collapsed: false },
			]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('full-agent', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.id).toBe('full-agent');
			expect(parsed.name).toBe('Full Agent');
			expect(parsed.toolType).toBe('gemini-cli');
			expect(parsed.cwd).toBe('/project');
			expect(parsed.projectRoot).toBe('/project/root');
			expect(parsed.groupId).toBe('group-1');
			expect(parsed.groupName).toBe('My Group');
			expect(parsed.autoRunFolderPath).toBe('/project/playbooks');
			expect(parsed.worktreeBasePath).toBe('/project-worktrees');
		});

		it("reports the agent's Local Models gateway, the read for update-agent --gateway-url", () => {
			vi.mocked(getSessionById).mockReturnValue(
				mockSession({ gatewayUrl: 'http://127.0.0.1:8787/anthropic' })
			);
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0]).gatewayUrl).toBe(
				'http://127.0.0.1:8787/anthropic'
			);
		});

		it('reports an empty peers block, and reads no agent list, for an agent with no peer configuration', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0]).peers).toEqual({
				rows: [],
				groupGrant: { on: false, read: false, write: false, access: 'Off' },
				worktreeGrant: { on: false, read: false, write: false, access: 'Off' },
				roster: [],
			});
			expect(readSessions).not.toHaveBeenCalled();
		});

		it('reports the stored peer rows, the grants, and the resolved roster with each source', () => {
			const self = mockSession({
				groupId: 'group-1',
				groupPeerAccess: { read: true, write: false },
				peerAgents: [
					{ sessionId: 'peer-writer', read: true, write: true, description: 'Owns the API' },
					{ sessionId: 'peer-muted', read: false, write: false },
					{ sessionId: 'peer-deleted', read: true, write: false },
				],
			});
			vi.mocked(getSessionById).mockReturnValue(self);
			vi.mocked(readSessions).mockReturnValue([
				self,
				mockSession({ id: 'peer-writer', name: 'API Agent', groupId: 'group-1' }),
				mockSession({ id: 'peer-muted', name: 'Noisy Agent', groupId: 'group-1' }),
				mockSession({ id: 'peer-grouped', name: 'Docs Agent', groupId: 'group-1' }),
				mockSession({ id: 'peer-elsewhere', name: 'Other Team', groupId: 'group-2' }),
			]);
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			const { peers } = JSON.parse(consoleSpy.mock.calls[0][0]);
			// Stored: all three rows, the exclusion and the dead id included.
			expect(peers.rows).toEqual([
				{
					sessionId: 'peer-writer',
					name: 'API Agent',
					read: true,
					write: true,
					access: 'Consult + Delegate',
					description: 'Owns the API',
				},
				{
					sessionId: 'peer-muted',
					name: 'Noisy Agent',
					read: false,
					write: false,
					access: 'No access',
					description: null,
				},
				{
					sessionId: 'peer-deleted',
					name: null,
					read: true,
					write: false,
					access: 'Consult only',
					description: null,
				},
			]);
			expect(peers.groupGrant).toEqual({
				on: true,
				read: true,
				write: false,
				access: 'Consult only',
			});
			expect(peers.worktreeGrant.on).toBe(false);
			// Resolved: the row replaced the grant for the writer, the exclusion
			// removed the muted peer, the dead row resolved to nobody, and the
			// grant alone put the grouped peer in. Sorted by name.
			expect(
				peers.roster.map((p: { sessionId: string; access: string; source: string }) => [
					p.sessionId,
					p.access,
					p.source,
				])
			).toEqual([
				['peer-writer', 'Consult + Delegate', 'explicit'],
				['peer-grouped', 'Consult only', 'group'],
			]);
		});

		it('reports gatewayUrl as null for an agent with no gateway', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0]).gatewayUrl).toBeNull();
		});

		it("reports the agent's Run on target, the read for update-agent --run-on", () => {
			const runOn = {
				type: 'source' as const,
				endpointId: 'ep-ollama',
				model: 'qwen3:latest',
				contextTokens: 65_536,
			};
			vi.mocked(getSessionById).mockReturnValue(mockSession({ runOn }));
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				runOn,
				// The spelling `--run-on` takes, so the read can be written back.
				runOnSpec: 'ep-ollama:qwen3:latest',
				runOnLabel: 'qwen3:latest on Ollama',
				runOnProblem: null,
			});
		});

		it('reports the provider for an agent with no target: a value, not an unset field', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				runOn: { type: 'provider' },
				runOnSpec: 'provider',
				runOnLabel: null,
				runOnProblem: null,
			});
		});

		it('reports a stored target that cannot be read as it is stored, with the reason', () => {
			const stored = { type: 'source', endpointId: 'ep-ollama' };
			vi.mocked(getSessionById).mockReturnValue(mockSession({ runOn: stored as never }));
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				runOn: stored,
				runOnSpec: null,
				runOnLabel: null,
				runOnProblem: 'A Run on target names a model.',
			});
		});

		it("reports each tier's value and the layer it came from, the read for update-agent --tier", () => {
			const local = { type: 'source' as const, endpointId: 'ep-ollama', model: 'qwen3:latest' };
			vi.mocked(getSessionById).mockReturnValue(mockSession({ tierTargets: { low: local } }));
			vi.mocked(readHarnessTierDefaults).mockReturnValue({
				'claude-code': { medium: { type: 'provider-model', model: 'opus' } },
			});
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0]).tiers).toEqual([
				{
					tier: 'low',
					target: local,
					// The spelling `--tier` takes, so the read can be written back.
					spec: 'ep-ollama:qwen3:latest',
					label: 'qwen3:latest on Ollama',
					source: 'agent',
					builtIn: 'haiku',
				},
				{
					tier: 'medium',
					target: { type: 'provider-model', model: 'opus' },
					spec: 'provider:opus',
					label: 'opus',
					source: 'harness-default',
					builtIn: 'sonnet',
				},
				{
					tier: 'high',
					target: { type: 'provider-model', model: 'opus' },
					spec: 'provider:opus',
					label: 'opus',
					source: 'built-in',
					builtIn: 'opus',
				},
			]);
		});

		it('reports a tier a launch would refuse with the refusal, and one that does not apply with the reason', () => {
			vi.mocked(readHarnessTierDefaults).mockReturnValue({});
			vi.mocked(getSessionById).mockReturnValue(
				mockSession({
					runOn: { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' },
					tierTargets: { high: { type: 'source' } } as never,
				})
			);
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			const [low, , high] = JSON.parse(consoleSpy.mock.calls[0][0]).tiers;
			// Only the built-in table maps low, and this agent runs on a source.
			expect(low).toMatchObject({ target: null, spec: null, source: null });
			expect(low.note).toMatch(/Local Models source/);
			expect(high).toMatchObject({ target: null, source: 'agent' });
			expect(high.problem).toMatch(/cannot be used/);
		});

		it('reports no tiers for a harness that cannot be told which model to run', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession({ toolType: 'terminal' }));
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0]).tiers).toEqual([]);
		});

		it("reports the agent's background requests target, the read for update-agent --background-requests", () => {
			const target = { type: 'source' as const, endpointId: 'ep-ollama', model: 'qwen3:4b' };
			vi.mocked(getSessionById).mockReturnValue(mockSession({ backgroundRequests: { target } }));
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				backgroundRequests: { target },
				backgroundRequestsSpec: 'ep-ollama:qwen3:4b',
				backgroundRequestsLabel: 'qwen3:4b on Ollama',
				backgroundRequestsProblem: null,
			});
		});

		it('reports none for an agent with no background target: a value, not an unset field', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				backgroundRequests: null,
				backgroundRequestsSpec: 'none',
				backgroundRequestsLabel: null,
				backgroundRequestsProblem: null,
			});
		});

		it('reports a stored background target that cannot be read, with the reason', () => {
			const stored = { target: { type: 'source', endpointId: 'ep-ollama' } };
			vi.mocked(getSessionById).mockReturnValue(
				mockSession({ backgroundRequests: stored as never })
			);
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				backgroundRequests: stored,
				backgroundRequestsSpec: null,
				backgroundRequestsProblem: 'A Run on target names a model.',
			});
		});

		it("reports the agent's System One switch, the read for update-agent --system-one", () => {
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			vi.mocked(getSessionById).mockReturnValue(mockSession({ systemOneOptOut: true }));
			showAgent('agent-123', { json: true });
			expect(JSON.parse(consoleSpy.mock.calls[0][0]).systemOneOptOut).toBe(true);

			// An agent that was never switched off reads false: a value, not an unset field.
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			showAgent('agent-123', { json: true });
			expect(JSON.parse(consoleSpy.mock.calls[1][0]).systemOneOptOut).toBe(false);
		});

		it("reports the agent's token proxy mode, the read for update-agent --proxy-mode", () => {
			vi.mocked(getSessionById).mockReturnValue(
				mockSession({
					gatewayUrl: 'http://127.0.0.1:48123/anthropic',
					tokenProxyMode: 'compress',
				})
			);
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0]).tokenProxyMode).toBe('compress');
		});

		it('reports tokenProxyMode as null when none is stored (the default, passthrough)', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0]).tokenProxyMode).toBeNull();
		});

		it('should report the resolved Codex transport for a Codex agent', () => {
			vi.mocked(getSessionById).mockReturnValue(
				mockSession({ toolType: 'codex', codexTransport: 'app-server' })
			);
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.codexTransport).toBe('app-server');
			expect(parsed.codexTransportStored).toBe('app-server');
		});

		it('should resolve an unset Codex transport to exec', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession({ toolType: 'codex' }));
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.codexTransport).toBe('exec');
			expect(parsed.codexTransportStored).toBeNull();
		});

		it('should report a null Codex transport for a non-Codex agent', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession({ codexTransport: 'app-server' }));
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.codexTransport).toBeNull();
		});

		it('should report worktreeBasePath as null when no worktree directory is configured', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession({ worktreeConfig: undefined }));
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.worktreeBasePath).toBeNull();
		});
	});

	describe('error handling', () => {
		it('should throw error when agent not found', () => {
			vi.mocked(getSessionById).mockReturnValue(undefined);

			expect(() => showAgent('nonexistent', {})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Agent not found: nonexistent');
		});

		it('should output error as JSON when json option is true', () => {
			vi.mocked(getSessionById).mockReturnValue(undefined);

			expect(() => showAgent('nonexistent', { json: true })).toThrow('process.exit(1)');

			const errorOutput = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(errorOutput);
			expect(parsed).toEqual({ success: false, error: 'Agent not found: nonexistent' });
		});

		it('should handle storage errors', () => {
			vi.mocked(getSessionById).mockImplementation(() => {
				throw new Error('Storage read failed');
			});

			expect(() => showAgent('agent-123', {})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Storage read failed');
		});

		it('should handle non-Error objects thrown', () => {
			vi.mocked(getSessionById).mockImplementation(() => {
				throw 'String error';
			});

			expect(() => showAgent('agent-123', {})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Unknown error');
		});

		it('should exit with code 1 on error', () => {
			vi.mocked(getSessionById).mockReturnValue(undefined);

			expect(() => showAgent('nonexistent', {})).toThrow('process.exit(1)');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('edge cases', () => {
		it('should handle empty history', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.historyEntries).toBe(0);
			expect(parsed.stats.successCount).toBe(0);
			expect(parsed.stats.failureCount).toBe(0);
			expect(parsed.stats.totalCost).toBe(0);
			expect(parsed.recentHistory).toEqual([]);
		});

		it('should handle partial ID lookup', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent', {});

			expect(getSessionById).toHaveBeenCalledWith('agent');
		});

		it('should handle group not found for groupId', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession({ groupId: 'missing-group' }));
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.groupId).toBe('missing-group');
			expect(parsed.groupName).toBeUndefined();
		});

		it('should pass correct sessionId to readHistory', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession({ id: 'specific-agent' }));
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('specific-agent', {});

			expect(readHistory).toHaveBeenCalledWith(undefined, 'specific-agent');
		});
	});
});

// The Edit Agent dialog's "Show environment" table, and the masking it does.
// `show agent` used to print an agent's own variables raw and nothing about the
// layers under them, so a caller could neither see what a spawn would get nor
// read the output aloud.
describe('show-agent: the environment an agent is spawned with', () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;

	const agent = (overrides: Partial<SessionInfo> = {}): SessionInfo =>
		({
			id: 'agent-123',
			name: 'Test Agent',
			toolType: 'claude-code',
			cwd: '/path/to/project',
			projectRoot: '/path/to/project',
			...overrides,
		}) as SessionInfo;

	const shown = () => JSON.parse(String(consoleSpy.mock.calls[0][0]));

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readHistory).mockReturnValue([]);
		vi.mocked(readGroups).mockReturnValue([]);
		vi.mocked(readSessions).mockReturnValue([]);
		vi.mocked(readHarnessTierDefaults).mockReturnValue({});
		vi.mocked(readSettingValue).mockReturnValue(undefined);
		vi.mocked(readAgentConfigValue).mockReturnValue(undefined);
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('names the layer each value came from, and the layer it overrode', () => {
		vi.mocked(readSettingValue).mockImplementation((key: string) =>
			key === 'shellEnvVars' ? { EDITOR: 'vim', LOG_LEVEL: 'info' } : undefined
		);
		vi.mocked(getSessionById).mockReturnValue(
			agent({ customEnvVars: { LOG_LEVEL: 'debug' } } as Partial<SessionInfo>)
		);

		showAgent('agent-123', { json: true });

		expect(shown().effectiveEnv).toEqual([
			{ key: 'EDITOR', value: 'vim', source: 'global', shadowedBy: [], secret: false },
			{
				key: 'LOG_LEVEL',
				value: 'debug',
				source: 'session',
				shadowedBy: ['global'],
				secret: false,
			},
		]);
	});

	it('uses the provider-level variables only for an agent with none of its own', () => {
		vi.mocked(readAgentConfigValue).mockReturnValue({ PROVIDER_FLAG: '1' });
		vi.mocked(getSessionById).mockReturnValue(agent());
		showAgent('agent-123', { json: true });
		expect(shown().effectiveEnv).toEqual([
			{ key: 'PROVIDER_FLAG', value: '1', source: 'agent', shadowedBy: [], secret: false },
		]);
		expect(readAgentConfigValue).toHaveBeenCalledWith('claude-code', 'customEnvVars');

		consoleSpy.mockClear();
		// The agent's own record REPLACES the provider-level set.
		vi.mocked(getSessionById).mockReturnValue(
			agent({ customEnvVars: { OWN: 'x' } } as Partial<SessionInfo>)
		);
		showAgent('agent-123', { json: true });
		expect(shown().effectiveEnv.map((entry: { key: string }) => entry.key)).toEqual(['OWN']);
	});

	it('masks a secret value, keeping only its tail', () => {
		vi.mocked(getSessionById).mockReturnValue(
			agent({
				customEnvVars: { ANTHROPIC_API_KEY: 'sk-ant-0123456789abcdef', REGION: 'us-east-1' },
			} as Partial<SessionInfo>)
		);

		showAgent('agent-123', { json: true });

		const out = shown();
		expect(out.customEnvVars.REGION).toBe('us-east-1');
		expect(out.customEnvVars.ANTHROPIC_API_KEY).not.toContain('sk-ant-0123456789');
		expect(out.customEnvVars.ANTHROPIC_API_KEY.endsWith('cdef')).toBe(true);
		const key = out.effectiveEnv.find(
			(entry: { key: string }) => entry.key === 'ANTHROPIC_API_KEY'
		);
		expect(key.secret).toBe(true);
		expect(key.value).toBe(out.customEnvVars.ANTHROPIC_API_KEY);
		// Nowhere in the output, in any field.
		expect(String(consoleSpy.mock.calls[0][0])).not.toContain('sk-ant-0123456789abcdef');
	});

	it('prints a secret in full only when --show-secrets is passed', () => {
		vi.mocked(getSessionById).mockReturnValue(
			agent({
				customEnvVars: { ANTHROPIC_API_KEY: 'sk-ant-0123456789abcdef' },
			} as Partial<SessionInfo>)
		);

		showAgent('agent-123', { json: true, showSecrets: true });

		const out = shown();
		expect(out.customEnvVars.ANTHROPIC_API_KEY).toBe('sk-ant-0123456789abcdef');
		expect(out.effectiveEnv[0].value).toBe('sk-ant-0123456789abcdef');
	});

	it('lists the variables that are parked, which are never spawned with', () => {
		vi.mocked(getSessionById).mockReturnValue(
			agent({
				customEnvVars: { LIVE: '1' },
				customEnvVarsDisabled: { PARKED_TOKEN: 'abcdefghijklmnop' },
			} as Partial<SessionInfo>)
		);

		showAgent('agent-123', { json: true });

		const out = shown();
		expect(Object.keys(out.parkedEnvVars)).toEqual(['PARKED_TOKEN']);
		expect(out.parkedEnvVars.PARKED_TOKEN).not.toBe('abcdefghijklmnop');
		expect(out.effectiveEnv.map((entry: { key: string }) => entry.key)).toEqual(['LIVE']);
	});

	it('reports no variables as null and an empty list, not as an error', () => {
		vi.mocked(getSessionById).mockReturnValue(agent());
		showAgent('agent-123', { json: true });
		expect(shown()).toMatchObject({ customEnvVars: null, parkedEnvVars: null, effectiveEnv: [] });
	});
});
