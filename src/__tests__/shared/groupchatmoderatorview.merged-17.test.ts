// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/groupChatModeratorView.test.ts
// Source: src/__tests__/shared/cssColor.test.ts
// Source: src/__tests__/shared/toastPosition.test.ts
// Source: src/__tests__/shared/sessionImageRefs.test.ts
// Source: src/__tests__/shared/toolOutput.test.ts
// Source: src/__tests__/shared/webLogin.test.ts
// Source: src/__tests__/shared/uuid.test.ts
// Source: src/__tests__/shared/deferredSessionContent.test.ts
// Source: src/__tests__/shared/group.test.ts
// Source: src/__tests__/shared/thinkingModes.test.ts
// Source: src/__tests__/shared/newSessionMessage.test.ts
import { describe, it, expect } from 'vitest';
import {
	MODERATOR_PARTICIPANT_NAME,
	filterGroupChatHistory,
	isDirectModeratorMessage,
} from '../../shared/groupChatModeratorView';
import type { GroupChatHistoryEntry, GroupChatMessage } from '../../shared/group-chat-types';
import { isValidCssColor } from '../../shared/cssColor';
import {
	DEFAULT_TOAST_POSITION,
	TOAST_POSITIONS,
	TOAST_POSITION_LABELS,
	describeToastPosition,
	isLeftToastPosition,
	isToastPosition,
	isTopToastPosition,
	toastSidePanel,
} from '../../shared/toastPosition';
import {
	SESSION_IMAGE_REF_PREFIX,
	isSessionImageRef,
	sessionImageRefBasename,
	sessionImageHttpPath,
} from '../../shared/sessionImageRefs';
import {
	MAX_PERSISTED_TOOL_OUTPUT_CHARS,
	compactSessionToolOutputs,
	compactToolOutput,
} from '../../shared/toolOutput';
import {
	normalizeWebDisplayName,
	normalizeWebUsername,
	validateWebPassword,
	validateWebUsername,
	WEB_LOGIN_PASSWORD_MIN,
} from '../../shared/webLogin';
import { generateUUID } from '../../shared/uuid';
import { mergeDeferredItems } from '../../shared/deferredSessionContent';
import { isWorktreeGroup, type Group } from '../../shared/types';
import { THINKING_MODES, nextThinkingMode, asThinkingMode } from '../../shared/types';
import {
	prependNewSessionMessage,
	prependNewSessionMessageOnFirstTurn,
} from '../../shared/newSessionMessage';
// Source: src/__tests__/shared/groupChatModeratorView.test.ts
describe('', () => {
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
// Source: src/__tests__/shared/cssColor.test.ts
describe('', () => {
	describe('isValidCssColor', () => {
		describe('hex colors', () => {
			it('accepts 6- and 8-digit hex', () => {
				expect(isValidCssColor('#282a36')).toBe(true);
				expect(isValidCssColor('#bd93f9')).toBe(true);
				expect(isValidCssColor('#282a36ff')).toBe(true);
			});
			it('accepts 3- and 4-digit hex', () => {
				expect(isValidCssColor('#abc')).toBe(true);
				expect(isValidCssColor('#abcd')).toBe(true);
			});
			it('rejects malformed hex', () => {
				expect(isValidCssColor('#12')).toBe(false);
				expect(isValidCssColor('#xyzxyz')).toBe(false);
				expect(isValidCssColor('282a36')).toBe(false);
			});
		});
		describe('functional notations', () => {
			it('accepts rgb() and rgba()', () => {
				expect(isValidCssColor('rgb(26, 26, 46)')).toBe(true);
				expect(isValidCssColor('rgba(189, 147, 249, 0.2)')).toBe(true);
			});
			it('accepts hsl() and hsla()', () => {
				expect(isValidCssColor('hsl(262, 83%, 58%)')).toBe(true);
				expect(isValidCssColor('hsla(262, 83%, 58%, 0.5)')).toBe(true);
			});
		});
		describe('named colors', () => {
			it('accepts CSS named colors (case-insensitive)', () => {
				expect(isValidCssColor('darkblue')).toBe(true);
				expect(isValidCssColor('rebeccapurple')).toBe(true);
				expect(isValidCssColor('Transparent')).toBe(true);
			});
			it('rejects arbitrary words that are not named colors', () => {
				expect(isValidCssColor('not-a-color')).toBe(false);
				expect(isValidCssColor('bluish')).toBe(false);
			});
		});
		describe('invalid input', () => {
			it('rejects empty and whitespace-only strings', () => {
				expect(isValidCssColor('')).toBe(false);
				expect(isValidCssColor('   ')).toBe(false);
			});
			it('rejects non-string input', () => {
				expect(isValidCssColor(null)).toBe(false);
				expect(isValidCssColor(undefined)).toBe(false);
				expect(isValidCssColor(42)).toBe(false);
			});
		});
	});
});
// Source: src/__tests__/shared/toastPosition.test.ts
describe('', () => {
	describe('toastPosition', () => {
		it('defaults to the historical bottom-right corner', () => {
			expect(DEFAULT_TOAST_POSITION).toBe('bottom-right');
		});
		it('validates only the four corners', () => {
			for (const position of TOAST_POSITIONS) {
				expect(isToastPosition(position)).toBe(true);
			}
			expect(isToastPosition('center')).toBe(false);
			expect(isToastPosition(undefined)).toBe(false);
			expect(isToastPosition(3)).toBe(false);
		});
		it('labels every position', () => {
			for (const position of TOAST_POSITIONS) {
				expect(TOAST_POSITION_LABELS[position].length).toBeGreaterThan(0);
			}
		});
		it('classifies each corner by edge', () => {
			expect(isTopToastPosition('top-left')).toBe(true);
			expect(isTopToastPosition('top-right')).toBe(true);
			expect(isTopToastPosition('bottom-left')).toBe(false);
			expect(isTopToastPosition('bottom-right')).toBe(false);
			expect(isLeftToastPosition('top-left')).toBe(true);
			expect(isLeftToastPosition('bottom-left')).toBe(true);
			expect(isLeftToastPosition('top-right')).toBe(false);
			expect(isLeftToastPosition('bottom-right')).toBe(false);
		});
		it('picks the side bar on the toast side', () => {
			const widths = { leftSidebarWidth: 256, rightPanelWidth: 384 };
			expect(toastSidePanel('top-left', widths)).toEqual({ width: 256, name: 'Left Bar' });
			expect(toastSidePanel('bottom-left', widths)).toEqual({ width: 256, name: 'Left Bar' });
			expect(toastSidePanel('top-right', widths)).toEqual({ width: 384, name: 'Right Bar' });
			expect(toastSidePanel('bottom-right', widths)).toEqual({ width: 384, name: 'Right Bar' });
		});
		it('describes the stack direction for each edge', () => {
			expect(describeToastPosition('top-left')).toContain('downward');
			expect(describeToastPosition('bottom-right')).toContain('upward');
		});
	});
});
// Source: src/__tests__/shared/sessionImageRefs.test.ts
describe('', () => {
	const SHA = 'a'.repeat(64);
	describe('sessionImageRefs', () => {
		it('recognizes a store reference and nothing else', () => {
			expect(isSessionImageRef(`${SESSION_IMAGE_REF_PREFIX}${SHA}.png`)).toBe(true);
			expect(isSessionImageRef('data:image/png;base64,AAAA')).toBe(false);
			expect(isSessionImageRef('https://example.com/a.png')).toBe(false);
			expect(isSessionImageRef(undefined)).toBe(false);
			expect(isSessionImageRef(42)).toBe(false);
		});
		it('returns the basename of a well-formed reference', () => {
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.png`)).toBe(`${SHA}.png`);
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.jpeg`)).toBe(`${SHA}.jpeg`);
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.svg`)).toBe(`${SHA}.svg`);
		});
		it('rejects anything the store would never have written', () => {
			// Traversal
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}../../etc/passwd`)).toBeNull();
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.png/../x.png`)).toBeNull();
			// Wrong hash shape
			expect(
				sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${'A'.repeat(64)}.png`)
			).toBeNull();
			expect(
				sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${'a'.repeat(63)}.png`)
			).toBeNull();
			// Unknown extension
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.exe`)).toBeNull();
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}`)).toBeNull();
			// Not a reference at all
			expect(sessionImageRefBasename('data:image/png;base64,AAAA')).toBeNull();
			expect(sessionImageRefBasename(null)).toBeNull();
		});
		it('builds the token-scoped HTTP path under apiBase', () => {
			expect(sessionImageHttpPath('/tok/api', `${SHA}.png`)).toBe(`/tok/api/images/${SHA}.png`);
			// A trailing slash on apiBase does not double up.
			expect(sessionImageHttpPath('/tok/api/', `${SHA}.png`)).toBe(`/tok/api/images/${SHA}.png`);
		});
	});
});
// Source: src/__tests__/shared/toolOutput.test.ts
describe('', () => {
	describe('tool output compaction', () => {
		it('bounds oversized strings and objects', () => {
			const oversized = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 100);
			for (const value of [oversized, { oversized }]) {
				const result = compactToolOutput(value);
				expect(result.truncated).toBe(true);
				expect(result.output).toContain('[tool output truncated');
				expect(result.output).toHaveLength(MAX_PERSISTED_TOOL_OUTPUT_CHARS);
				expect(compactToolOutput(result.output)).toEqual({
					output: result.output,
					truncated: false,
				});
			}
		});
		it('replaces unserializable output with a persistence-safe marker', () => {
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			expect(compactToolOutput(circular)).toEqual({
				output: '[tool output omitted: serialization failed]',
				truncated: true,
			});
		});
		it('compacts nested session tool results without mutating the session', () => {
			const output = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 100);
			const session = {
				aiTabs: [
					{
						id: 'tab-1',
						logs: [{ metadata: { toolState: { output } } }],
					},
				],
			};
			const result = compactSessionToolOutputs(session);
			expect(result.compacted).toBe(1);
			expect(result.session).not.toBe(session);
			expect(result.session.aiTabs[0].logs[0].metadata.toolState.output).toContain(
				'[tool output truncated'
			);
			expect(session.aiTabs[0].logs[0].metadata.toolState.output).toBe(output);
		});
		it('compacts tool results in closed AI tabs kept with their logs', () => {
			const output = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 100);
			const terminal = { type: 'terminal', tab: { id: 't' }, unifiedIndex: 0, closedAt: 1 };
			const session = {
				aiTabs: [],
				unifiedClosedTabHistory: [
					{
						type: 'ai',
						tab: { id: 'closed', logs: [{ metadata: { toolState: { output } } }] },
						unifiedIndex: 0,
						closedAt: 1,
					},
					terminal,
				],
			};
			const result = compactSessionToolOutputs(session);
			expect(result.compacted).toBe(1);
			const closed = result.session.unifiedClosedTabHistory;
			expect(closed[0].tab.logs[0].metadata.toolState.output).toContain('[tool output truncated');
			expect(closed[1]).toBe(terminal);
			expect(session.unifiedClosedTabHistory[0].tab.logs[0].metadata.toolState.output).toBe(output);
		});
	});
});
// Source: src/__tests__/shared/webLogin.test.ts
describe('', () => {
	describe('validateWebUsername', () => {
		it('accepts lowercase letters, digits, dot, dash, underscore', () => {
			expect(validateWebUsername('pedram')).toBeNull();
			expect(validateWebUsername('p.amini-1_x')).toBeNull();
		});
		it('normalizes case and whitespace before checking', () => {
			expect(validateWebUsername('  Pedram ')).toBeNull();
			expect(normalizeWebUsername('  Pedram ')).toBe('pedram');
		});
		it('rejects too short, too long, bad characters, bad leading character', () => {
			expect(validateWebUsername('p')).toMatch(/at least/);
			expect(validateWebUsername('a'.repeat(33))).toMatch(/at most/);
			expect(validateWebUsername('ped ram')).toMatch(/may contain/);
			expect(validateWebUsername('.pedram')).toMatch(/may contain/);
		});
	});
	describe('validateWebPassword', () => {
		it('enforces the minimum length', () => {
			expect(validateWebPassword('a'.repeat(WEB_LOGIN_PASSWORD_MIN - 1))).toMatch(/at least/);
			expect(validateWebPassword('a'.repeat(WEB_LOGIN_PASSWORD_MIN))).toBeNull();
		});
		it('rejects a non-string', () => {
			expect(validateWebPassword(undefined as unknown as string)).toMatch(/at least/);
		});
	});
	describe('normalizeWebDisplayName', () => {
		it('falls back to the username when blank', () => {
			expect(normalizeWebDisplayName('   ', 'pedram')).toBe('pedram');
			expect(normalizeWebDisplayName(undefined, 'pedram')).toBe('pedram');
		});
		it('trims and caps', () => {
			expect(normalizeWebDisplayName('  Pedram Amini ', 'pedram')).toBe('Pedram Amini');
			expect(normalizeWebDisplayName('x'.repeat(100), 'pedram')).toHaveLength(64);
		});
	});
});
// Source: src/__tests__/shared/uuid.test.ts
describe('', () => {
	describe('generateUUID', () => {
		it('should generate a valid UUID v4 format', () => {
			const uuid = generateUUID();
			// UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
			// where y is one of 8, 9, a, or b
			const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
			expect(uuid).toMatch(uuidRegex);
		});
		it('should generate unique UUIDs on each call', () => {
			const uuids = new Set<string>();
			for (let i = 0; i < 100; i++) {
				uuids.add(generateUUID());
			}
			// All 100 generated UUIDs should be unique
			expect(uuids.size).toBe(100);
		});
		it('should always have version 4 indicator at position 14', () => {
			for (let i = 0; i < 10; i++) {
				const uuid = generateUUID();
				expect(uuid[14]).toBe('4');
			}
		});
		it('should always have valid variant indicator at position 19', () => {
			for (let i = 0; i < 10; i++) {
				const uuid = generateUUID();
				// Position 19 should be 8, 9, a, or b
				expect(['8', '9', 'a', 'b']).toContain(uuid[19]);
			}
		});
		it('should return a string of exactly 36 characters', () => {
			const uuid = generateUUID();
			expect(uuid.length).toBe(36);
		});
		it('should have hyphens at the correct positions', () => {
			const uuid = generateUUID();
			expect(uuid[8]).toBe('-');
			expect(uuid[13]).toBe('-');
			expect(uuid[18]).toBe('-');
			expect(uuid[23]).toBe('-');
		});
	});
});
// Source: src/__tests__/shared/deferredSessionContent.test.ts
describe('', () => {
	type Item = {
		id?: string;
		v: number;
	};
	const keyOf = (item: Item) => item.id;
	describe('mergeDeferredItems', () => {
		it('keeps stored order, replaces matching keys in place, and appends new ones', () => {
			const merged = mergeDeferredItems<Item>(
				[
					{ id: 'a', v: 1 },
					{ id: 'b', v: 1 },
				],
				[
					{ id: 'b', v: 2 },
					{ id: 'c', v: 1 },
				],
				keyOf
			);
			expect(merged).toEqual([
				{ id: 'a', v: 1 },
				{ id: 'b', v: 2 },
				{ id: 'c', v: 1 },
			]);
		});
		it('appends keyless items rather than collapsing them', () => {
			expect(mergeDeferredItems<Item>([{ v: 1 }], [{ v: 2 }], keyOf)).toEqual([{ v: 1 }, { v: 2 }]);
		});
		it('keeps the newest entries when a limit applies', () => {
			const merged = mergeDeferredItems(['a', 'b'], ['c'], (s) => s, 2);
			expect(merged).toEqual(['b', 'c']);
		});
		it('treats missing sides as empty', () => {
			expect(mergeDeferredItems<Item>(undefined, undefined, keyOf)).toEqual([]);
		});
	});
});
// Source: src/__tests__/shared/group.test.ts
describe('', () => {
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
// Source: src/__tests__/shared/thinkingModes.test.ts
describe('', () => {
	describe('thinking mode helpers', () => {
		it('cycles off -> on -> sticky -> off', () => {
			// The composer chip and `maestro-cli tab thinking <id> cycle` share this
			// order; if it changes, a click and a CLI cycle disagree.
			expect(THINKING_MODES).toEqual(['off', 'on', 'sticky']);
			expect(nextThinkingMode('off')).toBe('on');
			expect(nextThinkingMode('on')).toBe('sticky');
			expect(nextThinkingMode('sticky')).toBe('off');
		});
		it('treats an unset mode as off', () => {
			expect(nextThinkingMode(undefined)).toBe('on');
		});
		it('narrows only the three real modes', () => {
			expect(asThinkingMode('sticky')).toBe('sticky');
			expect(asThinkingMode('loud')).toBeUndefined();
			expect(asThinkingMode(true)).toBeUndefined();
			expect(asThinkingMode(null)).toBeUndefined();
			expect(asThinkingMode(undefined)).toBeUndefined();
		});
	});
});
// Source: src/__tests__/shared/newSessionMessage.test.ts
describe('', () => {
	describe('prependNewSessionMessage', () => {
		it('prefixes the message with a separator before the prompt', () => {
			expect(prependNewSessionMessage('do the task', 'always check linting')).toBe(
				'always check linting\n\n---\n\ndo the task'
			);
		});
		it('returns the prompt unchanged when no message is provided', () => {
			expect(prependNewSessionMessage('do the task', undefined)).toBe('do the task');
		});
		it('returns the prompt unchanged for an empty or whitespace-only message', () => {
			expect(prependNewSessionMessage('do the task', '')).toBe('do the task');
			expect(prependNewSessionMessage('do the task', '   \n\t')).toBe('do the task');
		});
		it('preserves the original message body (only the empty check is trimmed)', () => {
			// Leading/trailing content inside the message is kept verbatim.
			expect(prependNewSessionMessage('prompt', '  keep me  ')).toBe(
				'  keep me  \n\n---\n\nprompt'
			);
		});
	});
	describe('prependNewSessionMessageOnFirstTurn', () => {
		it('prefixes the message when the tab has no provider session yet', () => {
			expect(prependNewSessionMessageOnFirstTurn('do the task', 'be terse', undefined)).toBe(
				'be terse\n\n---\n\ndo the task'
			);
			expect(prependNewSessionMessageOnFirstTurn('do the task', 'be terse', null)).toBe(
				'be terse\n\n---\n\ndo the task'
			);
		});
		it('leaves a resumed conversation alone, since its first turn already carried the message', () => {
			expect(prependNewSessionMessageOnFirstTurn('do the task', 'be terse', 'conv-123')).toBe(
				'do the task'
			);
		});
		it('returns the prompt unchanged on a first turn with no message configured', () => {
			expect(prependNewSessionMessageOnFirstTurn('do the task', undefined, undefined)).toBe(
				'do the task'
			);
		});
	});
});
