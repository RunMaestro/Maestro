import { describe, it, expect } from 'vitest';
import { generateGroupChatExportHtml } from '../../../renderer/utils/groupChatExport';
import type {
	GroupChat,
	GroupChatMessage,
	GroupChatHistoryEntry,
	Theme,
} from '../../../renderer/types';

// Mock theme for testing
const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#1e1f29',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: 'rgba(189, 147, 249, 0.1)',
		accentText: '#bd93f9',
		accentForeground: '#282a36',
		success: '#50fa7b',
		warning: '#f1fa8c',
		error: '#ff5555',
	},
};

// Mock data factories
function createMockGroupChat(overrides?: Partial<GroupChat>): GroupChat {
	return {
		id: 'test-group-chat-id',
		name: 'Test Group Chat',
		createdAt: 1703116800000, // 2023-12-21T00:00:00.000Z
		moderatorAgentId: 'claude-code',
		moderatorSessionId: 'mod-session-123',
		participants: [
			{
				name: 'Agent1',
				agentId: 'claude-code',
				sessionId: 'agent1-session',
				addedAt: 1703116800000,
				color: '#3b82f6',
			},
			{
				name: 'Agent2',
				agentId: 'claude-code',
				sessionId: 'agent2-session',
				addedAt: 1703116900000,
				color: '#10b981',
			},
		],
		logPath: '/path/to/chat.log',
		imagesDir: '/path/to/images',
		...overrides,
	};
}

function createMockMessages(count = 3): GroupChatMessage[] {
	const messages: GroupChatMessage[] = [];
	const baseTime = new Date('2023-12-21T10:00:00.000Z').getTime();

	for (let i = 0; i < count; i++) {
		const isUser = i % 3 === 0;
		const fromOptions = isUser ? 'user' : i % 3 === 1 ? 'Agent1' : 'Agent2';
		messages.push({
			timestamp: new Date(baseTime + i * 60000).toISOString(),
			from: fromOptions,
			content: `Message ${i + 1} content`,
		});
	}

	return messages;
}

function createMockHistory(): GroupChatHistoryEntry[] {
	return [
		{
			id: 'history-1',
			timestamp: 1703120400000,
			summary: 'Delegated task to Agent1',
			participantName: 'moderator',
			participantColor: '#f59e0b',
			type: 'delegation',
		},
		{
			id: 'history-2',
			timestamp: 1703120500000,
			summary: 'Agent1 completed analysis',
			participantName: 'Agent1',
			participantColor: '#3b82f6',
			type: 'response',
			elapsedTimeMs: 5000,
			tokenCount: 150,
		},
	];
}

