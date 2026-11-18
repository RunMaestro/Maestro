import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	extractTabContext,
	extractStoredSessionContext,
	formatLogsForGrooming,
	formatLogsForClipboard,
	hasThinkingEntries,
	parseGroomedOutput,
	estimateTokenCount,
	estimateTextTokenCount,
	findDuplicateContent,
	calculateTotalTokens,
	getContextSummary,
	countContextTokens,
	formatLogsForContextInjection,
} from '../../../renderer/utils/contextExtractor';
import type { AITab, LogEntry, Session } from '../../../renderer/types';
import type { ContextSource } from '../../../renderer/types/contextMerge';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';
import type { SessionMessagesResult } from '../../../main/agents/session-storage';
import type { NativeSessionBinding } from '../../../shared/maestro-lib/agents/providerSwap';
import { getDeclaredTranslationDirection } from '../../../shared/maestro-lib/translation/support';

// Thin wrapper: context extraction tests assert against the default id
// 'session-123', so preserve that default via the shared factory.
const createMockSession = (overrides: Partial<Session> = {}): Session =>
	baseCreateMockSession({ id: 'session-123', ...overrides });

// Mock window.maestro for extractStoredSessionContext tests
const mockAgentSessionsRead = vi.fn();
vi.stubGlobal('window', {
	maestro: {
		agentSessions: {
			read: mockAgentSessionsRead,
		},
	},
});

// Helper to create a mock tab
function createMockTab(overrides: Partial<AITab> = {}): AITab {
	return createMockAITab({
		id: 'tab-123',
		agentSessionId: 'agent-session-456',
		name: 'Test Tab',
		...overrides,
	});
}

// Helper to create a mock log entry
function createMockLog(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		id: `log-${Math.random().toString(36).slice(2)}`,
		timestamp: Date.now(),
		source: 'user',
		text: 'Test message',
		...overrides,
	};
}

