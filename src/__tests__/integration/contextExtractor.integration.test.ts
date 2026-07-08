import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AITab, LogEntry, Session } from '../../renderer/types';
import type { ContextSource } from '../../renderer/types/contextMerge';
import {
	calculateTotalTokens,
	countContextTokens,
	estimateTokenCount,
	estimateTextTokenCount,
	extractStoredSessionContext,
	extractTabContext,
	findDuplicateContent,
	formatLogsForClipboard,
	formatLogsForGrooming,
	getContextSummary,
	parseGroomedOutput,
} from '../../renderer/utils/contextExtractor';
import { logger } from '../../renderer/utils/logger';

const readStoredSession = vi.fn();
let originalMaestro: unknown;

beforeEach(() => {
	originalMaestro = (window as any).maestro;
	(window as any).maestro = {
		agentSessions: {
			read: readStoredSession,
		},
	};
	readStoredSession.mockReset();
	vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
	(window as any).maestro = originalMaestro;
	vi.restoreAllMocks();
});

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Workspace',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo',
		fullPath: '/repo',
		projectRoot: '/repo',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		...overrides,
	} as Session;
}

function tab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: 'agent-session-abcdef',
		name: 'Review',
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 1_000,
		state: 'idle',
		...overrides,
	};
}

function log(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		id: `log-${overrides.source ?? 'user'}-${overrides.timestamp ?? 1}`,
		timestamp: overrides.timestamp ?? 1,
		source: overrides.source ?? 'user',
		text: overrides.text ?? 'message',
		...overrides,
	};
}

function context(overrides: Partial<ContextSource> = {}): ContextSource {
	return {
		type: 'tab',
		sessionId: 'session-1',
		projectRoot: '/repo',
		name: 'Context',
		logs: [],
		agentType: 'claude-code',
		...overrides,
	};
}

