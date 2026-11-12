/**
 * Tests for the `auto_run_steering_command` wire shape.
 *
 * This module sits between a CLI that can be any version and a renderer that
 * must never be handed a half-formed request, so what is pinned here is what
 * each hop refuses and what it lets through untouched.
 */

import { describe, it, expect } from 'vitest';
import {
	STEERING_COMMAND_ACTIONS,
	isSteeringCommandAction,
	normalizeSteeringCommandResult,
	parseSteeringCommandRequest,
} from '../../shared/autoRunSteeringCommands';
import { MAX_STEERING_NOTE_LENGTH } from '../../shared/autorunSteering';

describe('isSteeringCommandAction', () => {
	it('accepts exactly the three verbs', () => {
		for (const action of STEERING_COMMAND_ACTIONS) {
			expect(isSteeringCommandAction(action), action).toBe(true);
		}
		expect(isSteeringCommandAction('steer')).toBe(false);
		expect(isSteeringCommandAction(undefined)).toBe(false);
	});
});

describe('parseSteeringCommandRequest', () => {
	it('rejects an unknown action and names the valid ones', () => {
		const parsed = parseSteeringCommandRequest({ action: 'nudge', sessionId: 'a' });
		expect(parsed).toMatchObject({ ok: false });
		expect(parsed.ok === false && parsed.error).toContain('send, list, cancel');
	});

	it('requires an agent for every verb, including the read', () => {
		for (const action of STEERING_COMMAND_ACTIONS) {
			expect(parseSteeringCommandRequest({ action, text: 'x', noteId: 'n' }).ok, action).toBe(
				false
			);
		}
	});

	it('trims a note and carries it through', () => {
		expect(
			parseSteeringCommandRequest({ action: 'send', sessionId: ' a ', text: '  steer left \n' })
		).toEqual({ ok: true, request: { action: 'send', sessionId: 'a', text: 'steer left' } });
	});

	it('rejects an empty note', () => {
		expect(parseSteeringCommandRequest({ action: 'send', sessionId: 'a', text: '   ' }).ok).toBe(
			false
		);
		expect(parseSteeringCommandRequest({ action: 'send', sessionId: 'a' }).ok).toBe(false);
	});

	// The panel caps a note as it is typed and the operator sees it stop. A
	// caller across a socket would have its instruction cut mid-sentence.
	it('refuses an over-long note rather than trimming it to fit', () => {
		const parsed = parseSteeringCommandRequest({
			action: 'send',
			sessionId: 'a',
			text: 'x'.repeat(MAX_STEERING_NOTE_LENGTH + 1),
		});
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.error).toContain(String(MAX_STEERING_NOTE_LENGTH));
	});

	it('accepts a note exactly at the limit', () => {
		expect(
			parseSteeringCommandRequest({
				action: 'send',
				sessionId: 'a',
				text: 'x'.repeat(MAX_STEERING_NOTE_LENGTH),
			}).ok
		).toBe(true);
	});

	it('treats background as an opt-in: only a literal true counts', () => {
		const withFlag = parseSteeringCommandRequest({
			action: 'send',
			sessionId: 'a',
			text: 'x',
			background: true,
		});
		expect(withFlag.ok && withFlag.request.background).toBe(true);

		for (const background of [false, 'yes', 1, null, undefined]) {
			const parsed = parseSteeringCommandRequest({
				action: 'send',
				sessionId: 'a',
				text: 'x',
				background,
			});
			expect(parsed.ok && 'background' in parsed.request, String(background)).toBe(false);
		}
	});

	it('requires a note id to cancel', () => {
		expect(parseSteeringCommandRequest({ action: 'cancel', sessionId: 'a' }).ok).toBe(false);
		expect(
			parseSteeringCommandRequest({ action: 'cancel', sessionId: 'a', noteId: ' n1 ' })
		).toEqual({ ok: true, request: { action: 'cancel', sessionId: 'a', noteId: 'n1' } });
	});

	it('drops fields a verb does not carry', () => {
		expect(
			parseSteeringCommandRequest({ action: 'list', sessionId: 'a', text: 'x', noteId: 'n' })
		).toEqual({ ok: true, request: { action: 'list', sessionId: 'a' } });
	});
});

describe('normalizeSteeringCommandResult', () => {
	it('turns a malformed answer into a failure rather than a truthy-ish success', () => {
		expect(normalizeSteeringCommandResult(undefined).success).toBe(false);
		expect(normalizeSteeringCommandResult('ok').success).toBe(false);
		expect(normalizeSteeringCommandResult({ success: 'true' }).success).toBe(false);
	});

	it('keeps the renderer error text on a failure', () => {
		expect(normalizeSteeringCommandResult({ success: false, error: 'nothing is running' })).toEqual(
			{
				success: false,
				error: 'nothing is running',
			}
		);
	});

	it('passes a list through, keeping steerable=false as an answer', () => {
		const note = { id: 'n1', text: 'steer left', timestamp: 1 };
		expect(
			normalizeSteeringCommandResult({
				success: true,
				steerable: false,
				pending: [note],
				deliveries: [{ deliveryId: 'd1', notes: [note] }],
				extra: 'ignored',
			})
		).toEqual({
			success: true,
			steerable: false,
			pending: [note],
			deliveries: [{ deliveryId: 'd1', notes: [note] }],
		});
	});

	it('drops list fields that are not lists', () => {
		expect(normalizeSteeringCommandResult({ success: true, pending: 'none' })).toEqual({
			success: true,
		});
	});
});