describe('extractStoredSessionContext: Grok export', () => {
	let binding: Extract<NativeSessionBinding, { state: 'bound' }>;
	let result: SessionMessagesResult;
	let options: NonNullable<Parameters<typeof extractStoredSessionContext>[3]>;

	beforeEach(() => {
		binding = {
			version: 1,
			state: 'bound',
			provider: 'grok',
			nativeSessionId: 'native-shared',
			accountRef: 'account-a',
			host: { kind: 'local', identity: 'fixture-machine' },
			cwd: '/fixture/project',
		};
		options = { ownerAgentId: 'owner-a', nativeSessionBinding: binding };
		result = {
			nativeSessionBinding: binding,
			source: { provider: 'grok', status: 'available' },
			messages: [
				{
					type: 'user',
					role: 'user',
					content: 'Selected account content',
					timestamp: '',
					uuid: 'native-line-1',
					native: { provider: 'grok', line: 1 },
				},
			],
			total: 1,
			hasMore: false,
		};
		mockAgentSessionsRead.mockReset().mockResolvedValue(result);
	});

	it.each(['local', 'ssh'] as const)(
		'exports only the selected %s account with a colliding native ID',
		async (kind) => {
			const selected = { ...binding, host: { kind, identity: `fixture-${kind}` } };
			const other = { ...selected, accountRef: 'account-b' };
			mockAgentSessionsRead.mockImplementation(async (_provider, _cwd, _id, readOptions) => ({
				...result,
				nativeSessionBinding: readOptions.ownerAgentId === 'owner-a' ? selected : other,
				messages: [{ ...result.messages[0], content: `${readOptions.ownerAgentId} content` }],
			}));
			for (const [ownerAgentId, nativeSessionBinding] of [
				['owner-a', selected],
				['owner-b', other],
			] as const) {
				const sshRemoteId = kind === 'ssh' ? 'fixture-remote' : undefined;
				const context = await extractStoredSessionContext(
					'grok',
					binding.cwd,
					binding.nativeSessionId,
					{
						ownerAgentId,
						nativeSessionBinding,
						sshRemoteId,
					}
				);
				expect(mockAgentSessionsRead).toHaveBeenLastCalledWith(
					'grok',
					binding.cwd,
					'native-shared',
					{
						ownerAgentId,
						nativeSessionBinding,
						includeNativeRecords: true,
						offset: 0,
						limit: 1000,
					},
					sshRemoteId
				);
				expect(context).toMatchObject({
					type: 'session',
					sessionId: ownerAgentId,
					agentSessionId: 'native-shared',
					projectRoot: binding.cwd,
					agentType: 'grok',
				});
				expect(context!.logs[1].text).toContain(`${ownerAgentId} content`);
				expect(context!.logs[1].text).not.toContain(
					`${ownerAgentId === 'owner-a' ? 'owner-b' : 'owner-a'} content`
				);
				expect(context!.logs[0].text).toContain(nativeSessionBinding.accountRef);
			}
			expect(mockAgentSessionsRead).toHaveBeenCalledTimes(2);
		}
	);

	it.each([undefined, '', '  '])(
		'refuses missing/blank owner %j before reading',
		async (ownerAgentId) => {
			await expect(
				extractStoredSessionContext('grok', binding.cwd, 'native-shared', { ownerAgentId })
			).rejects.toThrow('Select the owning Grok agent');
			expect(mockAgentSessionsRead).not.toHaveBeenCalled();
		}
	);

	it.each(['missing', 'unknown', 'account', 'host', 'cwd', 'native ID', 'provider'])(
		'refuses nonempty content with %s ownership mismatch',
		async (mismatch) => {
			if (mismatch === 'missing') result.nativeSessionBinding = undefined;
			else if (mismatch === 'unknown')
				result.nativeSessionBinding = { version: 1, state: 'unknown', reason: 'unobserved' };
			else
				result.nativeSessionBinding = {
					...binding,
					...(mismatch === 'account' ? { accountRef: 'account-b' } : {}),
					...(mismatch === 'host'
						? { host: { kind: 'ssh' as const, identity: 'different-host' } }
						: {}),
					...(mismatch === 'cwd' ? { cwd: '/other/project' } : {}),
					...(mismatch === 'native ID' ? { nativeSessionId: 'other-native' } : {}),
					...(mismatch === 'provider' ? { provider: 'codex' as const } : {}),
				};
			await expect(
				extractStoredSessionContext('grok', binding.cwd, 'native-shared', options)
			).rejects.toThrow('ownership is unverified');
			expect(mockAgentSessionsRead).toHaveBeenCalledTimes(1);
		}
	);

	it('accepts host-observed ownership without a retained binding', async () => {
		const context = await extractStoredSessionContext('grok', binding.cwd, 'native-shared', {
			ownerAgentId: 'owner-a',
		});
		expect(context!.logs[1].text).toContain('Selected account content');
		expect(context!.logs[0].text).toContain('account-a');
	});

	it.each(['missing', 'rejected'])(
		'propagates a %s read without falling back to another account',
		async (failure) => {
			if (failure === 'missing') mockAgentSessionsRead.mockResolvedValue(null);
			else mockAgentSessionsRead.mockRejectedValue(new Error('Selected account unavailable'));
			await expect(
				extractStoredSessionContext('grok', binding.cwd, 'native-shared', options)
			).rejects.toThrow(
				failure === 'missing' ? 'could not be read' : 'Selected account unavailable'
			);
			expect(mockAgentSessionsRead).toHaveBeenCalledTimes(1);
		}
	);

	it('preserves ordered, redacted tool/image evidence and unknown rows through both formatters', async () => {
		// Same inert sentinel as the canonical redaction suite, never a credential.
		const secret = 'sk-ABCDEFGHIJKLMNOP1234';
		const historicalFile = `\`\`\`ts:/fixture/removed.ts\n${'historical line\n'.repeat(20)}\`\`\``;
		result.source = { provider: 'grok', status: 'partial', reason: `truncated ${secret}` };
		result.nativeSessionBinding = { ...binding, accountRef: `fixture-${secret}` };
		options.nativeSessionBinding = result.nativeSessionBinding;
		result.messages = [
			{
				...result.messages[0],
				content: `Question ${secret}`,
				timestamp: '2026-10-31T12:00:00Z',
				imageReferences: [`/fixture/${secret}.png`],
				images: ['data:image/png;base64,SHOULD_NOT_LOAD'],
			},
			{
				type: 'backend_tool_call',
				role: 'assistant',
				uuid: 'call-line-2',
				timestamp: '',
				content: '',
				toolUse: [
					{
						id: 'call-7',
						name: 'read_file',
						arguments: { path: '/fixture/removed.ts', credential: secret },
					},
				],
				native: { provider: 'grok', line: 2, raw: 'PRIVATE_BACKEND_PAYLOAD' },
			},
			{
				type: 'tool_result',
				role: 'tool',
				uuid: 'result-line-3',
				timestamp: '',
				content: historicalFile,
				toolCallId: 'call-7',
				images: ['/fixture/legacy.png'],
				native: { provider: 'grok', line: 3 },
			},
			{
				type: 'assistant',
				role: 'assistant',
				uuid: 'answer-line-4',
				timestamp: '2026-10-30T12:00:00Z',
				content: 'Answer',
				native: {
					provider: 'grok',
					line: 4,
					raw: '{"reasoning_content":"PRIVATE_LEGACY_REASONING"}',
				},
			},
			{
				type: 'future_record',
				uuid: 'unknown-line-5',
				timestamp: '',
				content: '',
				native: {
					provider: 'grok',
					line: 5,
					raw: 'PRIVATE_UNKNOWN_PAYLOAD',
					issues: ['unknown-record-type'],
				},
			},
		];
		result.total = 5;
		const original = structuredClone(result);
		const context = await extractStoredSessionContext(
			'grok',
			binding.cwd,
			'native-shared',
			options
		);
		const logs = context!.logs;
		expect(logs.slice(1).map(({ id, source }) => [id, source])).toEqual([
			['native-line-1', 'user'],
			['call-line-2', 'tool'],
			['result-line-3', 'tool'],
			['answer-line-4', 'ai'],
			['unknown-line-5', 'stdout'],
		]);
		expect(logs[1].timestamp).toBe(Date.parse('2026-10-31T12:00:00Z'));
		expect(logs[4].timestamp).toBe(Date.parse('2026-10-30T12:00:00Z'));
		for (const index of [0, 2, 3, 5]) expect(logs[index].timestamp).toBeNaN();
		for (const log of logs)
			expect(Object.keys(log).sort()).toEqual(['id', 'source', 'text', 'timestamp']);
		expect(result).toEqual(original);
		const projection = logs.map((log) => log.text).join('\n');
		for (const text of [projection, formatLogsForClipboard(logs), formatLogsForGrooming(logs)]) {
			expect(text).toContain('not lossless native migration or a resumable session');
			expect(text).toContain('Raw native payloads and opaque reasoning are omitted');
			expect(text).toContain('Missing content:');
			expect(text).toContain('Historical tool calls:');
			expect(text).toContain('"id":"call-7"');
			expect(text).toContain('Tool result for call: call-7');
			expect(text).toContain(historicalFile);
			expect(text).not.toContain('content available on disk');
			expect(text).toContain('Image references (not loaded; image content not interpreted):');
			expect(text).toContain('/fixture/[REDACTED_API_KEY].png');
			expect(text).toContain('/fixture/legacy.png');
			expect(text).toContain('source line 5; timestamp unknown');
			expect(text).toContain('Source issues: unknown-record-type');
			expect(text).toContain('[No normalized text; original content may be unavailable or opaque]');
			expect(text).toContain('"reason":"truncated [REDACTED_API_KEY]"');
			expect(text).toContain('"accountRef":"fixture-[REDACTED_API_KEY]"');
			expect(text).toContain('"credential":"[REDACTED_API_KEY]"');
			for (const omitted of [
				secret,
				'PRIVATE_BACKEND_PAYLOAD',
				'PRIVATE_LEGACY_REASONING',
				'PRIVATE_UNKNOWN_PAYLOAD',
				'SHOULD_NOT_LOAD',
			])
				expect(text).not.toContain(omitted);
			const lines = [...text.matchAll(/source line (\d+)/g)].map((match) => Number(match[1]));
			expect(lines).toEqual([1, 2, 3, 4, 5]);
		}
		// Formatters independently redact text added after extraction as well.
		logs[1].text += ` late ${secret}`;
		for (const text of [formatLogsForClipboard(logs), formatLogsForGrooming(logs)]) {
			expect(text).toContain('late [REDACTED_API_KEY]');
			expect(text).not.toContain(secret);
		}
	});

	it.each([false, true])(
		'applies reasoning visibility at export and clipboard (includeThinking=%s)',
		async (includeThinking) => {
			result.messages = [
				{
					...result.messages[0],
					type: 'reasoning',
					role: 'assistant',
					content: 'VISIBLE_REASONING',
					native: { provider: 'grok', line: 1, raw: 'OPAQUE_REASONING' },
				},
			];
			const context = await extractStoredSessionContext('grok', binding.cwd, 'native-shared', {
				...options,
				includeThinking,
			});
			const logs = context!.logs;
			expect(logs[1].source).toBe(includeThinking ? 'thinking' : 'system');
			expect(formatLogsForClipboard(logs)).not.toContain('VISIBLE_REASONING');
			for (const text of [
				logs[1].text,
				formatLogsForGrooming(logs),
				formatLogsForClipboard(logs, { includeThinking: true }),
			]) {
				expect(text.includes('VISIBLE_REASONING')).toBe(includeThinking);
				expect(text).not.toContain('OPAQUE_REASONING');
				if (!includeThinking)
					expect(text).toContain('Reasoning text omitted by export visibility policy');
			}
		}
	);

	it.each([
		undefined,
		{ provider: 'grok', status: 'unavailable', reason: 'oversized' },
		{ provider: 'grok', status: 'partial', reason: 'truncated' },
	] satisfies SessionMessagesResult['source'][])(
		'discloses empty incomplete source %j',
		async (source) => {
			Object.assign(result, { source, messages: [], total: 0 });
			const context = await extractStoredSessionContext(
				'grok',
				binding.cwd,
				'native-shared',
				options
			);
			expect(context!.logs).toHaveLength(1);
			for (const text of [
				formatLogsForClipboard(context!.logs),
				formatLogsForGrooming(context!.logs),
			]) {
				expect(text).toContain('Missing content:');
				expect(text).toContain(source?.reason ?? 'source-status-unobserved');
				expect(text).not.toContain('The observed transcript contains no records');
			}
		}
	);

	it.each([true, false])(
		'describes an available empty source truthfully (observed=%s)',
		async (observed) => {
			Object.assign(result, {
				messages: [],
				total: 0,
				nativeSessionBinding: observed ? binding : undefined,
			});
			const context = await extractStoredSessionContext(
				'grok',
				binding.cwd,
				'native-shared',
				options
			);
			const text = formatLogsForClipboard(context!.logs);
			expect(text.includes('The observed transcript contains no records')).toBe(observed);
			if (!observed)
				expect(text).toContain('Ownership: unverified; no transcript content exported');
		}
	);

	it.each([
		{ total: 1001, hasMore: false },
		{ total: 1, hasMore: true },
	])('discloses pagination %j without stitching generations', async (page) => {
		Object.assign(result, page);
		const context = await extractStoredSessionContext(
			'grok',
			binding.cwd,
			'native-shared',
			options
		);
		for (const text of [
			formatLogsForClipboard(context!.logs),
			formatLogsForGrooming(context!.logs),
		]) {
			expect(text).toContain(
				`Partial export: the latest 1 of ${page.total} normalized records are included; earlier content is omitted.`
			);
		}
		expect(mockAgentSessionsRead).toHaveBeenCalledTimes(1);
	});

	it.each([
		['grok', 'codex'],
		['codex', 'grok'],
		['grok', 'claude-code'],
		['claude-code', 'grok'],
	])(
		'does not enable or certify native migration %s -> %s by export',
		async (source, destination) => {
			// The route is a static, unverified declaration; an export neither adds nor upgrades it.
			const declared = getDeclaredTranslationDirection(source, destination);
			const before = structuredClone(declared);
			expect(declared?.verification).toBe('unverified');
			const context = await extractStoredSessionContext(
				'grok',
				binding.cwd,
				'native-shared',
				options
			);
			expect(context!.logs[1].text).toContain('Selected account content');
			expect(getDeclaredTranslationDirection(source, destination)).toEqual(before);
			expect(context).not.toHaveProperty('nativeSessionBinding');
		}
	);

	it('preserves the non-Grok three-argument read and dialogue projection', async () => {
		const context = await extractStoredSessionContext('claude-code', binding.cwd, 'legacy-native');
		expect(mockAgentSessionsRead).toHaveBeenCalledWith('claude-code', binding.cwd, 'legacy-native');
		expect(context).toMatchObject({
			sessionId: '',
			name: 'Selected account content',
			logs: [{ id: 'native-line-1', source: 'user', text: 'Selected account content' }],
		});
		expect(formatLogsForClipboard(context!.logs)).toBe('USER:\nSelected account content');
	});
});

