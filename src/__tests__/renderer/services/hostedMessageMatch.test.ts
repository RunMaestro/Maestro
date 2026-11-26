/**
 * M23: a host start with no named exit counts for a queued message only when the host wrote THAT
 * message's own user entry on the tab. The entry is found by the host queue item id the host stamps
 * on it (`queuedItemId`), else (an older host) by its text with whitespace collapsed, by "no text,
 * same image count" for an image-only message, and each entry belongs to one message only.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
	hostedHandoffStep,
	judgeUnnamedHostStart,
	resetHostEntryClaims,
	type HostedMessageRef,
} from '../../../renderer/services/crossAgentHandoff';
import type { LogEntry } from '../../../renderer/types';

const IMAGE = 'data:image/png;base64,AAAA';

/** A user entry the host wrote after the send boundary `b`. */
const user = (id: string, text: string, extra: Partial<LogEntry> = {}): LogEntry => ({
	id,
	timestamp: 2,
	source: 'user',
	text,
	...extra,
});

const boundary: LogEntry = { id: 'b', timestamp: 1, source: 'ai', text: 'earlier answer' };

/** How a waiting consult whose item left the host queue stands on this sync (gone just now). */
const judge = (logs: LogEntry[], message: HostedMessageRef) =>
	judgeUnnamedHostStart(
		{ state: 'busy', logs: [boundary, ...logs], thinkingStartTime: 200 },
		{ afterEntryId: 'b', message, seenQueued: true, aheadKnown: true, turnStartedAt: 100 },
		Date.now(),
		false
	);

beforeEach(() => resetHostEntryClaims());

describe('an unnamed host start belongs to the queued message whose own entry the host wrote (M23)', () => {
	describe('(a) an image-only message', () => {
		const imageOnly: HostedMessageRef = { itemId: 'q1', imageCount: 1 };

		it("is not started by the turn ahead's entry, which another client sent after the boundary", () => {
			// Before M23 the first user entry after the boundary counted as its start.
			expect(judge([user('ahead', 'a message from the phone')], imageOnly)).toBe('left');
		});

		it('is not started by an image-only entry with another number of images', () => {
			expect(judge([user('ahead', '', { images: [IMAGE, IMAGE] })], imageOnly)).toBe('left');
		});

		it('starts on its own entry: no text and the same number of images', () => {
			expect(judge([user('ahead', 'other'), user('own', '', { images: [IMAGE] })], imageOnly)).toBe(
				'started'
			);
		});

		it('starts on the entry the host stamped with its item id, whatever it holds', () => {
			expect(judge([user('own', 'rewritten', { queuedItemId: 'q1' })], imageOnly)).toBe('started');
		});
	});

	describe('(b) two queued messages with the same text', () => {
		it("an older host: the second is not started by the first one's entry", () => {
			const logs = [user('first', 'run the tests')];
			expect(judge(logs, { itemId: 'q1', text: 'run the tests' })).toBe('started');
			// Before M23 both matched the one entry, so the second consult fired early.
			expect(judge(logs, { itemId: 'q2', text: 'run the tests' })).toBe('left');
			// Its own entry comes: it starts, and the first keeps its own.
			const both = [...logs, user('second', 'run the tests')];
			expect(judge(both, { itemId: 'q2', text: 'run the tests' })).toBe('started');
			expect(judge(both, { itemId: 'q1', text: 'run the tests' })).toBe('started');
		});

		it('a host that stamps its entries: an entry stamped with the other item is never its start', () => {
			const logs = [user('first', 'run the tests', { queuedItemId: 'q1' })];
			// Judged first, so no claim stands in for the stamp.
			expect(judge(logs, { itemId: 'q2', text: 'run the tests' })).toBe('left');
			expect(judge(logs, { itemId: 'q1', text: 'run the tests' })).toBe('started');
		});

		it('a message the user deleted from the host queue is never started by its twin', () => {
			const logs = [user('kept', 'same text', { queuedItemId: 'kept-item' })];
			expect(judge(logs, { itemId: 'deleted-item', text: 'same text' })).toBe('left');
		});
	});

	describe('(c) whitespace the host reflowed', () => {
		it('starts on its entry when only the whitespace inside the text differs', () => {
			expect(
				judge([user('own', 'check the\n  cache   now')], {
					itemId: 'q1',
					text: 'check the cache now',
				})
			).toBe('started');
		});

		it('also inside a layer an older host laid the consult notes around', () => {
			const layered = 'Backend said: fine\n\n---\n\ncheck  the\tcache';
			expect(judge([user('own', layered)], { itemId: 'q1', text: 'check the cache' })).toBe(
				'started'
			);
		});
	});

	it('a hand-off: an image-only message waits through the turn ahead and runs on its own entry', () => {
		const handoffTab = (logs: LogEntry[]) => ({
			state: 'busy' as const,
			thinkingStartTime: 200,
			logs: [boundary, ...logs],
			pendingMentionHandoff: {
				targets: [],
				message: '',
				hostTurn: {
					stage: 'sent' as const,
					queueItemId: 'h1',
					afterEntryId: 'b',
					seenQueued: true,
					turnStartedAt: 100,
					imageCount: 1,
				},
			},
		});
		expect(hostedHandoffStep(handoffTab([user('ahead', 'from the phone')]), new Set())).toBe(
			'left-queue'
		);
		expect(
			hostedHandoffStep(
				handoffTab([user('ahead', 'from the phone'), user('own', '', { images: [IMAGE] })]),
				new Set()
			)
		).toBe('running');
	});
});
