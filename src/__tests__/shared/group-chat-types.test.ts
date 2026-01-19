/**
 * Tests for shared group chat type definitions and utility functions
 *
 * @file src/shared/group-chat-types.ts
 */

import { describe, it, expect } from 'vitest';
import { normalizeMentionName, mentionMatches } from '../../shared/group-chat-types';
import type {
	GroupChatParticipant,
	GroupChat,
	GroupChatMessage,
	GroupChatState,
	GroupChatHistoryEntry,
	GroupChatHistoryEntryType,
	ModeratorConfig,
} from '../../shared/group-chat-types';

// ============================================================================
// normalizeMentionName
// ============================================================================

describe('normalizeMentionName', () => {
	it('should return unchanged name when no spaces', () => {
		expect(normalizeMentionName('claude')).toBe('claude');
		expect(normalizeMentionName('test-agent')).toBe('test-agent');
	});

	it('should replace single space with hyphen', () => {
		expect(normalizeMentionName('My Agent')).toBe('My-Agent');
		expect(normalizeMentionName('Test Name')).toBe('Test-Name');
	});

	it('should replace multiple consecutive spaces with single hyphen', () => {
		expect(normalizeMentionName('My    Agent')).toBe('My-Agent');
		expect(normalizeMentionName('Test     Name')).toBe('Test-Name');
	});

	it('should handle multiple words with spaces', () => {
		expect(normalizeMentionName('My Test Agent')).toBe('My-Test-Agent');
		expect(normalizeMentionName('Very Long Agent Name')).toBe('Very-Long-Agent-Name');
	});

	it('should handle leading and trailing spaces', () => {
		expect(normalizeMentionName(' Agent ')).toBe('-Agent-');
		expect(normalizeMentionName('  Test  ')).toBe('-Test-');
	});

	it('should handle empty string', () => {
		expect(normalizeMentionName('')).toBe('');
	});

	it('should handle spaces only', () => {
		expect(normalizeMentionName('   ')).toBe('-');
	});
});

// ============================================================================
// mentionMatches
// ============================================================================

describe('mentionMatches', () => {
	it('should match exact same name', () => {
		expect(mentionMatches('claude', 'claude')).toBe(true);
		expect(mentionMatches('agent', 'agent')).toBe(true);
	});

	it('should match case-insensitively', () => {
		expect(mentionMatches('Claude', 'claude')).toBe(true);
		expect(mentionMatches('claude', 'Claude')).toBe(true);
		expect(mentionMatches('CLAUDE', 'claude')).toBe(true);
	});

	it('should match hyphenated mention to spaced name', () => {
		expect(mentionMatches('My-Agent', 'My Agent')).toBe(true);
		expect(mentionMatches('Test-Name', 'Test Name')).toBe(true);
	});

	it('should match hyphenated mention to spaced name case-insensitively', () => {
		expect(mentionMatches('my-agent', 'My Agent')).toBe(true);
		expect(mentionMatches('MY-AGENT', 'my agent')).toBe(true);
	});

	it('should not match different names', () => {
		expect(mentionMatches('claude', 'agent')).toBe(false);
		expect(mentionMatches('My-Agent', 'Other Agent')).toBe(false);
	});

	it('should not match partial names', () => {
		expect(mentionMatches('clau', 'claude')).toBe(false);
		expect(mentionMatches('My', 'My Agent')).toBe(false);
	});

	it('should handle empty strings', () => {
		expect(mentionMatches('', '')).toBe(true);
		expect(mentionMatches('', 'claude')).toBe(false);
		expect(mentionMatches('claude', '')).toBe(false);
	});

	it('should handle already hyphenated actual names', () => {
		expect(mentionMatches('test-agent', 'test-agent')).toBe(true);
		expect(mentionMatches('Test-Agent', 'test-agent')).toBe(true);
	});
});

// ============================================================================
// Type Definitions - Compile-time checks
// ============================================================================