describe('extractTabContext', () => {
	it('should extract context from a tab with all fields populated', () => {
		const tab = createMockTab({
			name: 'Feature Branch',
			agentSessionId: 'abc123',
			logs: [
				createMockLog({ source: 'user', text: 'Hello' }),
				createMockLog({ source: 'ai', text: 'Hi there!' }),
			],
			usageStats: {
				inputTokens: 100,
				outputTokens: 200,
				cacheReadInputTokens: 50,
				cacheCreationInputTokens: 0,
				costUsd: 0.01,
			},
		});
		const session = createMockSession();

		const context = extractTabContext(tab, 'My Project', session);

		expect(context.type).toBe('tab');
		expect(context.sessionId).toBe('session-123');
		expect(context.tabId).toBe('tab-123');
		expect(context.agentSessionId).toBe('abc123');
		expect(context.projectRoot).toBe('/test/project');
		expect(context.name).toBe('My Project / Feature Branch');
		expect(context.logs).toHaveLength(2);
		expect(context.usageStats?.inputTokens).toBe(100);
		expect(context.agentType).toBe('claude-code');
	});

	it('should use agent session ID octets when tab name is null', () => {
		const tab = createMockTab({
			name: null,
			agentSessionId: 'abcdefgh-1234-5678-90ab-cdef12345678',
		});
		const session = createMockSession();

		const context = extractTabContext(tab, 'Project', session);

		expect(context.name).toBe('Project / abcdefgh');
	});

	it('should fall back to "New Tab" when no name or session ID', () => {
		const tab = createMockTab({
			name: null,
			agentSessionId: null,
		});
		const session = createMockSession();

		const context = extractTabContext(tab, 'Project', session);

		expect(context.name).toBe('Project / New Tab');
	});

	it('should create a shallow copy of logs to prevent mutations', () => {
		const originalLogs = [createMockLog({ text: 'Original' })];
		const tab = createMockTab({ logs: originalLogs });
		const session = createMockSession();

		const context = extractTabContext(tab, 'Project', session);

		// Modifying the context logs should not affect the original
		context.logs.push(createMockLog({ text: 'Added' }));
		expect(originalLogs).toHaveLength(1);
		expect(context.logs).toHaveLength(2);
	});
});