describe('groupChatExport', () => {
	describe('generateGroupChatExportHtml', () => {
		describe('basic HTML structure', () => {
			it('generates valid HTML document', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();
				const history = createMockHistory();

				const html = generateGroupChatExportHtml(groupChat, messages, history, {}, mockTheme);

				expect(html).toContain('<!DOCTYPE html>');
				expect(html).toContain('<html lang="en">');
				expect(html).toContain('</html>');
				expect(html).toContain('<head>');
				expect(html).toContain('</head>');
				expect(html).toContain('<body>');
				expect(html).toContain('</body>');
			});

			it('includes group chat name in title', () => {
				const groupChat = createMockGroupChat({ name: 'My Custom Chat' });
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<title>My Custom Chat - Maestro Group Chat Export</title>');
			});

			it('includes group chat name in header', () => {
				const groupChat = createMockGroupChat({ name: 'Test Chat Name' });
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('Test Chat Name');
			});

			it('includes embedded CSS styles', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<style>');
				expect(html).toContain('</style>');
				expect(html).toContain('--bg-primary');
				expect(html).toContain('--text-primary');
			});
		});

		describe('branding', () => {
			it('includes Maestro branding section', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('class="branding"');
				expect(html).toContain('Maestro');
				expect(html).toContain('Multi-agent orchestration');
			});

			it('includes runmaestro.ai link', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('href="https://runmaestro.ai"');
				expect(html).toContain('runmaestro.ai');
			});

			it('includes GitHub link', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('href="https://github.com/pedramamini/Maestro"');
				expect(html).toContain('GitHub');
			});

			it('includes Maestro logo SVG', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('class="branding-logo"');
				expect(html).toContain('<svg');
			});
		});

		describe('theme colors', () => {
			it('uses theme colors in CSS variables', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('--bg-primary: #282a36');
				expect(html).toContain('--bg-secondary: #21222c');
				expect(html).toContain('--text-primary: #f8f8f2');
				expect(html).toContain('--accent: #bd93f9');
			});

			it('includes theme name in footer', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('Theme: Dracula');
			});

			it('uses different theme colors when provided', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();
				const lightTheme: Theme = {
					id: 'github-light',
					name: 'GitHub Light',
					mode: 'light',
					colors: {
						bgMain: '#ffffff',
						bgSidebar: '#f6f8fa',
						bgActivity: '#f0f0f0',
						border: '#d0d7de',
						textMain: '#24292f',
						textDim: '#57606a',
						accent: '#0969da',
						accentDim: 'rgba(9, 105, 218, 0.1)',
						accentText: '#0969da',
						accentForeground: '#ffffff',
						success: '#1a7f37',
						warning: '#9a6700',
						error: '#cf222e',
					},
				};

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, lightTheme);

				expect(html).toContain('--bg-primary: #ffffff');
				expect(html).toContain('--accent: #0969da');
				expect(html).toContain('Theme: GitHub Light');
			});
		});

		describe('statistics', () => {
			it('calculates correct participant count', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				// Stats should show in HTML
				expect(html).toContain('<div class="stat-value">2</div>');
			});

			it('calculates correct total message count', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages(10);

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<div class="stat-value">10</div>');
			});

			it('displays stats in HTML', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages(5);

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				// Check for stats cards
				expect(html).toContain('Agents');
				expect(html).toContain('Messages');
				expect(html).toContain('Agent Replies');
				expect(html).toContain('Duration');
			});
		});

		describe('message rendering', () => {
			it('renders user messages with user class', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'user', content: 'Hello' },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('message-user');
			});

			it('renders agent messages with agent class', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: 'Response' },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('message-agent');
			});

			it('shows read-only badge for read-only messages', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'user', content: 'Query', readOnly: true },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('read-only');
			});

			it('includes message timestamps', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:30:00Z', from: 'user', content: 'Test' },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('message-time');
			});

			it('uses participant colors from groupChat', () => {
				const groupChat = createMockGroupChat({
					participants: [
						{
							name: 'ColoredAgent',
							agentId: 'claude-code',
							sessionId: 's1',
							addedAt: 0,
							color: '#ff5500',
						},
					],
				});
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'ColoredAgent', content: 'Hi' },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('#ff5500');
			});

			it('uses theme accent color for user messages', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'user', content: 'Hello' },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				// User messages should use theme accent color
				expect(html).toContain(`style="color: ${mockTheme.colors.accent}"`);
			});
		});

		describe('markdown rendering with marked library', () => {
			it('renders tables correctly', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{
						timestamp: '2023-12-21T10:00:00Z',
						from: 'Agent1',
						content: '| A | B |\n|---|---|\n| 1 | 2 |',
					},
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<table>');
				expect(html).toContain('<th>');
				expect(html).toContain('<td>');
			});

			it('renders horizontal rules correctly', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: 'Before\n\n---\n\nAfter' },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<hr');
			});

			it('converts inline code to HTML code tags', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{
						timestamp: '2023-12-21T10:00:00Z',
						from: 'Agent1',
						content: 'Use `npm install` to install',
					},
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<code>npm install</code>');
			});

			it('converts code blocks to pre tags', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{
						timestamp: '2023-12-21T10:00:00Z',
						from: 'Agent1',
						content: '```javascript\nconst x = 1;\n```',
					},
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<pre>');
				expect(html).toContain('const x = 1;');
			});

			it('converts bold markdown to strong tags', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: 'This is **important**' },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<strong>important</strong>');
			});

			it('converts italic markdown to em tags', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: 'This is *emphasized*' },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<em>emphasized</em>');
			});

			it('converts markdown headers', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{
						timestamp: '2023-12-21T10:00:00Z',
						from: 'Agent1',
						content: '# Heading 1\n\n## Heading 2\n\n### Heading 3',
					},
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<h1');
				expect(html).toContain('Heading 1');
				expect(html).toContain('<h2');
				expect(html).toContain('Heading 2');
				expect(html).toContain('<h3');
				expect(html).toContain('Heading 3');
			});

			it('converts markdown bullet lists', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: '- Item 1\n- Item 2' },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<li>Item 1</li>');
				expect(html).toContain('<li>Item 2</li>');
				expect(html).toContain('<ul>');
			});

			it('converts markdown links', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{
						timestamp: '2023-12-21T10:00:00Z',
						from: 'Agent1',
						content: 'Check [this link](https://example.com)',
					},
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('href="https://example.com"');
				expect(html).toContain('this link');
			});

			it('converts blockquotes', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: '> This is a quote' },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<blockquote>');
			});

			it('converts strikethrough text', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: '~~deleted~~' },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<del>deleted</del>');
			});
		});

		describe('image embedding', () => {
			it('embeds images as data URLs', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{
						timestamp: '2023-12-21T10:00:00Z',
						from: 'Agent1',
						content: '![screenshot](screenshot.png)',
					},
				];
				const images = { 'screenshot.png': 'data:image/png;base64,abc123' };

				const html = generateGroupChatExportHtml(groupChat, messages, [], images, mockTheme);

				expect(html).toContain('src="data:image/png;base64,abc123"');
			});

			it('handles [Image: filename] pattern', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: '[Image: photo.jpg]' },
				];
				const images = { 'photo.jpg': 'data:image/jpeg;base64,xyz789' };

				const html = generateGroupChatExportHtml(groupChat, messages, [], images, mockTheme);

				expect(html).toContain('src="data:image/jpeg;base64,xyz789"');
			});
		});

		describe('participants section', () => {
			it('renders participants section when participants exist', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('Participants');
				expect(html).toContain('Agent1');
				expect(html).toContain('Agent2');
			});

			it('omits participants section when no participants', () => {
				const groupChat = createMockGroupChat({ participants: [] });
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				// Should not have a participants section header
				expect(html).not.toContain('class="section-title">Participants');
			});

			it('shows participant colors', () => {
				const groupChat = createMockGroupChat({
					participants: [
						{
							name: 'TestAgent',
							agentId: 'claude-code',
							sessionId: 's1',
							addedAt: 0,
							color: '#e91e63',
						},
					],
				});
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('#e91e63');
			});

			it('shows participant agent IDs', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('claude-code');
			});
		});

		describe('metadata section', () => {
			it('includes group chat ID', () => {
				const groupChat = createMockGroupChat({ id: 'unique-chat-id-123' });
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('unique-chat-id-123');
			});

			it('includes moderator agent ID', () => {
				const groupChat = createMockGroupChat({ moderatorAgentId: 'custom-moderator' });
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('custom-moderator');
			});

			it('includes creation date', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('Created');
			});
		});

		describe('footer', () => {
			it('includes Maestro attribution with runmaestro.ai', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('Exported from');
				expect(html).toContain('href="https://runmaestro.ai"');
			});
		});

		describe('edge cases', () => {
			it('handles empty messages array', () => {
				const groupChat = createMockGroupChat();

				const html = generateGroupChatExportHtml(groupChat, [], [], {}, mockTheme);

				expect(html).toContain('<!DOCTYPE html>');
			});

			it('handles empty history array', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				// Should still generate valid HTML
				expect(html).toContain('<!DOCTYPE html>');
			});

			it('handles empty images object', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('<!DOCTYPE html>');
			});

			it('handles special characters in participant names', () => {
				const groupChat = createMockGroupChat({
					participants: [
						{ name: 'Agent <Test>', agentId: 'claude-code', sessionId: 's1', addedAt: 0 },
					],
				});
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('Agent &lt;Test&gt;');
			});

			it('handles unicode in messages', () => {
				const groupChat = createMockGroupChat();
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'user', content: 'Hello! Café ☕' },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('Café');
				expect(html).toContain('☕');
			});

			it('handles very long messages', () => {
				const groupChat = createMockGroupChat();
				const longContent = 'A'.repeat(10000);
				const messages: GroupChatMessage[] = [
					{ timestamp: '2023-12-21T10:00:00Z', from: 'Agent1', content: longContent },
				];

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain(longContent);
			});
		});

		describe('CSS responsiveness', () => {
			it('includes mobile media query', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('@media (max-width: 640px)');
			});

			it('includes print media query', () => {
				const groupChat = createMockGroupChat();
				const messages = createMockMessages();

				const html = generateGroupChatExportHtml(groupChat, messages, [], {}, mockTheme);

				expect(html).toContain('@media print');
			});
		});
	});
});
