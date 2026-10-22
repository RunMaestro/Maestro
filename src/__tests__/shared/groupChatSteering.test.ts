/**
 * @file groupChatSteering.test.ts
 * @description Tests for src/shared/groupChatSteering.ts - which ONE turn of a
 * running group chat round a steered message goes to, how that turn's socket
 * answer becomes a result, and the `|steered:` chat log field.
 */

import { describe, expect, it } from 'vitest';

import { STEERING_MAX_TEXT_BYTES, type SteeringResultFrame } from '../../shared/chatSteering';
import {
	formatSteeredLogField,
	GROUP_CHAT_MODERATOR_STEER_TARGET,
	GROUP_CHAT_STEER_BLOCKED_DETAILS,
	groupChatSteerBlockedReason,
	groupChatSteerResult,
	parseSteeredLogField,
	pickGroupChatSteerTarget,
	STEERED_LOG_FIELD_PREFIX,
	type GroupChatSteerTarget,
} from '../../shared/groupChatSteering';

const alice: GroupChatSteerTarget = {
	name: 'Alice',
	processId: 'group-chat-1-participant-Alice-1',
};
const bob: GroupChatSteerTarget = { name: 'Bob', processId: 'group-chat-1-participant-Bob-1' };

const frame = (
	verdict: SteeringResultFrame['verdict'],
	extra: Partial<SteeringResultFrame> = {}
): SteeringResultFrame => ({ type: 'steering', id: 's1', verdict, ...extra });

describe('groupChatSteerBlockedReason', () => {
	it('allows a plain message into a busy room', () => {
		expect(groupChatSteerBlockedReason({ busy: true, text: 'look at the tests too' })).toBeNull();
	});

	it('reports a message already on its way first, even in an idle room', () => {
		expect(
			groupChatSteerBlockedReason({ busy: false, text: 'hi', sending: true, failed: true })
		).toBe('sending');
	});

	it('reports a held item before anything about the room or the text', () => {
		expect(groupChatSteerBlockedReason({ busy: true, text: 'hi', failed: true })).toBe('held');
		expect(groupChatSteerBlockedReason({ busy: false, text: '', failed: true })).toBe('held');
	});

	it('blocks an idle room', () => {
		expect(groupChatSteerBlockedReason({ busy: false, text: 'hi' })).toBe('room-idle');
	});

	it('blocks empty and whitespace-only text', () => {
		expect(groupChatSteerBlockedReason({ busy: true, text: undefined })).toBe('nothing-to-type');
		expect(groupChatSteerBlockedReason({ busy: true, text: '  \n ' })).toBe('nothing-to-type');
	});

	it('blocks a message with images, but not an empty image list', () => {
		expect(groupChatSteerBlockedReason({ busy: true, text: 'see', images: ['data:x'] })).toBe(
			'has-images'
		);
		expect(groupChatSteerBlockedReason({ busy: true, text: 'see', images: [] })).toBeNull();
	});

	it('blocks text over the steering limit, before looking at its prefix', () => {
		expect(
			groupChatSteerBlockedReason({ busy: true, text: '/' + 'x'.repeat(STEERING_MAX_TEXT_BYTES) })
		).toBe('too-long');
	});

	it.each(['/compact', '!commit', '  /clear now', '\n!autorun doc.md'])(
		'blocks %j, which a TUI would run as a command',
		(text) => {
			expect(groupChatSteerBlockedReason({ busy: true, text })).toBe('command-prefix');
		}
	);

	it('allows a slash or bang that is not the first character', () => {
		expect(groupChatSteerBlockedReason({ busy: true, text: 'see a/b and c!' })).toBeNull();
	});

	it('words every blocked reason', () => {
		for (const detail of Object.values(GROUP_CHAT_STEER_BLOCKED_DETAILS)) {
			expect(detail.length).toBeGreaterThan(0);
		}
	});
});