describe('GroupChatParticipant type', () => {
	it('should allow valid participant objects', () => {
		const participant: GroupChatParticipant = {
			name: 'Test Agent',
			agentId: 'claude-code',
			sessionId: 'session-123',
			addedAt: Date.now(),
		};
		expect(participant.name).toBe('Test Agent');
	});

	it('should allow optional fields', () => {
		const participant: GroupChatParticipant = {
			name: 'Test Agent',
			agentId: 'claude-code',
			sessionId: 'session-123',
			addedAt: Date.now(),
			agentSessionId: 'agent-session-abc',
			lastActivity: Date.now(),
			lastSummary: 'Did some work',
			contextUsage: 50,
			color: '#ff0000',
			tokenCount: 1000,
			messageCount: 5,
			processingTimeMs: 5000,
			totalCost: 0.05,
		};
		expect(participant.color).toBe('#ff0000');
		expect(participant.totalCost).toBe(0.05);
	});
});

describe('ModeratorConfig type', () => {
	it('should allow valid config objects', () => {
		const config: ModeratorConfig = {
			customPath: '/usr/local/bin/claude',
			customArgs: '--verbose',
			customEnvVars: { API_KEY: 'test' },
		};
		expect(config.customPath).toBe('/usr/local/bin/claude');
	});

	it('should allow all optional fields', () => {
		const config: ModeratorConfig = {};
		expect(config.customPath).toBeUndefined();
	});
});

describe('GroupChat type', () => {
	it('should allow valid group chat objects', () => {
		const groupChat: GroupChat = {
			id: 'gc-123',
			name: 'Test Group',
			createdAt: Date.now(),
			moderatorAgentId: 'claude-code',
			moderatorSessionId: 'mod-session-123',
			participants: [],
			logPath: '/path/to/log.md',
			imagesDir: '/path/to/images',
		};
		expect(groupChat.id).toBe('gc-123');
	});

	it('should allow optional fields', () => {
		const groupChat: GroupChat = {
			id: 'gc-123',
			name: 'Test Group',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			moderatorAgentId: 'claude-code',
			moderatorSessionId: 'mod-session-123',
			moderatorAgentSessionId: 'agent-session-abc',
			moderatorConfig: { customPath: '/custom/path' },
			participants: [],
			logPath: '/path/to/log.md',
			imagesDir: '/path/to/images',
			draftMessage: 'Work in progress...',
		};
		expect(groupChat.draftMessage).toBe('Work in progress...');
	});
});

describe('GroupChatMessage type', () => {
	it('should allow valid message objects', () => {
		const message: GroupChatMessage = {
			timestamp: '2024-01-01T12:00:00.000Z',
			from: 'User',
			content: 'Hello world',
		};
		expect(message.content).toBe('Hello world');
	});

	it('should allow readOnly flag', () => {
		const message: GroupChatMessage = {
			timestamp: '2024-01-01T12:00:00.000Z',
			from: 'System',
			content: 'Status update',
			readOnly: true,
		};
		expect(message.readOnly).toBe(true);
	});
});

describe('GroupChatState type', () => {
	it('should accept valid states', () => {
		const states: GroupChatState[] = ['idle', 'moderator-thinking', 'agent-working'];
		expect(states).toHaveLength(3);
	});
});

describe('GroupChatHistoryEntryType type', () => {
	it('should accept valid entry types', () => {
		const types: GroupChatHistoryEntryType[] = ['delegation', 'response', 'synthesis', 'error'];
		expect(types).toHaveLength(4);
	});
});

describe('GroupChatHistoryEntry type', () => {
	it('should allow valid history entry objects', () => {
		const entry: GroupChatHistoryEntry = {
			id: 'entry-123',
			timestamp: Date.now(),
			summary: 'Completed the task',
			participantName: 'claude',
			participantColor: '#3498db',
			type: 'response',
		};
		expect(entry.type).toBe('response');
	});

	it('should allow all optional fields', () => {
		const entry: GroupChatHistoryEntry = {
			id: 'entry-123',
			timestamp: Date.now(),
			summary: 'Completed the task',
			participantName: 'claude',
			participantColor: '#3498db',
			type: 'response',
			elapsedTimeMs: 5000,
			tokenCount: 500,
			cost: 0.01,
			fullResponse: 'Full response text here...',
		};
		expect(entry.elapsedTimeMs).toBe(5000);
		expect(entry.cost).toBe(0.01);
	});
});