describe('contextExtractor integration', () => {
	it('extracts active-tab context without mutating the source tab', () => {
		const sourceLogs = [log({ text: 'Original prompt' })];
		const sourceTab = tab({
			name: null,
			agentSessionId: '1234567890abcdef',
			logs: sourceLogs,
			usageStats: {
				inputTokens: 100,
				outputTokens: 200,
				cacheReadInputTokens: 50,
				cacheCreationInputTokens: 25,
				costUsd: 0.01,
			},
		});

		const extracted = extractTabContext(sourceTab, 'Project Alpha', session());
		extracted.logs.push(log({ text: 'local mutation' }));
		extracted.usageStats!.inputTokens = 999;

		expect(extracted).toMatchObject({
			type: 'tab',
			sessionId: 'session-1',
			tabId: 'tab-1',
			agentSessionId: '1234567890abcdef',
			projectRoot: '/repo',
			name: 'Project Alpha / 12345678',
			agentType: 'claude-code',
		});
		expect(sourceLogs).toHaveLength(1);
		expect(sourceTab.usageStats?.inputTokens).toBe(100);

		expect(
			extractTabContext(tab({ name: null, agentSessionId: null }), 'Project Alpha', session()).name
		).toBe('Project Alpha / New Tab');
	});

	it('extracts stored-session context through the Electron bridge and handles unavailable sessions', async () => {
		const longUserMessage =
			'Please summarize the architecture risks in this stored session. '.repeat(2);
		readStoredSession.mockResolvedValueOnce({
			messages: [
				{
					type: 'message',
					role: 'user',
					content: longUserMessage,
					timestamp: '2026-05-01T10:00:00.000Z',
					uuid: 'msg-user',
				},
				{
					type: 'message',
					role: 'assistant',
					content: 'The largest risk is hidden coupling.',
					timestamp: '2026-05-01T10:01:00.000Z',
					uuid: 'msg-assistant',
				},
				{
					type: 'system',
					content: 'Visible system note',
					timestamp: '2026-05-01T10:02:00.000Z',
					uuid: 'msg-system',
				},
				{
					type: 'error',
					content: 'Tool failed',
					timestamp: '2026-05-01T10:03:00.000Z',
					uuid: 'msg-error',
				},
				{
					type: 'tool_result',
					content: 'Command output',
					timestamp: '2026-05-01T10:04:00.000Z',
					uuid: '',
				},
			],
			total: 5,
			hasMore: false,
		});

		const extracted = await extractStoredSessionContext(
			'claude-code',
			'/repo',
			'stored-session-123456'
		);

		expect(readStoredSession).toHaveBeenCalledWith('claude-code', '/repo', 'stored-session-123456');
		expect(extracted?.name).toBe('Please summarize the architecture risks in this...');
		expect(extracted?.logs.map((entry) => entry.source)).toEqual([
			'user',
			'ai',
			'system',
			'error',
			'stdout',
		]);
		expect(extracted?.logs[4]).toMatchObject({
			id: 'stored-4',
			text: 'Command output',
		});

		readStoredSession.mockResolvedValueOnce(null);
		await expect(
			extractStoredSessionContext('claude-code', '/repo', 'missing')
		).resolves.toBeNull();

		readStoredSession.mockResolvedValueOnce({ messages: [], total: 0, hasMore: false });
		await expect(extractStoredSessionContext('claude-code', '/repo', 'empty')).resolves.toBeNull();

		readStoredSession.mockRejectedValueOnce(new Error('bridge failed'));
		await expect(extractStoredSessionContext('claude-code', '/repo', 'broken')).resolves.toBeNull();
		expect(logger.error).toHaveBeenCalledWith(
			'Failed to extract stored session context:',
			undefined,
			expect.any(Error)
		);

		readStoredSession.mockResolvedValueOnce({
			messages: [
				{
					type: 'user',
					content: 'Short prompt',
					timestamp: '2026-05-01T10:00:00.000Z',
					uuid: 'short-user',
				},
			],
			total: 1,
			hasMore: false,
		});
		await expect(
			extractStoredSessionContext('claude-code', '/repo', 'short')
		).resolves.toMatchObject({
			name: 'Short prompt',
		});

		readStoredSession.mockResolvedValueOnce({
			messages: [
				{
					type: 'system',
					content: 'No user message',
					timestamp: '2026-05-01T10:00:00.000Z',
					uuid: 'system-only',
				},
			],
			total: 1,
			hasMore: false,
		});
		await expect(
			extractStoredSessionContext('claude-code', '/repo', 'session-without-user')
		).resolves.toMatchObject({
			name: 'Session session-',
		});
	});

	it('formats logs for grooming while stripping file dumps and over-budget images', () => {
		const fullFile = 'line\n'.repeat(20);
		const shortSnippet = 'const answer = 42;\n';
		const shortRead = 'line\n'.repeat(3);
		const formatted = formatLogsForGrooming(
			[
				log({ source: 'system', text: 'Connecting...' }),
				log({ source: 'system', text: 'Visible system message' }),
				log({ source: 'error', text: 'Visible error message' }),
				log({ source: 'stdout', text: 'Visible output message' }),
				log({ source: 'user', text: 'How should this be refactored?' }),
				log({
					source: 'ai',
					text: `Large file:\n\`\`\`typescript:src/app.ts\n${fullFile}\`\`\`\nConfig dump:\n\`\`\`:config/settings.json\n${fullFile}\`\`\`\nSmall snippet:\n\`\`\`typescript:src/snippet.ts\n${shortSnippet}\`\`\``,
					images: ['/old.png'],
					timestamp: 1,
				}),
				log({
					source: 'stderr',
					text: `Reading /repo/src/main.ts:\n\`\`\`typescript\n${'read\n'.repeat(16)}\`\`\`\nFile: /repo/src/small.ts:\n\`\`\`typescript\n${shortRead}\`\`\``,
					images: ['/new.png'],
					timestamp: 2,
				}),
				log({ source: 'custom' as LogEntry['source'], text: 'Custom source' }),
				log({ source: 'ai', text: '   ' }),
			],
			{ maxImageTokens: 1500 }
		);

		expect(formatted).not.toContain('Connecting');
		expect(formatted).toContain('## User');
		expect(formatted).toContain('## Assistant');
		expect(formatted).toContain('## System');
		expect(formatted).toContain('## Error');
		expect(formatted).toContain('## Output');
		expect(formatted).toContain('## Error Output');
		expect(formatted).toContain('## Message');
		expect(formatted).toContain('[File: src/app.ts');
		expect(formatted).toContain('```[File: config/settings.json');
		expect(formatted).toContain('[Read: /repo/src/main.ts');
		expect(formatted).toContain(shortRead);
		expect(formatted).toContain(shortSnippet);
		expect(formatted).toContain('[Note: 1 image(s) stripped');
		expect(formatLogsForGrooming([log({ text: 'No images here' })])).not.toContain(
			'image(s) stripped'
		);
		expect(
			formatLogsForGrooming([log({ text: 'Single image', images: ['/only.png'] })], {
				maxImageTokens: 5000,
			})
		).not.toContain('image(s) stripped');
		expect(
			formatLogsForGrooming([log({ text: 'Two images', images: ['/one.png', '/two.png'] })], {
				maxImageTokens: 0,
			})
		).toContain('[Note: 2 image(s) stripped');
	});

	it('parses groomed output back into conversation logs', () => {
		const parsed = parseGroomedOutput(`## User Input
Question

## AI Response
Answer

## Error Log
Failure

## System Info
Status

## Command Output
stdout

## Summary
Default ai`);

		expect(parsed.map((entry) => entry.source)).toEqual([
			'user',
			'ai',
			'error',
			'system',
			'stdout',
			'ai',
		]);
		expect(parseGroomedOutput('Single unstructured summary')[0]).toMatchObject({
			source: 'ai',
			text: 'Single unstructured summary',
		});
		expect(parseGroomedOutput('   \n\n   ')).toEqual([]);
	});

	it('calculates estimated and accurate token counts across contexts', async () => {
		const usageContext = context({
			usageStats: {
				inputTokens: 100,
				outputTokens: 200,
				cacheReadInputTokens: 50,
				cacheCreationInputTokens: 25,
				costUsd: 0,
			},
		});
		const logContext = context({
			logs: [log({ text: 'abcd', images: ['/one.png', '/two.png'] }), log({ text: 'abcdefgh' })],
		});
		const partialStatsContext = context({
			usageStats: {
				inputTokens: 10,
				costUsd: 0,
			},
		});
		const missingInputStatsContext = context({
			usageStats: {
				outputTokens: 5,
				costUsd: 0,
			},
		});
		const noLogsContext = context({ logs: undefined });

		expect(estimateTextTokenCount('abcd')).toBe(1);
		expect(estimateTextTokenCount('abcde')).toBe(2);
		expect(estimateTokenCount(usageContext)).toBe(175);
		expect(estimateTokenCount(logContext)).toBe(3003);
		expect(estimateTokenCount(partialStatsContext)).toBe(10);
		expect(estimateTokenCount(missingInputStatsContext)).toBe(0);
		expect(estimateTokenCount(noLogsContext)).toBe(0);
		await expect(countContextTokens(usageContext)).resolves.toBe(175);
		await expect(countContextTokens(logContext)).resolves.toBeGreaterThan(3000);
		await expect(countContextTokens(partialStatsContext)).resolves.toBe(10);
		await expect(countContextTokens(missingInputStatsContext)).resolves.toBe(0);
		await expect(countContextTokens(noLogsContext)).resolves.toBe(0);
		expect(calculateTotalTokens([usageContext, logContext])).toBe(3178);
	});

	it('detects exact and partial duplicate content across context sources', () => {
		const longText =
			'This duplicated architecture note is intentionally long enough for duplicate detection. '.repeat(
				3
			);
		const duplicateBlock = '```typescript\n' + 'const coupled = true;\n'.repeat(20) + '```';
		const smallBlock = '```typescript\nconst x = 1;\n```';

		const result = findDuplicateContent([
			context({
				name: 'One',
				logs: [
					log({ text: longText }),
					log({ text: `First code reference:\n${duplicateBlock}` }),
					log({ text: `Small example:\n${smallBlock}` }),
					log({ text: 'short' }),
				],
			}),
			context({
				name: 'Two',
				logs: [
					log({ text: `  ${longText.replace(/ /g, '   ')}  ` }),
					log({ text: `Second code reference:\n${duplicateBlock}` }),
					log({ text: `Same small example:\n${smallBlock}` }),
				],
			}),
			context({ name: 'No logs', logs: undefined }),
		]);

		expect(result.duplicates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sourceIndex: 1 }),
				expect.objectContaining({
					sourceIndex: 1,
					content: expect.stringContaining('[Code block:'),
				}),
			])
		);
		expect(result.estimatedSavings).toBeGreaterThan(0);

		expect(
			findDuplicateContent([
				context({ logs: [log({ text: 'short' })] }),
				context({ logs: [log({ text: 'short' })] }),
			])
		).toEqual({ duplicates: [], estimatedSavings: 0 });
	});

	it('formats clipboard text and summarizes context groups', () => {
		const logs: LogEntry[] = [
			log({ source: 'user', text: 'Question' }),
			log({ source: 'ai', text: 'Answer' }),
			log({ source: 'stdout', text: 'Final output' }),
			log({ source: 'system', text: 'hidden' }),
			log({ source: 'error', text: 'failure' }),
			log({ source: 'user', text: '   ' }),
		];

		expect(formatLogsForClipboard(logs)).toBe(
			'USER:\nQuestion\n\nASSISTANT:\nAnswer\n\nASSISTANT:\nFinal output'
		);

		const summary = getContextSummary([
			context({
				agentType: 'claude-code',
				logs: [log(), log()],
				usageStats: {
					inputTokens: 100,
					outputTokens: 100,
					cacheReadInputTokens: 50,
					cacheCreationInputTokens: 25,
					costUsd: 0,
				},
			}),
			context({
				type: 'session',
				sessionId: 'session-2',
				agentType: 'opencode',
				logs: [log()],
				usageStats: {
					inputTokens: 200,
					outputTokens: 200,
					cacheReadInputTokens: 75,
					cacheCreationInputTokens: 25,
					costUsd: 0,
				},
			}),
			context({
				agentType: 'claude-code',
				logs: undefined,
			}),
		]);

		expect(summary).toEqual({
			totalSources: 3,
			totalLogs: 3,
			estimatedTokens: 475,
			byAgent: {
				'claude-code': 2,
				opencode: 1,
			},
		});
	});
});
