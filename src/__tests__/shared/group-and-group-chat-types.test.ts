// Source: src/__tests__/shared/group.test.ts
// Source: src/__tests__/shared/group-chat-types.test.ts
// Source: src/__tests__/shared/groupAppearance.test.ts
// Source: src/__tests__/shared/groupChatActivity.test.ts
// Source: src/__tests__/shared/groupChatModeratorView.test.ts
// Source: src/__tests__/shared/groupChatQueueModel.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { isWorktreeGroup } from '../../shared/types';
import type { Group } from '../../shared/types';
import { findSessionForParticipantName } from '../../shared/group-chat-types';
import { findAgentByGuidMention } from '../../shared/group-chat-types';
import { findParticipantSourceAgent } from '../../shared/group-chat-types';
import { isAgentGuid } from '../../shared/group-chat-types';
import { findUniqueMentionMatch } from '../../shared/group-chat-types';
import { getMentionNameForContext } from '../../shared/group-chat-types';
import { getMentionMatchPriority } from '../../shared/group-chat-types';
import { mentionMatches } from '../../shared/group-chat-types';
import { normalizeLegacyMentionName } from '../../shared/group-chat-types';
import { normalizeMentionName } from '../../shared/group-chat-types';
import { stripUnmatchedTrailingClosers } from '../../shared/group-chat-types';
import type { GroupChatParticipant } from '../../shared/group-chat-types';
import type { GroupChat } from '../../shared/group-chat-types';
import type { GroupChatMessage } from '../../shared/group-chat-types';
import type { GroupChatState } from '../../shared/group-chat-types';
import type { GroupChatHistoryEntry } from '../../shared/group-chat-types';
import type { GroupChatHistoryEntryType } from '../../shared/group-chat-types';
import type { ModeratorConfig } from '../../shared/group-chat-types';
import { GROUP_ICON_CATALOG } from '../../shared/groupAppearance';
import { GROUP_ICON_IDS } from '../../shared/groupAppearance';
import { GROUP_LABEL_COLORS } from '../../shared/groupAppearance';
import { normalizeGroupColor } from '../../shared/groupAppearance';
import { normalizeGroupIconId } from '../../shared/groupAppearance';
import { validateGroupAppearance } from '../../shared/groupAppearance';
import { validateGroupUpdate } from '../../shared/groupAppearance';
import { computeGroupChatActivity } from '../../shared/groupChatActivity';
import { GROUP_CHAT_ACTIVITY_STITCH_MS } from '../../shared/groupChatActivity';
import { MODERATOR_PARTICIPANT_NAME } from '../../shared/groupChatModeratorView';
import { filterGroupChatHistory } from '../../shared/groupChatModeratorView';
import { isDirectModeratorMessage } from '../../shared/groupChatModeratorView';
import { canDrain } from '../../shared/groupChatQueueModel';
import { completeHead } from '../../shared/groupChatQueueModel';
import { emptyQueueState } from '../../shared/groupChatQueueModel';
import { enqueueMessage } from '../../shared/groupChatQueueModel';
import { failHead } from '../../shared/groupChatQueueModel';
import { markSending } from '../../shared/groupChatQueueModel';
import { mustQueue } from '../../shared/groupChatQueueModel';
import { parseQueueState } from '../../shared/groupChatQueueModel';
import { pauseQueue } from '../../shared/groupChatQueueModel';
import { removeItem } from '../../shared/groupChatQueueModel';
import { reorderItem } from '../../shared/groupChatQueueModel';
import { requeueAtFront } from '../../shared/groupChatQueueModel';
import { requeueFailedAtFront } from '../../shared/groupChatQueueModel';
import { resumeQueue } from '../../shared/groupChatQueueModel';
import { unmarkSending } from '../../shared/groupChatQueueModel';
import type { GroupChatQueuedItem } from '../../shared/group-chat-types';
describeSourceSuite('group', () => {
	const LEGACY_WORKTREE_EMOJI = String.fromCodePoint(0x1f333);

	function createGroup(overrides: Partial<Group>): Group {
		return {
			id: 'group-1',
			name: 'Group',
			emoji: '📁',
			collapsed: false,
			...overrides,
		};
	}

	describe('isWorktreeGroup', () => {
		it('identifies a group with the worktree kind', () => {
			expect(isWorktreeGroup(createGroup({ kind: 'worktree', emoji: '📁' }))).toBe(true);
		});

		it('identifies a legacy tree emoji group', () => {
			expect(isWorktreeGroup(createGroup({ emoji: LEGACY_WORKTREE_EMOJI }))).toBe(true);
		});
		it('identifies a group when both worktree markers are present', () => {
			expect(isWorktreeGroup(createGroup({ kind: 'worktree', emoji: LEGACY_WORKTREE_EMOJI }))).toBe(
				true
			);
		});
		it('does not identify a user group as a worktree group', () => {
			expect(isWorktreeGroup(createGroup({ kind: 'user', emoji: '📁' }))).toBe(false);
		});
	});
});
describeSourceSuite('group-chat-types', () => {
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
			expect(stripUnmatchedTrailingClosers('CIA-Agent-(Super-Cool)')).toBe(
				'CIA-Agent-(Super-Cool)'
			);
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

	describe('agent GUID references', () => {
		const ID = '8dac9050-cc32-4bfa-a0e3-33bd62d8a503';
		const agents = [
			{ id: ID, name: 'CyberForce Isabelle' },
			{ id: 'aaaf249a-aa54-4114-93f6-b173c2495dcf', name: 'Archer' },
		];

		it('recognizes only a full GUID', () => {
			expect(isAgentGuid(ID)).toBe(true);
			expect(isAgentGuid(ID.toUpperCase())).toBe(true);
			expect(isAgentGuid('8dac9050')).toBe(false);
			expect(isAgentGuid('Archer')).toBe(false);
		});

		it('finds an agent by a GUID mention, ignoring markdown and trailing punctuation', () => {
			expect(findAgentByGuidMention(`**${ID}**:`, agents)?.name).toBe('CyberForce Isabelle');
			expect(findAgentByGuidMention('8dac9050', agents)).toBeUndefined();
		});

		it('links a participant by GUID, so a rename keeps the link and a delete breaks it', () => {
			const participant = { name: 'Isabelle Quinn', sourceSessionId: ID };
			expect(findParticipantSourceAgent(participant, agents)?.name).toBe('CyberForce Isabelle');
			// A different agent that took the old name is never borrowed.
			expect(
				findParticipantSourceAgent(participant, [{ id: 'other', name: 'Isabelle Quinn' }])
			).toBeUndefined();
		});

		it('falls back to a conservative name match for a participant with no GUID', () => {
			expect(findParticipantSourceAgent({ name: 'Archer' }, agents)?.id).toBe(
				'aaaf249a-aa54-4114-93f6-b173c2495dcf'
			);
			expect(
				findParticipantSourceAgent({ name: 'Review Bot [Linux]' }, [
					{ id: 'r1', name: 'Review Bot (Linux)' },
				])
			).toBeUndefined();
		});
	});

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

	// ============================================================================
	// findSessionForParticipantName
	// ============================================================================

	describe('findSessionForParticipantName', () => {
		const agents = [
			{ id: 'a', name: 'Backend' },
			{ id: 'b', name: 'Review Bot [Linux]' },
		];

		it('matches an exact name', () => {
			expect(findSessionForParticipantName('Backend', agents)).toBe(agents[0]);
		});

		it('matches the safe-normalized form of a name with spaces and brackets', () => {
			expect(findSessionForParticipantName('Review-Bot-Linux', agents)).toBe(agents[1]);
		});

		it('refuses a weak (safe-folded) match that a typed mention would accept', () => {
			expect(findSessionForParticipantName('Review Bot (Linux)', agents)).toBeUndefined();
			expect(findUniqueMentionMatch('Review Bot (Linux)', agents, (a) => a.name)).toBe(agents[1]);
		});

		it('returns undefined on a tie', () => {
			const tied = [
				{ id: 'a', name: 'Backend' },
				{ id: 'b', name: 'Backend' },
			];
			expect(findSessionForParticipantName('Backend', tied)).toBeUndefined();
		});

		it('returns undefined when nothing matches', () => {
			expect(findSessionForParticipantName('Nobody', agents)).toBeUndefined();
		});
	});

	describe('findUniqueMentionMatch minPriority', () => {
		const items = [{ name: 'Review Bot [Linux]' }];

		it('keeps the default of accepting any non-zero priority', () => {
			expect(findUniqueMentionMatch('Review Bot (Linux)', items, (i) => i.name)).toBe(items[0]);
		});

		it('drops matches below the floor', () => {
			expect(findUniqueMentionMatch('Review Bot (Linux)', items, (i) => i.name, 2)).toBeUndefined();
			expect(findUniqueMentionMatch('Review-Bot-Linux', items, (i) => i.name, 2)).toBe(items[0]);
		});
	});
});
describeSourceSuite('groupAppearance', () => {
	describe('group appearance catalog', () => {
		it('exposes the documented built-in icon ids', () => {
			expect(GROUP_ICON_IDS).toEqual([
				'folder',
				'briefcase',
				'rocket',
				'code',
				'star',
				'heart',
				'lightbulb',
				'target',
				'calendar',
				'book',
				'layers',
				'shield',
				'wrench',
				'palette',
				'archive',
				'zap',
			]);
		});

		it('labels every icon', () => {
			expect(GROUP_ICON_CATALOG.every((entry) => entry.label.length > 0)).toBe(true);
		});

		it('stores every built-in color as an uppercase hex value', () => {
			for (const color of GROUP_LABEL_COLORS) {
				expect(color.value).toMatch(/^#[0-9A-F]{6}$/);
			}
		});
	});

	describe('normalizeGroupIconId', () => {
		it('accepts a built-in id regardless of case or padding', () => {
			expect(normalizeGroupIconId('  Rocket ')).toBe('rocket');
		});

		it('accepts a plugin-namespaced id', () => {
			expect(normalizeGroupIconId('my-plugin/my-pack/my-icon')).toBe('my-plugin/my-pack/my-icon');
		});

		it('rejects an unknown bare id', () => {
			expect(normalizeGroupIconId('sparkle-pony')).toBeNull();
		});

		it('rejects a namespaced id with an empty segment', () => {
			expect(normalizeGroupIconId('my-plugin//my-icon')).toBeNull();
		});

		it('rejects an empty string', () => {
			expect(normalizeGroupIconId('   ')).toBeNull();
		});
	});

	describe('normalizeGroupColor', () => {
		it('uppercases a hex value', () => {
			expect(normalizeGroupColor('#ef4444')).toBe('#EF4444');
		});

		it('accepts a plugin-namespaced color id', () => {
			expect(normalizeGroupColor('my-plugin/my-pack/brand')).toBe('my-plugin/my-pack/brand');
		});

		it('rejects a three-digit hex value', () => {
			expect(normalizeGroupColor('#f44')).toBeNull();
		});

		it('rejects a CSS color name', () => {
			expect(normalizeGroupColor('red')).toBeNull();
		});
	});

	describe('validateGroupAppearance', () => {
		it('returns only the supplied fields', () => {
			const result = validateGroupAppearance({ icon: 'star' });
			expect(result).toEqual({ ok: true, value: { icon: 'star' } });
		});

		it('rejects emoji and icon together', () => {
			const result = validateGroupAppearance({ emoji: '🚀', icon: 'rocket' });
			expect(result.ok).toBe(false);
		});

		it('allows a color alongside an emoji', () => {
			const result = validateGroupAppearance({ emoji: '🚀', color: '#22c55e' });
			expect(result).toEqual({ ok: true, value: { emoji: '🚀', color: '#22C55E' } });
		});

		it('allows a color alongside an icon', () => {
			const result = validateGroupAppearance({ icon: 'shield', color: '#22c55e' });
			expect(result).toEqual({ ok: true, value: { icon: 'shield', color: '#22C55E' } });
		});

		it('names the offending value in an icon error', () => {
			const result = validateGroupAppearance({ icon: 'nope' });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain('"nope"');
		});
	});

	describe('validateGroupUpdate', () => {
		it('rejects an update with nothing in it', () => {
			const result = validateGroupUpdate({});
			expect(result).toEqual({ ok: false, error: 'Nothing to update' });
		});

		it('rejects setting and clearing the same field', () => {
			const result = validateGroupUpdate({ icon: 'star', clear: ['icon'] });
			expect(result).toEqual({ ok: false, error: 'Cannot both set and clear icon' });
		});

		it('allows clearing an emoji while setting an icon', () => {
			const result = validateGroupUpdate({ icon: 'star', clear: ['emoji'] });
			expect(result).toEqual({ ok: true, value: { icon: 'star', clear: ['emoji'] } });
		});

		it('rejects an explicitly empty name', () => {
			const result = validateGroupUpdate({ name: '   ' });
			expect(result).toEqual({ ok: false, error: 'Group name must not be empty' });
		});

		it('rejects an explicitly empty parent', () => {
			const result = validateGroupUpdate({ parentGroupId: '' });
			expect(result).toEqual({ ok: false, error: 'Parent group ID must not be empty' });
		});

		it('rejects an unknown clear target', () => {
			const result = validateGroupUpdate({ clear: ['collapsed' as never] });
			expect(result.ok).toBe(false);
		});

		it('normalizes appearance values it passes through', () => {
			const result = validateGroupUpdate({ icon: 'Rocket', color: '#a855f7' });
			expect(result).toEqual({ ok: true, value: { icon: 'rocket', color: '#A855F7' } });
		});

		it('trims a name but leaves its case to the desktop', () => {
			const result = validateGroupUpdate({ name: '  Team Alpha  ' });
			expect(result).toEqual({ ok: true, value: { name: 'Team Alpha' } });
		});

		it('carries a clear-parent request through', () => {
			const result = validateGroupUpdate({ clear: ['parent'] });
			expect(result).toEqual({ ok: true, value: { clear: ['parent'] } });
		});

		it('carries a hide request through on its own', () => {
			expect(validateGroupUpdate({ hidden: true })).toEqual({ ok: true, value: { hidden: true } });
		});

		// `false` is a real instruction (show the group), not an absent field, so it
		// must not be mistaken for an update that changes nothing.
		it('treats showing a group as a change', () => {
			expect(validateGroupUpdate({ hidden: false })).toEqual({
				ok: true,
				value: { hidden: false },
			});
		});

		it('rejects a hidden value that is not a boolean', () => {
			const result = validateGroupUpdate({ hidden: 'yes' as never });
			expect(result).toEqual({ ok: false, error: 'hidden must be true or false' });
		});
	});
});
describeSourceSuite('groupChatActivity', () => {
	const T0 = 1_700_000_000_000;

	function entry(overrides: Partial<GroupChatHistoryEntry> = {}): GroupChatHistoryEntry {
		return {
			id: `e${Math.round(overrides.timestamp ?? 0)}`,
			timestamp: T0,
			summary: 'did a thing',
			participantName: 'rc',
			participantColor: '#fff',
			type: 'response',
			...overrides,
		};
	}

	const MIN = 60_000;

	describe('computeGroupChatActivity', () => {
		it('reports zeros for an empty history', () => {
			const totals = computeGroupChatActivity([]);
			expect(totals.workingTimeMs).toBe(0);
			expect(totals.totalTurns).toBe(0);
			expect(totals.turnsWithTokens).toBe(0);
		});

		it('measures a single turn by its own duration, not by its timestamp', () => {
			const totals = computeGroupChatActivity([
				entry({ timestamp: T0 + 10 * MIN, elapsedTimeMs: 3 * MIN }),
			]);
			expect(totals.workingTimeMs).toBe(3 * MIN);
			expect(totals.measuredTurns).toBe(1);
		});

		it('collapses parallel turns instead of summing them', () => {
			// Three agents each work the same 10 minutes. That is ten minutes of
			// chat time, not thirty.
			const totals = computeGroupChatActivity([
				entry({ participantName: 'a', timestamp: T0 + 10 * MIN, elapsedTimeMs: 10 * MIN }),
				entry({ participantName: 'b', timestamp: T0 + 10 * MIN, elapsedTimeMs: 10 * MIN }),
				entry({ participantName: 'c', timestamp: T0 + 10 * MIN, elapsedTimeMs: 10 * MIN }),
			]);
			expect(totals.workingTimeMs).toBe(10 * MIN);
		});

		it('excludes an idle gap between two work blocks', () => {
			const dayLater = T0 + 24 * 60 * MIN;
			const totals = computeGroupChatActivity([
				entry({ timestamp: T0, elapsedTimeMs: 2 * MIN }),
				entry({ timestamp: dayLater, elapsedTimeMs: 2 * MIN }),
			]);
			expect(totals.workingTimeMs).toBe(4 * MIN);
		});

		it('stitches turns that land closer together than the idle gap', () => {
			// Untimed turns are points. Without stitching a whole chat reports 0m.
			const totals = computeGroupChatActivity([
				entry({ timestamp: T0 }),
				entry({ timestamp: T0 + 1 * MIN }),
				entry({ timestamp: T0 + 2 * MIN }),
			]);
			expect(totals.workingTimeMs).toBe(2 * MIN);
			expect(totals.measuredTurns).toBe(0);
			expect(totals.totalTurns).toBe(3);
		});

		it('splits blocks when the gap exceeds the stitch window', () => {
			const gap = GROUP_CHAT_ACTIVITY_STITCH_MS + MIN;
			const totals = computeGroupChatActivity([
				entry({ timestamp: T0 }),
				entry({ timestamp: T0 + MIN }),
				entry({ timestamp: T0 + MIN + gap }),
			]);
			expect(totals.workingTimeMs).toBe(MIN);
		});

		it('sorts entries itself, since the history log reads newest first', () => {
			const newestFirst = [
				entry({ timestamp: T0 + 4 * MIN, elapsedTimeMs: MIN }),
				entry({ timestamp: T0 + 2 * MIN, elapsedTimeMs: MIN }),
			];
			expect(computeGroupChatActivity(newestFirst).workingTimeMs).toBe(3 * MIN);
		});

		it('ignores a negative or missing duration rather than shrinking the union', () => {
			const totals = computeGroupChatActivity([
				entry({ timestamp: T0 + 5 * MIN, elapsedTimeMs: -1000 }),
				entry({ timestamp: T0 + 6 * MIN }),
			]);
			expect(totals.workingTimeMs).toBe(MIN);
			expect(totals.measuredTurns).toBe(0);
		});

		it('sums tokens and cost only from turns that reported them', () => {
			const totals = computeGroupChatActivity([
				entry({ timestamp: T0, tokenCount: 1000, cost: 0.25 }),
				entry({ timestamp: T0 + MIN, tokenCount: 500 }),
				entry({ timestamp: T0 + 2 * MIN }),
			]);
			expect(totals.tokenCount).toBe(1500);
			expect(totals.turnsWithTokens).toBe(2);
			expect(totals.costUsd).toBeCloseTo(0.25);
			expect(totals.turnsWithCost).toBe(1);
			expect(totals.totalTurns).toBe(3);
		});

		it('reports no token coverage when nothing recorded usage', () => {
			const totals = computeGroupChatActivity([entry({ timestamp: T0 }), entry({ timestamp: T0 })]);
			expect(totals.turnsWithTokens).toBe(0);
			expect(totals.tokenCount).toBe(0);
		});
	});
});
describeSourceSuite('groupChatModeratorView', () => {
	function message(from: string): GroupChatMessage {
		return { timestamp: new Date().toISOString(), from, content: 'hi' };
	}

	function entry(
		participantName: string,
		type: GroupChatHistoryEntry['type']
	): GroupChatHistoryEntry {
		return {
			id: `${participantName}-${type}`,
			timestamp: Date.now(),
			summary: 'did a thing',
			participantName,
			participantColor: '#fff',
			type,
		};
	}

	describe('isDirectModeratorMessage', () => {
		it('keeps the user, the moderator, and system notices', () => {
			expect(isDirectModeratorMessage(message('user'))).toBe(true);
			expect(isDirectModeratorMessage(message('moderator'))).toBe(true);
			expect(isDirectModeratorMessage(message('system'))).toBe(true);
		});

		it('drops a participant reply', () => {
			expect(isDirectModeratorMessage(message('rc'))).toBe(false);
		});

		it('drops a delegation the moderator sent to a participant', () => {
			// Logged as `moderator->{name}`, which starts with the moderator's own
			// sender name - a prefix test here would leak every delegation through.
			expect(isDirectModeratorMessage(message('moderator->rc'))).toBe(false);
		});
	});

	describe('filterGroupChatHistory', () => {
		const entries = [
			entry('You', 'user'),
			entry(MODERATOR_PARTICIPANT_NAME, 'delegation'),
			entry('rc', 'response'),
			entry(MODERATOR_PARTICIPANT_NAME, 'synthesis'),
			entry('RunMaestro.ai', 'response'),
		];

		it('returns every entry in the team view', () => {
			expect(filterGroupChatHistory(entries, false)).toBe(entries);
		});

		it('keeps the user’s prompts and the moderator’s own entries in the moderator view', () => {
			const filtered = filterGroupChatHistory(entries, true);
			expect(filtered.map((e) => e.type)).toEqual(['user', 'delegation', 'synthesis']);
		});

		it('handles an empty log', () => {
			expect(filterGroupChatHistory([], true)).toEqual([]);
		});
	});
});
describeSourceSuite('groupChatQueueModel', () => {
	const item = (id: string, text = `msg-${id}`): GroupChatQueuedItem => ({
		id,
		timestamp: Number(id.replace(/\D/g, '')) || 1,
		text,
	});

	const queueOf = (...ids: string[]) => ({ items: ids.map((id) => item(id)), paused: false });

	describe('queueing rather than sending', () => {
		it('sends directly only when the moderator is idle and nothing is waiting', () => {
			expect(mustQueue(emptyQueueState(), true)).toBe(false);
		});

		it('queues while the moderator is busy', () => {
			expect(mustQueue(emptyQueueState(), false)).toBe(true);
		});

		// Without this a message typed now would overtake messages typed earlier,
		// which defeats the only thing a queue is for.
		it('queues when anything is already waiting, even if the moderator is idle', () => {
			expect(mustQueue(queueOf('1'), true)).toBe(true);
		});

		it('queues while paused, even if the moderator is idle and the queue is empty', () => {
			expect(mustQueue({ items: [], paused: true }, true)).toBe(true);
		});
	});

	describe('T5: Stop All pauses rather than sending the next item', () => {
		// Before this, `stopAll` emitted idle after killing the moderator, the drain
		// fired on that idle, and the send auto-restarted the moderator that Stop All
		// had just killed. Pressing stop restarted the room.
		it('holds a populated queue and sends nothing', () => {
			const stopped = pauseQueue(queueOf('1', '2'));

			expect(stopped.paused).toBe(true);
			expect(stopped.items).toHaveLength(2);
			expect(canDrain(stopped, true)).toBe(false);
		});
	});

	describe('T6: a failed send is kept, marked, and never retried on its own', () => {
		it('keeps the item, marks it, and pauses', () => {
			const failed = failHead(queueOf('1', '2'), 'Encore Feature disabled');

			expect(failed.items).toHaveLength(2);
			expect(failed.items[0].failed).toBe(true);
			expect(failed.items[0].failureReason).toBe('Encore Feature disabled');
			expect(failed.items[0].text).toBe('msg-1');
			expect(failed.paused).toBe(true);
		});

		// A cause that does not clear itself would otherwise re-fire on every idle
		// forever. That is a loop, not a recovery.
		it('does not drain on the next idle', () => {
			expect(canDrain(failHead(queueOf('1'), 'boom'), true)).toBe(false);
		});

		// Refusing forever would make the resume control a dead button.
		it('drains again once the user resumes, with the mark cleared', () => {
			const resumed = resumeQueue(failHead(queueOf('1', '2'), 'boom'));

			expect(resumed.paused).toBe(false);
			expect(resumed.items[0].failed).toBeUndefined();
			expect(resumed.items[0].failureReason).toBeUndefined();
			expect(canDrain(resumed, true)).toBe(true);
		});
	});

	describe('T7: a new message while paused appends and resumes', () => {
		it('goes to the end, resumes, and preserves order', () => {
			const paused = pauseQueue(queueOf('1', '2'));
			const next = enqueueMessage(paused, item('3'));

			expect(next.paused).toBe(false);
			expect(next.items.map((i) => i.id)).toEqual(['1', '2', '3']);
			expect(canDrain(next, true)).toBe(true);
		});

		// F16: adding a message must leave the queue genuinely runnable. Un-pausing
		// while the head still carries a `failed` mark produces a queue that reports
		// itself as running, offers no Resume control, and sends nothing - a worse
		// stall than a visible pause, because there is no affordance to clear it.
		// The old version of this test only passed because it called `resumeQueue`
		// itself, which hid exactly that gap.
		it('clears a failed head so the queue can actually move, with no Resume needed', () => {
			const stuck = failHead(queueOf('1'), 'boom');
			const next = enqueueMessage(stuck, item('2'));

			expect(next.paused).toBe(false);
			expect(next.items.map((i) => i.id)).toEqual(['1', '2']);
			expect(next.items[0].failed).toBeUndefined();
			expect(next.items[0].failureReason).toBeUndefined();
			// No `resumeQueue` here on purpose: that is the point.
			expect(canDrain(next, true)).toBe(true);
		});

		// F15: a direct send that failed was handed over BEFORE anything queued while
		// it ran, so it goes back to the front rather than behind them.
		it('puts a failed direct send at the front, paused', () => {
			const queuedDuringSend = queueOf('later-1', 'later-2');
			const next = requeueFailedAtFront(queuedDuringSend, item('original'), 'boom');

			expect(next.items.map((i) => i.id)).toEqual(['original', 'later-1', 'later-2']);
			expect(next.items[0].failed).toBe(true);
			expect(next.paused).toBe(true);
			// Resume clears only the head, so the failed item must BE the head or it
			// stops the queue again later while showing as running.
			expect(canDrain(resumeQueue(next), true)).toBe(true);
		});
	});

	describe('draining', () => {
		it('will not drain an empty or paused queue', () => {
			expect(canDrain(emptyQueueState(), true)).toBe(false);
			expect(canDrain(pauseQueue(queueOf('1')), true)).toBe(false);
		});

		it('will not drain while the moderator is busy', () => {
			expect(canDrain(queueOf('1'), false)).toBe(false);
		});

		it('removes the head once delivered and leaves the rest in order', () => {
			const after = completeHead(queueOf('1', '2', '3'));
			expect(after.items.map((i) => i.id)).toEqual(['2', '3']);
		});

		it('keeps a pause across a completed send', () => {
			expect(completeHead(pauseQueue(queueOf('1', '2'))).paused).toBe(true);
		});
	});

	describe('editing the queue', () => {
		it('removes by id', () => {
			expect(removeItem(queueOf('1', '2', '3'), '2').items.map((i) => i.id)).toEqual(['1', '3']);
		});

		it('reorders and clamps an out-of-range index instead of dropping the move', () => {
			expect(reorderItem(queueOf('1', '2', '3'), '3', 0).items.map((i) => i.id)).toEqual([
				'3',
				'1',
				'2',
			]);
			expect(reorderItem(queueOf('1', '2', '3'), '1', 99).items.map((i) => i.id)).toEqual([
				'2',
				'3',
				'1',
			]);
		});

		it('ignores a reorder for an item that is gone', () => {
			const state = queueOf('1', '2');
			expect(reorderItem(state, 'missing', 0)).toBe(state);
		});
	});

	describe('steering: a message the running round never took', () => {
		it('requeueAtFront puts it first, live, without pausing or marking it', () => {
			const state = queueOf('1', '2');
			const next = requeueAtFront(state, item('9', 'steered'));
			expect(next.items.map((i) => i.id)).toEqual(['9', '1', '2']);
			expect(next.paused).toBe(false);
			expect(next.items[0]).toEqual(item('9', 'steered'));
			expect(state.items.map((i) => i.id)).toEqual(['1', '2']);
		});

		it('requeueAtFront leaves a paused queue paused', () => {
			const paused = { ...queueOf('1'), paused: true };
			expect(requeueAtFront(paused, item('9')).paused).toBe(true);
		});

		it('unmarkSending clears only the named item, in place', () => {
			const state = markSending(markSending(queueOf('1', '2', '3'), '2'), '3');
			const next = unmarkSending(state, '2');
			expect(next.items.map((i) => i.id)).toEqual(['1', '2', '3']);
			expect(next.items[1].sending).toBeUndefined();
			expect(next.items[2].sending).toBe(true);
			expect(next.paused).toBe(state.paused);
		});

		it('unmarkSending is a no-op for an item that is gone', () => {
			const state = markSending(queueOf('1'), '1');
			expect(unmarkSending(state, 'missing').items).toEqual(state.items);
		});
	});

	describe('reading a queue off disk', () => {
		// F10: a file that parses as JSON but is the wrong SHAPE is just as damaged as
		// one that does not parse. Degrading to an empty queue lets the next save
		// overwrite it, so the caller can quarantine the bytes only if this throws.
		it('rejects a top level that is not an object', () => {
			expect(() => parseQueueState(null)).toThrow();
			expect(() => parseQueueState('nonsense')).toThrow();
			expect(() => parseQueueState([])).toThrow();
		});

		it('rejects a missing or non-array items field', () => {
			expect(() => parseQueueState({})).toThrow();
			expect(() => parseQueueState({ items: 5 })).toThrow();
			expect(() => parseQueueState({ items: 'not-an-array' })).toThrow();
		});

		// Dropping one bad entry silently is the same loss one element down.
		it('rejects a malformed item rather than dropping it', () => {
			expect(() => parseQueueState({ items: [item('1'), null] })).toThrow();
			expect(() => parseQueueState({ items: [{ noId: true }] })).toThrow();
		});

		it('round-trips a paused queue', () => {
			const saved = pauseQueue(queueOf('1'));
			expect(parseQueueState(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
		});

		it('accepts a well-formed empty queue', () => {
			expect(parseQueueState({ items: [], paused: false })).toEqual({ items: [], paused: false });
		});
	});
});