describe('formatLogsForClipboard', () => {
	it('includes user and assistant entries only by default', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'How do I implement X?' }),
			createMockLog({ source: 'thinking', text: 'The user wants...' }),
			createMockLog({ source: 'ai', text: 'Use the foo helper.' }),
			createMockLog({ source: 'tool', text: 'Reading file...' }),
			createMockLog({ source: 'system', text: 'system prompt' }),
		];

		const result = formatLogsForClipboard(logs);

		expect(result).toBe('USER:\nHow do I implement X?\n\nASSISTANT:\nUse the foo helper.');
		expect(result).not.toContain('THINKING');
		expect(result).not.toContain('The user wants');
	});

	it('treats ai and stdout sources as ASSISTANT entries', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'ai', text: 'first response' }),
			createMockLog({ source: 'stdout', text: 'second response' }),
		];

		const result = formatLogsForClipboard(logs);

		expect(result).toBe('ASSISTANT:\nfirst response\n\nASSISTANT:\nsecond response');
	});

	it('includes THINKING entries when includeThinking is true', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'Why?' }),
			createMockLog({ source: 'thinking', text: 'Considering the options...' }),
			createMockLog({ source: 'ai', text: 'Because Y.' }),
		];

		const result = formatLogsForClipboard(logs, { includeThinking: true });

		expect(result).toBe(
			'USER:\nWhy?\n\nTHINKING:\nConsidering the options...\n\nASSISTANT:\nBecause Y.'
		);
	});

	it('still excludes tool/system/stderr entries when includeThinking is true', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'hi' }),
			createMockLog({ source: 'thinking', text: 'reasoning' }),
			createMockLog({ source: 'tool', text: 'tool call' }),
			createMockLog({ source: 'stderr', text: 'stderr noise' }),
			createMockLog({ source: 'system', text: 'system note' }),
			createMockLog({ source: 'error', text: 'failure' }),
			createMockLog({ source: 'ai', text: 'response' }),
		];

		const result = formatLogsForClipboard(logs, { includeThinking: true });

		expect(result).toBe('USER:\nhi\n\nTHINKING:\nreasoning\n\nASSISTANT:\nresponse');
	});

	it('skips empty entries even when their source is included', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'real message' }),
			createMockLog({ source: 'thinking', text: '   ' }),
			createMockLog({ source: 'thinking', text: '' }),
			createMockLog({ source: 'ai', text: 'reply' }),
		];

		const result = formatLogsForClipboard(logs, { includeThinking: true });

		expect(result).toBe('USER:\nreal message\n\nASSISTANT:\nreply');
	});

	it('returns an empty string when no entries qualify', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'system', text: 'noise' }),
			createMockLog({ source: 'tool', text: 'tool call' }),
		];

		expect(formatLogsForClipboard(logs)).toBe('');
	});
});

describe('hasThinkingEntries', () => {
	it('returns true when any entry has source "thinking" and non-empty text', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'hi' }),
			createMockLog({ source: 'thinking', text: 'reasoning' }),
		];
		expect(hasThinkingEntries(logs)).toBe(true);
	});

	it('returns false when no thinking entries exist', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'hi' }),
			createMockLog({ source: 'ai', text: 'hi back' }),
		];
		expect(hasThinkingEntries(logs)).toBe(false);
	});

	it('returns false when thinking entries are blank', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'thinking', text: '' }),
			createMockLog({ source: 'thinking', text: '   ' }),
		];
		expect(hasThinkingEntries(logs)).toBe(false);
	});

	it('returns false for undefined and null inputs', () => {
		expect(hasThinkingEntries(undefined)).toBe(false);
		expect(hasThinkingEntries(null)).toBe(false);
	});
});

describe('formatLogsForGrooming', () => {
	it('should format logs with proper markdown headers', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'How do I implement X?' }),
			createMockLog({ source: 'ai', text: 'To implement X, you should...' }),
		];

		const result = formatLogsForGrooming(logs);

		expect(result).toContain('## User');
		expect(result).toContain('How do I implement X?');
		expect(result).toContain('## Assistant');
		expect(result).toContain('To implement X, you should...');
	});

	it('should skip empty log entries', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'Hello' }),
			createMockLog({ source: 'system', text: '' }),
			createMockLog({ source: 'ai', text: 'Hi!' }),
		];

		const result = formatLogsForGrooming(logs);

		expect(result.match(/## /g)).toHaveLength(2);
	});

	it('should skip internal system messages', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'system', text: 'Connecting...' }),
			createMockLog({ source: 'system', text: 'Session started at 10:00' }),
			createMockLog({ source: 'user', text: 'Hello' }),
		];

		const result = formatLogsForGrooming(logs);

		expect(result).not.toContain('Connecting');
		expect(result).not.toContain('Session started');
		expect(result).toContain('Hello');
	});

	it('should map all source types correctly', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'User message' }),
			createMockLog({ source: 'ai', text: 'AI response' }),
			createMockLog({ source: 'error', text: 'Error message' }),
			createMockLog({ source: 'stdout', text: 'Output message' }),
			createMockLog({ source: 'stderr', text: 'Stderr message' }),
		];

		const result = formatLogsForGrooming(logs);

		expect(result).toContain('## User');
		expect(result).toContain('## Assistant');
		expect(result).toContain('## Error');
		expect(result).toContain('## Output');
		expect(result).toContain('## Error Output');
	});

	describe('file content stripping', () => {
		it('should strip full file contents from code blocks with file paths', () => {
			// 'line\n'.repeat(20) creates "line\n" 20 times, which when split by \n gives 21 elements
			// (20 "line" elements + 1 empty string from trailing newline)
			const fileContent = 'line\n'.repeat(20);
			const logs: LogEntry[] = [
				createMockLog({
					source: 'ai',
					text: `Here's the file:\n\`\`\`typescript:src/utils/helper.ts\n${fileContent}\`\`\``,
				}),
			];

			const result = formatLogsForGrooming(logs);

			expect(result).toContain('[File: src/utils/helper.ts');
			expect(result).toContain('21 lines');
			expect(result).toContain('content available on disk');
			expect(result).not.toContain(fileContent);
		});

		it('should preserve small code snippets (under 15 lines)', () => {
			const smallSnippet = 'const x = 1;\nconst y = 2;\n';
			const logs: LogEntry[] = [
				createMockLog({
					source: 'ai',
					text: `Example:\n\`\`\`typescript:src/example.ts\n${smallSnippet}\`\`\``,
				}),
			];

			const result = formatLogsForGrooming(logs);

			// Small snippets should be preserved
			expect(result).toContain(smallSnippet);
			expect(result).not.toContain('content available on disk');
		});

		it('should handle Read tool output patterns', () => {
			const fileContent = 'line\n'.repeat(25);
			const logs: LogEntry[] = [
				createMockLog({
					source: 'ai',
					text: `Contents of /Users/test/project/src/main.ts:\n\`\`\`typescript\n${fileContent}\`\`\``,
				}),
			];

			const result = formatLogsForGrooming(logs);

			expect(result).toContain('[Read: /Users/test/project/src/main.ts');
			expect(result).toContain('content available on disk');
		});

		it('should preserve code blocks without file paths', () => {
			const codeExample = 'function example() {\n  return 42;\n}\n'.repeat(10);
			const logs: LogEntry[] = [
				createMockLog({
					source: 'ai',
					text: `Here's how to do it:\n\`\`\`typescript\n${codeExample}\`\`\``,
				}),
			];

			const result = formatLogsForGrooming(logs);

			// Code blocks without file paths should be preserved
			expect(result).toContain(codeExample);
		});
	});

	describe('image stripping', () => {
		it('should strip all images by default (maxImageTokens = 0)', () => {
			const logs: LogEntry[] = [
				createMockLog({
					source: 'user',
					text: 'Check this screenshot',
					images: ['/path/to/image1.png', '/path/to/image2.png'],
					timestamp: 1000,
				}),
			];

			const result = formatLogsForGrooming(logs);

			expect(result).toContain('[Note: 2 image(s) stripped');
			expect(result).toContain('Images can be re-referenced by path');
		});

		it('should strip oldest images first when over budget', () => {
			const logs: LogEntry[] = [
				createMockLog({
					source: 'user',
					text: 'Old image',
					images: ['/path/to/old.png'],
					timestamp: 1000, // oldest
				}),
				createMockLog({
					source: 'user',
					text: 'New image',
					images: ['/path/to/new.png'],
					timestamp: 2000, // newer
				}),
			];

			// Allow 1500 tokens (1 image worth)
			const result = formatLogsForGrooming(logs, { maxImageTokens: 1500 });

			// Should strip 1 image (the oldest one)
			expect(result).toContain('[Note: 1 image(s) stripped');
		});

		it('should not add note when no images present', () => {
			const logs: LogEntry[] = [createMockLog({ source: 'user', text: 'No images here' })];

			const result = formatLogsForGrooming(logs);

			expect(result).not.toContain('image(s) stripped');
		});

		it('should keep all images when under budget', () => {
			const logs: LogEntry[] = [
				createMockLog({
					source: 'user',
					text: 'Single image',
					images: ['/path/to/image.png'],
					timestamp: 1000,
				}),
			];

			// Allow 5000 tokens (more than 1 image)
			const result = formatLogsForGrooming(logs, { maxImageTokens: 5000 });

			expect(result).not.toContain('image(s) stripped');
		});
	});
});

