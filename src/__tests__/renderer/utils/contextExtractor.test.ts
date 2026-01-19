import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	extractTabContext,
	formatLogsForGrooming,
	parseGroomedOutput,
	estimateTokenCount,
	estimateTextTokenCount,
	findDuplicateContent,
	calculateTotalTokens,
	getContextSummary,
} from '../../../renderer/utils/contextExtractor';
import type { AITab, LogEntry, Session } from '../../../renderer/types';
import type { ContextSource } from '../../../renderer/types/contextMerge';

// Mock window.maestro for extractStoredSessionContext tests
const mockAgentSessionsRead = vi.fn();
vi.stubGlobal('window', {
	maestro: {
		agentSessions: {
			read: mockAgentSessionsRead,
		},
	},
});

// Helper to create a mock session
function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-123',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
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

// Helper to create a mock tab
function createMockTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-123',
		agentSessionId: 'agent-session-456',
		name: 'Test Tab',
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		...overrides,
	};
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

		// input + cacheCreation for each context (cacheRead excluded - cumulative)
		expect(total).toBe(450); // (100+25) + (300+25)
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
		// (100+25) + (200+25) = 350 (cacheRead excluded - cumulative)
		expect(summary.estimatedTokens).toBe(350);
		expect(summary.byAgent['claude-code']).toBe(1);
		expect(summary.byAgent['opencode']).toBe(1);
	});
});