describe('pickGroupChatSteerTarget', () => {
	it('picks the moderator when its turn is running, whatever the message mentions', () => {
		expect(
			pickGroupChatSteerTarget('@Alice @Bob stop', {
				moderator: 'group-chat-1-moderator-1',
				participants: [alice, bob],
			})
		).toEqual({
			target: { name: GROUP_CHAT_MODERATOR_STEER_TARGET, processId: 'group-chat-1-moderator-1' },
		});
	});

	it('blocks when nothing is running', () => {
		expect(pickGroupChatSteerTarget('hello', { participants: [] })).toEqual({
			blocked: 'no-running-turn',
		});
	});

	it('picks the one working participant when the message mentions nobody', () => {
		expect(pickGroupChatSteerTarget('also check docs', { participants: [alice] })).toEqual({
			target: alice,
		});
	});

	it('blocks as ambiguous when two participants work and the message mentions nobody', () => {
		expect(pickGroupChatSteerTarget('also check docs', { participants: [alice, bob] })).toEqual({
			blocked: 'ambiguous-target',
		});
	});

	it('picks the working participant the message mentions', () => {
		expect(
			pickGroupChatSteerTarget('@Bob use the new API', { participants: [alice, bob] })
		).toEqual({ target: bob });
	});

	it('picks a participant mentioned twice', () => {
		expect(pickGroupChatSteerTarget('@Bob and again @Bob', { participants: [alice, bob] })).toEqual(
			{ target: bob }
		);
	});

	it('blocks as ambiguous when the mentions name two working participants', () => {
		expect(
			pickGroupChatSteerTarget('@Alice and @Bob, both of you', { participants: [alice, bob] })
		).toEqual({ blocked: 'ambiguous-target' });
	});

	it('blocks when any mention names an agent that is not working', () => {
		expect(
			pickGroupChatSteerTarget('@Alice and @Carol please', { participants: [alice, bob] })
		).toEqual({ blocked: 'mention-not-working' });
		expect(pickGroupChatSteerTarget('@Carol please', { participants: [alice] })).toEqual({
			blocked: 'mention-not-working',
		});
	});
});

describe('groupChatSteerResult', () => {
	it('reports delivered with the turn that took it', () => {
		expect(groupChatSteerResult(alice, frame('delivered'))).toEqual({
			outcome: 'delivered',
			verdict: 'delivered',
			targets: ['Alice'],
		});
	});

	it.each(['absorbed', 'queued'] as const)('reports %s as settled with the turn', (verdict) => {
		expect(groupChatSteerResult(bob, frame(verdict))).toEqual({
			outcome: 'settled',
			verdict,
			targets: ['Bob'],
		});
	});

	it('reports a refusal with its reason and detail', () => {
		expect(
			groupChatSteerResult(
				alice,
				frame('refused', { refusal: 'blocking-dialog', detail: 'a permission prompt' })
			)
		).toEqual({
			outcome: 'refused',
			verdict: 'refused',
			refusal: 'blocking-dialog',
			detail: 'a permission prompt',
		});
	});

	it.each(['unknown', 'dropped'] as const)(
		'reports %s as unconfirmed, never refused',
		(verdict) => {
			expect(groupChatSteerResult(alice, frame(verdict, { detail: 'socket timed out' }))).toEqual({
				outcome: 'unconfirmed',
				verdict,
				detail: 'socket timed out',
			});
		}
	);
});

describe('steered log field', () => {
	it('round-trips plain names', () => {
		const field = formatSteeredLogField(['Moderator']);
		expect(field).toBe(`${STEERED_LOG_FIELD_PREFIX}Moderator`);
		expect(parseSteeredLogField(field)).toEqual(['Moderator']);
	});

	it('round-trips names holding commas and pipes without leaking either into the field', () => {
		const names = ['Smith, Jane', 'a|b', 'Bob'];
		const field = formatSteeredLogField(names);
		expect(field.slice(STEERED_LOG_FIELD_PREFIX.length)).not.toMatch(/\|/);
		expect(field.slice(STEERED_LOG_FIELD_PREFIX.length).split(',')).toHaveLength(3);
		expect(parseSteeredLogField(field)).toEqual(names);
	});

	it('returns null for any other field', () => {
		expect(parseSteeredLogField('readOnly')).toBeNull();
		expect(parseSteeredLogField('images:a.png')).toBeNull();
	});

	it('returns null for a field with no names', () => {
		expect(parseSteeredLogField(STEERED_LOG_FIELD_PREFIX)).toBeNull();
		expect(parseSteeredLogField(`${STEERED_LOG_FIELD_PREFIX},,`)).toBeNull();
	});

	it('keeps a name that is not valid percent-encoding as written', () => {
		expect(parseSteeredLogField(`${STEERED_LOG_FIELD_PREFIX}100%,Bob`)).toEqual(['100%', 'Bob']);
	});
});