describe('parseGroomedOutput', () => {
	it('should parse structured groomed output back to log entries', () => {
		const groomedText = `## User
How do I implement X?

## Assistant
To implement X, follow these steps:
1. First step
2. Second step`;

		const logs = parseGroomedOutput(groomedText);

		expect(logs).toHaveLength(2);
		expect(logs[0].source).toBe('user');
		expect(logs[0].text).toContain('How do I implement X?');
		expect(logs[1].source).toBe('ai');
		expect(logs[1].text).toContain('First step');
	});

	it('should treat unstructured text as a single AI message', () => {
		const groomedText = `This is a summary of the conversation.
Key points:
- Point 1
- Point 2`;

		const logs = parseGroomedOutput(groomedText);

		expect(logs).toHaveLength(1);
		expect(logs[0].source).toBe('ai');
		expect(logs[0].text).toContain('Key points');
	});

	it('should handle empty input', () => {
		const logs = parseGroomedOutput('');

		expect(logs).toHaveLength(0);
	});

	it('should handle whitespace-only input', () => {
		const logs = parseGroomedOutput('   \n\n   ');

		expect(logs).toHaveLength(0);
	});

	it('should map various header formats to correct sources', () => {
		const groomedText = `## AI Response
First

## User Input
Second

## Error Log
Third

## System Info
Fourth`;

		const logs = parseGroomedOutput(groomedText);

		expect(logs[0].source).toBe('ai');
		expect(logs[1].source).toBe('user');
		expect(logs[2].source).toBe('error');
		expect(logs[3].source).toBe('system');
	});
});

describe('estimateTokenCount', () => {
	it('should use usage stats when available', () => {
		const context: ContextSource = {
			type: 'tab',
			sessionId: 'session-1',
			projectRoot: '/project',
			name: 'Test',
			logs: [],
			agentType: 'claude-code',
			usageStats: {
				inputTokens: 500,
				outputTokens: 1000,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 200,
				costUsd: 0.05,
			},
		};

		const tokens = estimateTokenCount(context);

		expect(tokens).toBe(700); // input + cacheCreation (cacheRead excluded - cumulative)
	});

	it('should estimate from log content when no usage stats', () => {
		const context: ContextSource = {
			type: 'tab',
			sessionId: 'session-1',
			projectRoot: '/project',
			name: 'Test',
			logs: [
				createMockLog({ text: 'A'.repeat(400) }), // ~100 tokens
				createMockLog({ text: 'B'.repeat(400) }), // ~100 tokens
			],
			agentType: 'claude-code',
		};

		const tokens = estimateTokenCount(context);

		// 800 chars / 4 chars per token = 200 tokens
		expect(tokens).toBe(200);
	});

	it('should account for image attachments', () => {
		const context: ContextSource = {
			type: 'tab',
			sessionId: 'session-1',
			projectRoot: '/project',
			name: 'Test',
			logs: [
				createMockLog({
					text: 'Check this image',
					images: ['base64imagedata1', 'base64imagedata2'],
				}),
			],
			agentType: 'claude-code',
		};

		const tokens = estimateTokenCount(context);

		// Should include both text and image overhead
		expect(tokens).toBeGreaterThan(3000); // 2 images * 1500 tokens each
	});
});

describe('estimateTextTokenCount', () => {
	it('should estimate tokens from text length', () => {
		const text = 'A'.repeat(400); // 400 chars

		const tokens = estimateTextTokenCount(text);

		expect(tokens).toBe(100); // 400 / 4 = 100
	});

	it('should round up partial tokens', () => {
		const text = 'A'.repeat(401); // 401 chars

		const tokens = estimateTextTokenCount(text);

		expect(tokens).toBe(101); // ceil(401 / 4) = 101
	});
});

