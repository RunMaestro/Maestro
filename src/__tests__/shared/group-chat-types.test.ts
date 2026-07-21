/**
 * Tests for shared group chat type definitions and utility functions
 *
 * @file src/shared/group-chat-types.ts
 */

import { describe, it, expect } from 'vitest';
import {
	findUniqueMentionMatch,
	getMentionNameForContext,
	getMentionMatchPriority,
	mentionMatches,
	normalizeLegacyMentionName,
	normalizeMentionName,
	stripUnmatchedTrailingClosers,
} from '../../shared/group-chat-types';
import type {
	GroupChat,
	GroupChatBase,
	GroupChatHistoryEntry,
	GroupChatHistoryEntryType,
	GroupChatLogMessage,
	GroupChatMessage,
	GroupChatParticipant,
	GroupChatState,
	GroupChatStorageFields,
	GroupChatUiFields,
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

	it('should remove bracket punctuation from mention-safe names', () => {
		expect(normalizeMentionName('CIA Agent (Super Cool)')).toBe('CIA-Agent-Super-Cool');
		expect(normalizeMentionName('Review Bot [Linux]')).toBe('Review-Bot-Linux');
	});

	it('should keep legacy aliases available for bracketed names', () => {
		expect(normalizeLegacyMentionName('CIA Agent (Super Cool)')).toBe('CIA-Agent-(Super-Cool)');
		expect(normalizeLegacyMentionName('Review Bot [Linux]')).toBe('Review-Bot-[Linux]');
	});

	it('should normalize unicode compatibility forms', () => {
		expect(normalizeMentionName('ＣＩＡ Agent')).toBe('CIA-Agent');
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

describe('stripUnmatchedTrailingClosers', () => {
	it('drops an unmatched trailing closer', () => {
		expect(stripUnmatchedTrailingClosers('Client)')).toBe('Client');
		expect(stripUnmatchedTrailingClosers('plan.md)')).toBe('plan.md');
	});

	it('keeps balanced trailing brackets', () => {
		expect(stripUnmatchedTrailingClosers('CIA-Agent-(Super-Cool)')).toBe('CIA-Agent-(Super-Cool)');
		expect(stripUnmatchedTrailingClosers('Phase-01-(Setup).md')).toBe('Phase-01-(Setup).md');
	});

	it('strips only the wrapper when an earlier closer is unmatched', () => {
		// A global bracket count would over-strip the balanced "(1)" here; the
		// positional scan keeps it and removes only the trailing wrapper ")".
		expect(stripUnmatchedTrailingClosers('foo)-bar(1))')).toBe('foo)-bar(1)');
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

	it('should match mention-safe names for actual names with parentheses', () => {
		expect(mentionMatches('CIA-Agent-Super-Cool', 'CIA Agent (Super Cool)')).toBe(true);
	});

	it('should match legacy parenthesized aliases for actual names with parentheses', () => {
		expect(mentionMatches('CIA-Agent-(Super-Cool)', 'CIA Agent (Super Cool)')).toBe(true);
	});

	it('should match unicode composed and decomposed names', () => {
		expect(mentionMatches('Café-Agent', 'Café Agent')).toBe(true);
	});

	it('should ignore trailing sentence punctuation on extracted mentions', () => {
		expect(mentionMatches('Client.', 'Client')).toBe(true);
		expect(mentionMatches('Client)', 'Client')).toBe(true);
		expect(mentionMatches('Client]', 'Client')).toBe(true);
		expect(mentionMatches('CIA-Agent-(Super-Cool).', 'CIA Agent (Super Cool)')).toBe(true);
		expect(mentionMatches('CIA-Agent-(Super-Cool))', 'CIA Agent (Super Cool)')).toBe(true);
	});

	it('matches a mention captured from Markdown link text', () => {
		// `[@Client](https://example.com)` is scanned as `Client](https` because
		// brackets and `(` stay in the mention token; the link tail must be dropped.
		expect(mentionMatches('Client](https', 'Client')).toBe(true);
		expect(mentionMatches('CIA-Agent-(Super-Cool)](https', 'CIA Agent (Super Cool)')).toBe(true);
	});

	it('should rank exact and legacy matches above normalized safe matches', () => {
		expect(getMentionMatchPriority('CIA-Agent-(Super-Cool)', 'CIA Agent (Super Cool)')).toBe(3);
		expect(getMentionMatchPriority('CIA-Agent-Super-Cool', 'CIA Agent (Super Cool)')).toBe(2);
		expect(getMentionMatchPriority('CIA-Agent-(Super-Cool)', 'CIA Agent Super Cool')).toBe(1);
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

describe('findUniqueMentionMatch', () => {
	it('returns the unique highest-priority legacy alias match when safe aliases collide', () => {
		const participants = [{ name: 'CIA Agent Super Cool' }, { name: 'CIA Agent (Super Cool)' }];

		expect(
			findUniqueMentionMatch(
				'CIA-Agent-(Super-Cool)',
				participants,
				(participant) => participant.name
			)
		).toBe(participants[1]);
	});

	it('rejects ambiguous mention-safe aliases instead of returning the first match', () => {
		const participants = [{ name: 'Review Bot [Linux]' }, { name: 'Review Bot (Linux)' }];

		expect(
			findUniqueMentionMatch('Review-Bot-Linux', participants, (participant) => participant.name)
		).toBeUndefined();
	});
});

describe('getMentionNameForContext', () => {
	it('returns the plain safe alias for a unique name', () => {
		expect(getMentionNameForContext('My Agent', ['My Agent'])).toBe('My-Agent');
		expect(getMentionNameForContext('CIA Agent (Super Cool)', ['CIA Agent (Super Cool)'])).toBe(
			'CIA-Agent-Super-Cool'
		);
	});

	it('keeps a disambiguating bracketed alias when safe aliases collide', () => {
		const peers = ['Review Bot [Linux]', 'Review Bot (Linux)'];
		expect(getMentionNameForContext('Review Bot [Linux]', peers)).toBe('Review-Bot-[Linux]');
		expect(getMentionNameForContext('Review Bot (Linux)', peers)).toBe('Review-Bot-(Linux)');
	});

	it('round-trips each disambiguated alias back to its own session', () => {
		const peers = ['Review Bot [Linux]', 'Review Bot (Linux)'];
		const aliasA = getMentionNameForContext('Review Bot [Linux]', peers);
		const aliasB = getMentionNameForContext('Review Bot (Linux)', peers);
		expect(findUniqueMentionMatch(aliasA, peers, (p) => p)).toBe('Review Bot [Linux]');
		expect(findUniqueMentionMatch(aliasB, peers, (p) => p)).toBe('Review Bot (Linux)');
	});

	it('falls back to the safe alias when nothing disambiguates', () => {
		// Identical names cannot be told apart; fall back to the safe alias so the
		// mention safely no-ops instead of targeting an arbitrary peer.
		const peers = ['My Agent', 'My Agent'];
		expect(getMentionNameForContext('My Agent', peers)).toBe('My-Agent');
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

	it('composes stable, storage, and UI fields without changing persisted fixtures', () => {
		const base: GroupChatBase = {
			id: 'gc-123',
			name: 'Test Group',
			createdAt: 100,
			moderatorAgentId: 'claude-code',
			moderatorSessionId: 'moderator-1',
			participants: [],
		};
		const storage: GroupChatStorageFields = {
			updatedAt: 200,
			logPath: '/path/to/chat.log',
			imagesDir: '/path/to/images',
		};
		const ui: GroupChatUiFields = { draftMessage: 'Unsent text' };
		const composed: GroupChat = { ...base, ...storage, ...ui };
		const logLine: GroupChatLogMessage = {
			timestamp: '2024-01-01T00:00:00.000Z',
			from: 'User',
			content: 'Persisted message',
		};

		expect(JSON.parse(JSON.stringify(composed))).toMatchObject(base);
		expect(JSON.parse(JSON.stringify(logLine))).toEqual(logLine);
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
