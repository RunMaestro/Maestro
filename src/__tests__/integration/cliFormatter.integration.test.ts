import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	formatAgentDetail,
	formatAgents,
	formatError,
	formatGroups,
	formatInfo,
	formatPlaybookDetail,
	formatPlaybooks,
	formatPlaybooksByAgent,
	formatRunEvent,
	formatSessions,
	formatSettingDetail,
	formatSettingsList,
	formatSuccess,
	formatWarning,
	type AgentDetailDisplay,
	type AgentDisplay,
	type GroupDisplay,
	type PlaybookDetailDisplay,
	type PlaybookDisplay,
	type PlaybooksByAgent,
	type RunEvent,
	type SessionDisplay,
	type SettingDisplay,
} from '../../cli/output/formatter';

const originalIsTTY = process.stdout.isTTY;

describe('CLI formatter integration', () => {
	afterEach(() => {
		Object.defineProperty(process.stdout, 'isTTY', {
			value: originalIsTTY,
			writable: true,
			configurable: true,
		});
		vi.resetModules();
	});

	it('formats group, agent, playbook, and grouped playbook listings from realistic CLI data', () => {
		const groups: GroupDisplay[] = [
			{ id: 'group-ui', name: 'Frontend', emoji: '*' },
			{ id: 'group-api', name: 'Backend' },
		];
		const agents: AgentDisplay[] = [
			{
				id: 'agent-claude-123456',
				name: 'Claude Runner',
				toolType: 'claude-code',
				cwd: '/workspace/a/path/that/is/intentionally/long/enough/to/be/truncated/by/the/formatter',
				autoRunFolderPath: '/workspace/playbooks',
			},
		];
		const playbooks: PlaybookDisplay[] = [
			{
				id: 'playbook-abcdefgh',
				name: 'Release Sweep',
				sessionId: 'session-1',
				loopEnabled: true,
				maxLoops: 3,
				documents: [
					{ filename: 'phase-1.md', resetOnCompletion: true },
					{ filename: 'phase-2.md', resetOnCompletion: false },
				],
			},
		];
		const grouped: PlaybooksByAgent[] = [
			{ agentId: 'agent-empty', agentName: 'Idle Agent', playbooks: [] },
			{ agentId: agents[0].id, agentName: agents[0].name, playbooks },
		];

		expect(formatGroups([])).toContain('No groups found');
		expect(formatAgents([])).toContain('No agents found');
		expect(formatPlaybooks([])).toContain('No playbooks found');
		expect(
			formatPlaybooksByAgent([{ agentId: 'agent-empty', agentName: 'Empty', playbooks: [] }])
		).toContain('No playbooks found');

		const groupOutput = formatGroups(groups);
		const agentOutput = formatAgents(agents, 'Frontend');
		const playbookOutput = formatPlaybooks(playbooks, agents[0].name, '/workspace/playbooks');
		const groupedOutput = formatPlaybooksByAgent(grouped);

		expect(groupOutput).toContain('GROUPS');
		expect(groupOutput).toContain('Frontend');
		expect(groupOutput).toContain('Backend');
		expect(groupOutput).toContain('📁');
		expect(agentOutput).toContain('AGENTS');
		expect(agentOutput).toContain('in Frontend');
		expect(agentOutput).toContain('[Auto Run]');
		expect(agentOutput).toContain('…');
		expect(playbookOutput).toContain('PLAYBOOKS');
		expect(playbookOutput).toContain('2 docs');
		expect(playbookOutput).toContain('loop (max 3)');
		expect(groupedOutput).toContain('1 across 1 agent');
		expect(groupedOutput).toContain('Release Sweep');
	});

	it('formats playbook details with loop settings, pending tasks, truncation, and reset markers', () => {
		const detail: PlaybookDetailDisplay = {
			id: 'playbook-detail-123',
			name: 'Hardening Run',
			agentId: 'agent-detail-123456',
			agentName: 'Codex Agent',
			folderPath: '/workspace/docs',
			loopEnabled: true,
			maxLoops: null,
			prompt: 'Review each checked task.\nKeep changes focused.',
			documents: [
				{
					filename: 'phase-hardening.md',
					resetOnCompletion: true,
					taskCount: 6,
					tasks: [
						'One',
						'Two',
						'Three',
						'Four',
						'Five',
						'Sixth task should be summarized by the overflow line',
					],
				},
				{
					filename: 'empty.md',
					resetOnCompletion: false,
					taskCount: 0,
					tasks: [],
				},
			],
		};

		const output = formatPlaybookDetail(detail);

		expect(output).toContain('PLAYBOOK');
		expect(output).toContain('Hardening Run');
		expect(output).toContain('enabled');
		expect(output).toContain('∞');
		expect(output).toContain('2 files, 6 pending tasks');
		expect(output).toContain('phase-hardening.md');
		expect(output).toContain('reset');
		expect(output).toContain('... and 1 more');
		expect(output).toContain('empty.md');
		expect(output).toContain('(0 tasks)');
	});

	it('formats each run event variant, including debug and dry-run branches', () => {
		const base = Date.UTC(2026, 4, 25, 12, 0, 0);
		const events: RunEvent[] = [
			{ type: 'start', timestamp: base },
			{ type: 'document_start', timestamp: base, document: 'phase.md', taskCount: 2 },
			{ type: 'task_start', timestamp: base, taskIndex: 0, task: 'Implement the next task' },
			{ type: 'task_preview', timestamp: base, taskIndex: 1, task: 'Preview task' },
			{
				type: 'task_complete',
				timestamp: base,
				success: true,
				elapsedMs: 1530,
				summary: 'Finished successfully',
			},
			{
				type: 'task_complete',
				timestamp: base,
				success: false,
				elapsedMs: 2000,
				fullResponse: 'Full response first line\nMore details',
				agentSessionId: 'session-abcdef',
			},
			{ type: 'history_write', timestamp: base, entryId: 'history-abcdef' },
			{ type: 'document_complete', timestamp: base, tasksCompleted: 2 },
			{ type: 'loop_complete', timestamp: base, iteration: 4 },
			{ type: 'complete', timestamp: base, dryRun: true, wouldProcess: 7 },
			{
				type: 'complete',
				timestamp: base,
				dryRun: false,
				totalTasksCompleted: 3,
				totalElapsedMs: 9000,
			},
			{ type: 'error', timestamp: base, message: 'Failed to spawn agent' },
			{ type: 'debug', timestamp: base, category: 'config', message: 'Loaded config' },
			{ type: 'debug', timestamp: base, category: 'other', message: 'Fallback category' },
			{
				type: 'verbose',
				timestamp: base,
				category: 'prompt',
				document: 'phase.md',
				taskIndex: 2,
				prompt: 'Prompt body',
			},
			{ type: 'unknown-event', timestamp: base },
		];

		const output = events.map((event) => formatRunEvent(event, { debug: true })).join('\n');

		expect(output).toContain('Starting playbook run');
		expect(output).toContain('phase.md');
		expect(output).toContain('Task 1: Implement the next task');
		expect(output).toContain('2. Preview task');
		expect(output).toContain('Finished successfully');
		expect(output).toContain('Full response first line');
		expect(output).toContain('[session-');
		expect(output).toContain('[history] Wrote history entry');
		expect(output).toContain('Dry run complete');
		expect(output).toContain('Playbook complete');
		expect(output).toContain('Error: Failed to spawn agent');
		expect(output).toContain('[config]');
		expect(output).toContain('[other]');
		expect(output).toContain('Prompt body');
		expect(output).toContain('unknown-event');
	});

	it('formats agent detail stats, token units, durations, and recent history rows', () => {
		const agent: AgentDetailDisplay = {
			id: 'agent-detail-abcdef',
			name: 'Release Agent',
			toolType: 'codex',
			cwd: '/workspace/app',
			projectRoot: '/workspace',
			groupName: 'Release',
			autoRunFolderPath: '/workspace/playbooks',
			stats: {
				historyEntries: 3,
				successCount: 2,
				failureCount: 1,
				totalInputTokens: 1530,
				totalOutputTokens: 2_500_000,
				totalCacheReadTokens: 999,
				totalCacheCreationTokens: 15_500,
				totalCost: 1.23456,
				totalElapsedMs: 3_720_000,
			},
			recentHistory: [
				{
					id: 'history-ok',
					type: 'prompt',
					timestamp: Date.UTC(2026, 4, 25, 13, 0, 0),
					summary: 'Completed release validation',
					success: true,
					elapsedTimeMs: 500,
					cost: 0.1234,
				},
				{
					id: 'history-failed',
					type: 'error',
					timestamp: Date.UTC(2026, 4, 25, 13, 5, 0),
					summary: 'Failed release validation',
					success: false,
					elapsedTimeMs: 90_000,
				},
				{
					id: 'history-pending',
					type: 'note',
					timestamp: Date.UTC(2026, 4, 25, 13, 10, 0),
					summary: 'Pending status',
				},
			],
		};

		const output = formatAgentDetail(agent);
		const emptyStats = formatAgentDetail({
			...agent,
			groupName: undefined,
			autoRunFolderPath: undefined,
			stats: {
				...agent.stats,
				historyEntries: 0,
				successCount: 0,
				failureCount: 0,
				totalElapsedMs: 900,
			},
			recentHistory: [],
		});

		expect(output).toContain('AGENT');
		expect(output).toContain('Release Agent');
		expect(output).toContain('67% success rate');
		expect(output).toContain('$1.2346');
		expect(output).toContain('1.0h');
		expect(output).toContain('1.5K');
		expect(output).toContain('2.5M');
		expect(output).toContain('15.5K');
		expect(output).toContain('RECENT HISTORY');
		expect(output).toContain('Completed release validation');
		expect(output).toContain('$0.1234');
		expect(output).toContain('500ms');
		expect(output).toContain('1.5m');
		expect(emptyStats).toContain('0% success rate');
		expect(emptyStats).not.toContain('RECENT HISTORY');
	});

	it('formats sessions with search empty states, cost, star, duration, and preview handling', () => {
		const sessions: SessionDisplay[] = [
			{
				sessionId: 'session-starred',
				sessionName: 'Important Session',
				modifiedAt: '2026-05-25T14:00:00.000Z',
				firstMessage: 'First line\nSecond line',
				messageCount: 12,
				costUsd: 0.45,
				durationSeconds: 45,
				starred: true,
			},
			{
				sessionId: 'session-unnamed',
				modifiedAt: '2026-05-25T15:00:00.000Z',
				firstMessage: '',
				messageCount: 3,
				costUsd: 0,
				durationSeconds: 3661,
			},
		];

		expect(formatSessions([], 'Codex', 0, 0)).toContain('No sessions found');
		expect(formatSessions([], 'Codex', 5, 0, 'deploy')).toContain('No sessions matching "deploy"');

		const output = formatSessions(sessions, 'Codex', 5, 2, 'session');

		expect(output).toContain('SESSIONS');
		expect(output).toContain('2 matching of 5 total');
		expect(output).toContain('★ Important Session');
		expect(output).toContain('$0.4500');
		expect(output).toContain('45s');
		expect(output).toContain('First line Second line');
		expect(output).toContain('(unnamed)');
		expect(output).toContain('$0');
		expect(output).toContain('1.0h');
	});

	it('formats settings list and details across sensitive, default, verbose, and compact values', () => {
		const settings: SettingDisplay[] = [
			{
				key: 'apiKey',
				value: 'secret-value',
				type: 'string',
				category: 'auth',
				description: 'API key used by CLI commands',
				defaultValue: '',
				isDefault: false,
				sensitive: true,
			},
			{
				key: 'enabled',
				value: true,
				type: 'boolean',
				category: 'auth',
				defaultValue: false,
				isDefault: true,
			},
			{
				key: 'retries',
				value: 3,
				type: 'number',
				category: 'runtime',
				defaultValue: 1,
				isDefault: false,
			},
			{
				key: 'emptyString',
				value: '',
				type: 'string',
				category: 'runtime',
				defaultValue: 'fallback',
				isDefault: false,
			},
			{
				key: 'emptyList',
				value: [],
				type: 'array',
				category: 'runtime',
				defaultValue: ['one'],
				isDefault: false,
			},
			{
				key: 'nested',
				value: { path: '/workspace', enabled: false },
				type: 'object',
				category: 'runtime',
				defaultValue: null,
				isDefault: false,
			},
			{
				key: 'missing',
				value: undefined,
				type: 'string',
				category: 'runtime',
				defaultValue: null,
				isDefault: false,
			},
		];

		expect(formatSettingsList([])).toContain('No settings found');
		expect(formatSettingsList(settings, { keysOnly: true })).toContain('apiKey');

		const output = formatSettingsList(settings, { verbose: true, showDefaults: true });
		const detail = formatSettingDetail(settings[0]);
		const nullDetail = formatSettingDetail({ ...settings[0], key: 'nullable', value: null });

		expect(output).toContain('SETTINGS');
		expect(output).toContain('auth');
		expect(output).toContain('***');
		expect(output).toContain('true');
		expect(output).toContain('(default)');
		expect(output).toContain('default: 1');
		expect(output).toContain('3');
		expect(output).toContain('""');
		expect(output).toContain('[]');
		expect(output).toContain('{"path":"/workspace","enabled":false}');
		expect(output).toContain('undefined');
		expect(detail).toContain('SETTING');
		expect(detail).toContain('API key used by CLI commands');
		expect(nullDetail).toContain('null');
	});

	it('formats user-facing status messages with and without TTY color support', async () => {
		expect(formatError('Bad input')).toContain('Error: Bad input');
		expect(formatSuccess('Saved')).toContain('Saved');
		expect(formatInfo('Details')).toContain('Details');
		expect(formatWarning('Careful')).toContain('Careful');

		Object.defineProperty(process.stdout, 'isTTY', {
			value: true,
			writable: true,
			configurable: true,
		});
		vi.resetModules();

		const ttyFormatter = await import('../../cli/output/formatter');

		expect(ttyFormatter.formatError('Colored')).toContain('\x1b[31m');
		expect(ttyFormatter.formatSuccess('Colored')).toContain('\x1b[32m');
		expect(ttyFormatter.formatInfo('Colored')).toContain('\x1b[34m');
		expect(ttyFormatter.formatWarning('Colored')).toContain('\x1b[33m');
	});
});