describe('findDuplicateContent', () => {
	it('should detect exact duplicate log entries', () => {
		const longText =
			'This is a longer message that exceeds the minimum length for duplicate detection. '.repeat(
				3
			);

		const contexts: ContextSource[] = [
			{
				type: 'tab',
				sessionId: 'session-1',
				projectRoot: '/project',
				name: 'Context 1',
				logs: [createMockLog({ text: longText })],
				agentType: 'claude-code',
			},
			{
				type: 'tab',
				sessionId: 'session-2',
				projectRoot: '/project',
				name: 'Context 2',
				logs: [createMockLog({ text: longText })],
				agentType: 'claude-code',
			},
		];

		const result = findDuplicateContent(contexts);

		expect(result.duplicates).toHaveLength(1);
		expect(result.duplicates[0].sourceIndex).toBe(1);
		expect(result.estimatedSavings).toBeGreaterThan(0);
	});

	it('should ignore short messages', () => {
		const contexts: ContextSource[] = [
			{
				type: 'tab',
				sessionId: 'session-1',
				projectRoot: '/project',
				name: 'Context 1',
				logs: [createMockLog({ text: 'Short' })],
				agentType: 'claude-code',
			},
			{
				type: 'tab',
				sessionId: 'session-2',
				projectRoot: '/project',
				name: 'Context 2',
				logs: [createMockLog({ text: 'Short' })],
				agentType: 'claude-code',
			},
		];

		const result = findDuplicateContent(contexts);

		expect(result.duplicates).toHaveLength(0);
	});

	it('should detect duplicate code blocks', () => {
		const codeBlock = '```typescript\n' + 'const x = 1;\n'.repeat(20) + '```';

		const contexts: ContextSource[] = [
			{
				type: 'tab',
				sessionId: 'session-1',
				projectRoot: '/project',
				name: 'Context 1',
				logs: [createMockLog({ text: `Here's the code:\n${codeBlock}` })],
				agentType: 'claude-code',
			},
			{
				type: 'tab',
				sessionId: 'session-2',
				projectRoot: '/project',
				name: 'Context 2',
				logs: [createMockLog({ text: `Same code:\n${codeBlock}` })],
				agentType: 'claude-code',
			},
		];

		const result = findDuplicateContent(contexts);

		// Should find duplicate code block
		expect(result.estimatedSavings).toBeGreaterThan(0);
	});

	it('should return empty results for unique content', () => {
		const contexts: ContextSource[] = [
			{
				type: 'tab',
				sessionId: 'session-1',
				projectRoot: '/project',
				name: 'Context 1',
				logs: [
					createMockLog({
						text: 'Unique message one that is long enough to be considered for deduplication purposes',
					}),
				],
				agentType: 'claude-code',
			},
			{
				type: 'tab',
				sessionId: 'session-2',
				projectRoot: '/project',
				name: 'Context 2',
				logs: [
					createMockLog({
						text: 'Different unique message two that is also long enough for deduplication consideration',
					}),
				],
				agentType: 'claude-code',
			},
		];

		const result = findDuplicateContent(contexts);

		expect(result.duplicates).toHaveLength(0);
		expect(result.estimatedSavings).toBe(0);
	});
});

describe('calculateTotalTokens', () => {
	it('should sum tokens across all contexts', () => {
		const contexts: ContextSource[] = [
			{
				type: 'tab',
				sessionId: 'session-1',
				projectRoot: '/project',
				name: 'Context 1',
				logs: [],
				agentType: 'claude-code',
				usageStats: {
					inputTokens: 100,
					outputTokens: 200,
					cacheReadInputTokens: 50,
					cacheCreationInputTokens: 25,
					costUsd: 0,
				},
			},
			{
				type: 'tab',
				sessionId: 'session-2',
				projectRoot: '/project',
				name: 'Context 2',
				logs: [],
				agentType: 'claude-code',
				usageStats: {
					inputTokens: 300,
					outputTokens: 400,
					cacheReadInputTokens: 75,
					cacheCreationInputTokens: 25,
					costUsd: 0,
				},
			},
		];

		const total = calculateTotalTokens(contexts);

		// input + cacheRead + cacheCreation for each context
		expect(total).toBe(575); // (100+50+25) + (300+75+25)
	});
});

describe('getContextSummary', () => {
	it('should return accurate summary statistics', () => {
		const contexts: ContextSource[] = [
			{
				type: 'tab',
				sessionId: 'session-1',
				projectRoot: '/project',
				name: 'Context 1',
				logs: [createMockLog(), createMockLog()],
				agentType: 'claude-code',
				usageStats: {
					inputTokens: 100,
					outputTokens: 100,
					cacheReadInputTokens: 50,
					cacheCreationInputTokens: 25,
					costUsd: 0,
				},
			},
			{
				type: 'session',
				sessionId: 'session-2',
				projectRoot: '/project',
				name: 'Context 2',
				logs: [createMockLog(), createMockLog(), createMockLog()],
				agentType: 'opencode',
				usageStats: {
					inputTokens: 200,
					outputTokens: 200,
					cacheReadInputTokens: 75,
					cacheCreationInputTokens: 25,
					costUsd: 0,
				},
			},
		];

		const summary = getContextSummary(contexts);

		expect(summary.totalSources).toBe(2);
		expect(summary.totalLogs).toBe(5);
		// (100+50+25) + (200+75+25) = 475 (input + cacheRead + cacheCreation)
		expect(summary.estimatedTokens).toBe(475);
		expect(summary.byAgent['claude-code']).toBe(1);
		expect(summary.byAgent['opencode']).toBe(1);
	});
});

// The merge-into-tab formatter and the Grok token rule. These carry
// a Grok conversation into ANOTHER agent's prompt, so each case names the loss
// it would catch: dropped or reordered turns, a tool rendered as prose (or run
// again), a Maestro notice or hidden reasoning leaking into the conversation,
// an image silently vanishing, an unbounded paste, or a context sized from
// cumulative usage totals instead of its text.
describe('formatLogsForContextInjection: Grok merge context', () => {
	// Same inert sentinel as the canonical redaction suite, never a credential.
	const secret = 'sk-ABCDEFGHIJKLMNOP1234';

	function grokLog(
		id: string,
		source: LogEntry['source'],
		text: string,
		extra: Partial<LogEntry> = {}
	) {
		return createMockLog({ id, source, text, timestamp: Number.NaN, ...extra });
	}

	it('keeps a fresh Grok history in source order with prose and tools distinct', () => {
		const longOutput = `${'x'.repeat(2_500)}TAIL_PAST_CAP`;
		const logs: LogEntry[] = [
			grokLog('u1', 'user', 'Read the config'),
			grokLog('a1', 'ai', 'Reading it now'),
			grokLog('t1', 'tool', 'read_file config.ts', {
				metadata: { toolState: { status: 'completed', output: longOutput } },
			}),
			grokLog('a2', 'stdout', 'The config sets port 8080'),
			grokLog('u2', 'user', 'Thanks'),
		];
		const result = formatLogsForContextInjection(logs, { sourceAgentType: 'grok' });
		const blocks = result.text.split('\n\n');
		expect(blocks.map((block) => block.split(':')[0])).toEqual([
			'User',
			'Assistant',
			'Tool call, completed (historical; it does not run again)',
			'Assistant',
			'User',
		]);
		expect(result.text).toContain('Assistant: The config sets port 8080');
		// The tool's result is evidence, bounded, never relabelled as the assistant's prose.
		expect(result.text).toContain('Result (truncated): ');
		expect(result.text).not.toContain('TAIL_PAST_CAP');
		expect(result.text).not.toContain('Assistant: read_file');
		expect(result).toMatchObject({
			includedEntries: 5,
			omittedNotices: 0,
			omittedThinking: 0,
			omittedForBudget: 0,
			omittedImages: 0,
		});
	});

	it('leaves Maestro notices out but keeps a stored export provenance line', () => {
		const logs: LogEntry[] = [
			grokLog(
				'grok-context-provenance',
				'system',
				'Grok context export: a redacted text projection'
			),
			grokLog('s1', 'system', 'Session resumed (Maestro notice)'),
			grokLog('u1', 'user', 'Question'),
			grokLog('e1', 'error', 'Agent error: rate limited'),
			grokLog('x1', 'stderr', 'warning: stray stderr'),
			grokLog('a1', 'ai', 'Answer'),
		];
		const result = formatLogsForContextInjection(logs, { sourceAgentType: 'grok' });
		expect(result.text).toBe(
			'Provenance: Grok context export: a redacted text projection\n\nUser: Question\n\nAssistant: Answer'
		);
		expect(result.omittedNotices).toBe(3);
		for (const leaked of ['Session resumed', 'rate limited', 'stray stderr'])
			expect(result.text).not.toContain(leaked);
	});

	it.each([false, true])('applies reasoning visibility (includeThinking=%s)', (includeThinking) => {
		const logs = [
			grokLog('u1', 'user', 'Why?'),
			grokLog('r1', 'thinking', 'HIDDEN_REASONING_TEXT'),
			grokLog('a1', 'ai', 'Because'),
		];
		const result = formatLogsForContextInjection(logs, {
			sourceAgentType: 'grok',
			includeThinking,
		});
		expect(result.text.includes('HIDDEN_REASONING_TEXT')).toBe(includeThinking);
		expect(result.omittedThinking).toBe(includeThinking ? 0 : 1);
		if (includeThinking) expect(result.text).toContain('Assistant reasoning (visible text):');
	});

	it('names attached images by count and never pastes their bytes', () => {
		const logs = [
			grokLog('u1', 'user', 'What is in these?', {
				images: ['data:image/png;base64,IMAGE_BYTES_ONE', 'data:image/png;base64,IMAGE_BYTES_TWO'],
			}),
			grokLog('a1', 'ai', 'A chart and a table'),
		];
		const result = formatLogsForContextInjection(logs, { sourceAgentType: 'grok' });
		expect(result.omittedImages).toBe(2);
		expect(result.text).toContain('[2 attached image(s) not carried over;');
		expect(result.text).not.toContain('IMAGE_BYTES');
	});

	it('redacts Grok prose and tool output, and leaves other providers verbatim', () => {
		const logs = [
			grokLog('u1', 'user', `My key is ${secret}`),
			grokLog('t1', 'tool', 'shell env', {
				metadata: { toolState: { status: 'completed', output: `OPENAI=${secret}` } },
			}),
		];
		const grok = formatLogsForContextInjection(logs, { sourceAgentType: 'grok' });
		expect(grok.text).not.toContain(secret);
		expect(grok.text.match(/\[REDACTED_API_KEY\]/g)).toHaveLength(2);
		// The redaction is the Grok export rule, not a change to the shared formatter.
		expect(formatLogsForContextInjection(logs, { sourceAgentType: 'codex' }).text).toContain(
			secret
		);
	});

	it('bounds a long conversation to the budget, newest first, with no duplicates', () => {
		const logs = Array.from({ length: 400 }, (_, i) =>
			grokLog(
				`m${i}`,
				i % 2 ? 'ai' : 'user',
				`turn-${String(i).padStart(3, '0')} ${'w'.repeat(200)}`
			)
		);
		const maxTokens = 2_000;
		const result = formatLogsForContextInjection(logs, { sourceAgentType: 'grok', maxTokens });
		expect(result.omittedForBudget).toBeGreaterThan(0);
		expect(result.includedEntries + result.omittedForBudget).toBe(400);
		expect(result.text.startsWith(`[${result.omittedForBudget} earlier entries omitted`)).toBe(
			true
		);
		const turns = [...result.text.matchAll(/turn-(\d{3})/g)].map((match) => Number(match[1]));
		// Contiguous newest suffix, in order, each turn exactly once.
		expect(turns).toEqual(
			Array.from({ length: result.includedEntries }, (_, i) => 400 - result.includedEntries + i)
		);
		expect(result.estimatedTokens).toBeLessThanOrEqual(maxTokens + 32);
		// Unbounded (0) keeps everything.
		expect(formatLogsForContextInjection(logs, { maxTokens: 0 }).includedEntries).toBe(400);
	});

	it('truncates a newest entry that alone exceeds the budget, and says so', () => {
		const logs = [
			grokLog('u1', 'user', 'old'),
			grokLog('a1', 'ai', `NEWEST_HEAD ${'z'.repeat(40_000)}`),
		];
		const result = formatLogsForContextInjection(logs, { sourceAgentType: 'grok', maxTokens: 500 });
		expect(result.text).toContain('NEWEST_HEAD');
		expect(result.text).toContain('[Entry truncated to fit the target');
		expect(result.text).toContain('[1 earlier entry omitted');
		expect(result.text).not.toContain('User: old');
		expect(result.estimatedTokens).toBeLessThanOrEqual(500 + 32);
	});

	it('survives malformed and out-of-order records without inventing content', () => {
		const logs = [
			grokLog('a2', 'ai', 'second by source order', { timestamp: 5 }),
			grokLog('empty', 'ai', ''),
			grokLog('blank', 'user', '   \n\t'),
			{ id: 'missing-text', timestamp: 1, source: 'ai' } as unknown as LogEntry,
			grokLog('future', 'future-kind' as LogEntry['source'], 'UNKNOWN_KIND_PAYLOAD'),
			grokLog('tool-no-state', 'tool', 'grep TODO'),
			grokLog('a1', 'ai', 'first timestamp, later source', { timestamp: 1 }),
		];
		const result = formatLogsForContextInjection(logs, { sourceAgentType: 'grok' });
		// Source order wins over timestamps; NaN and missing fields never throw.
		expect(result.text.indexOf('second by source order')).toBeLessThan(
			result.text.indexOf('first timestamp, later source')
		);
		expect(result.text).toContain('Tool call (historical; it does not run again): grep TODO');
		expect(result.text).not.toContain('Result');
		// An unknown kind is not the conversation's, and is counted, not pasted.
		expect(result.text).not.toContain('UNKNOWN_KIND_PAYLOAD');
		expect(result).toMatchObject({ includedEntries: 3, omittedNotices: 1 });
		expect(formatLogsForContextInjection([], { maxTokens: 100 })).toMatchObject({
			text: '',
			includedEntries: 0,
			omittedForBudget: 0,
		});
	});

	describe('stored (resumed) Grok export carried into a merge', () => {
		const binding = {
			version: 1 as const,
			state: 'bound' as const,
			provider: 'grok' as const,
			nativeSessionId: 'native-resumed',
			accountRef: 'account-a',
			host: { kind: 'local' as const, identity: 'fixture-machine' },
			cwd: '/fixture/project',
		};
		function storedResult(overrides: Partial<SessionMessagesResult> = {}): SessionMessagesResult {
			return {
				nativeSessionBinding: binding,
				source: { provider: 'grok', status: 'available' },
				messages: [
					{
						type: 'user',
						role: 'user',
						content: 'First question',
						timestamp: '',
						uuid: 'line-1',
						native: { provider: 'grok', line: 1 },
					},
					{
						type: 'reasoning',
						role: 'assistant',
						content: 'STORED_VISIBLE_REASONING',
						timestamp: '',
						uuid: 'line-2',
						native: { provider: 'grok', line: 2, raw: 'OPAQUE_SIGNED_REASONING' },
					},
					{
						type: 'backend_tool_call',
						role: 'assistant',
						content: '',
						timestamp: '',
						uuid: 'line-3',
						toolUse: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }],
						native: { provider: 'grok', line: 3, raw: 'PRIVATE_TOOL_PAYLOAD' },
					},
					{
						type: 'assistant',
						role: 'assistant',
						content: 'Resumed answer',
						timestamp: '',
						uuid: 'line-4',
						native: { provider: 'grok', line: 4 },
					},
				],
				total: 4,
				hasMore: false,
				...overrides,
			};
		}

		beforeEach(() => mockAgentSessionsRead.mockReset());

		it('keeps provenance and order, and drops hidden reasoning as a notice', async () => {
			mockAgentSessionsRead.mockResolvedValue(storedResult());
			const context = await extractStoredSessionContext(
				'grok',
				binding.cwd,
				binding.nativeSessionId,
				{
					ownerAgentId: 'owner-a',
					nativeSessionBinding: binding,
				}
			);
			const result = formatLogsForContextInjection(context!.logs, { sourceAgentType: 'grok' });
			expect(result.text.startsWith('Provenance: Grok context export:')).toBe(true);
			expect(result.text).toContain('not lossless native migration or a resumable session');
			const lines = [...result.text.matchAll(/source line (\d+)/g)].map((match) =>
				Number(match[1])
			);
			// Line 2 (reasoning, hidden by the export policy) is a system row: omitted, not relabelled.
			expect(lines).toEqual([1, 3, 4]);
			expect(result.omittedNotices).toBe(1);
			for (const leaked of [
				'STORED_VISIBLE_REASONING',
				'OPAQUE_SIGNED_REASONING',
				'PRIVATE_TOOL_PAYLOAD',
			])
				expect(result.text).not.toContain(leaked);
			expect(result.text).toContain('Tool call (historical; it does not run again):');
			expect(result.text).toContain('"id":"call-1"');
		});

		it('carries a truncated or partial source disclosure through the merge budget', async () => {
			mockAgentSessionsRead.mockResolvedValue(
				storedResult({
					source: { provider: 'grok', status: 'partial', reason: 'truncated' },
					total: 900,
					hasMore: true,
				})
			);
			const context = await extractStoredSessionContext(
				'grok',
				binding.cwd,
				binding.nativeSessionId,
				{
					ownerAgentId: 'owner-a',
				}
			);
			// The provenance block is oldest; a budget that drops it must say so.
			const full = formatLogsForContextInjection(context!.logs, { sourceAgentType: 'grok' });
			expect(full.text).toContain('Missing content:');
			expect(full.text).toContain('Partial export: the latest 4 of 900');
			const tight = formatLogsForContextInjection(context!.logs, {
				sourceAgentType: 'grok',
				maxTokens: 60,
			});
			expect(tight.omittedForBudget).toBeGreaterThan(0);
			expect(tight.text).toMatch(/^\[\d+ earlier entr(y|ies) omitted/);
		});
	});
});

describe('Grok context sizing ignores cumulative usage totals', () => {
	const cumulative = {
		inputTokens: 900_000,
		outputTokens: 400_000,
		cacheReadInputTokens: 5_000_000,
		cacheCreationInputTokens: 300_000,
		totalCostUsd: 12,
		contextWindow: 0,
	};

	function context(agentType: ContextSource['agentType'], withUsage: boolean): ContextSource {
		return {
			type: 'tab',
			sessionId: 'session-1',
			projectRoot: '/project',
			name: 'Grok tab',
			logs: [createMockLog({ text: 'A'.repeat(400) }), createMockLog({ text: 'B'.repeat(400) })],
			agentType,
			...(withUsage ? { usageStats: { ...cumulative } } : {}),
		};
	}

	it('estimates a Grok source from its text, as if no usage were reported', async () => {
		const grok = context('grok', true);
		expect(estimateTokenCount(grok)).toBe(estimateTokenCount(context('grok', false)));
		expect(estimateTokenCount(grok)).toBe(200);
		expect(await countContextTokens(grok)).toBe(await countContextTokens(context('grok', false)));
		expect(await countContextTokens(grok)).toBeLessThan(1_000);
		expect(calculateTotalTokens([grok, grok])).toBe(400);
	});

	it('still uses reported usage for a reference provider', () => {
		expect(estimateTokenCount(context('claude-code', true))).toBeGreaterThan(100_000);
	});
});
