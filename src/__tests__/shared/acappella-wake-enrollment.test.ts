/**
 * @file acappella-wake-enrollment.test.ts
 *
 * The vocabulary both processes share for teaching the wake word a phrase:
 * where a phrase's recordings live, what the user is asked to read, when there
 * is enough to train, and what may cross the bridge.
 */

import { describe, it, expect } from 'vitest';

import {
	WAKE_ENROLLMENT_BACKGROUND_MIN_MS,
	WAKE_ENROLLMENT_MIN_CLIPS,
	canTrainWakePhrase,
	describeWakeClipRejection,
	describeWakeEnrollmentReport,
	parseWakeEnrollmentRequest,
	wakeEnrollmentActionNeedsVoice,
	wakeEnrollmentPassage,
	wakePhraseKey,
	type WakeEnrollmentReport,
} from '../../shared/acappella/wake-enrollment';

describe('wakePhraseKey', () => {
	it('names one directory for every spelling of the same phrase', () => {
		const key = wakePhraseKey('hey scout');
		expect(wakePhraseKey('Hey, Scout!')).toBe(key);
		expect(wakePhraseKey('  HEY   scout ')).toBe(key);
		expect(key).toMatch(/^hey-scout-[0-9a-f]{8}$/);
	});

	it('keeps different phrases apart, including ones that differ only in dropped characters', () => {
		expect(wakePhraseKey('hey scout')).not.toBe(wakePhraseKey('hey scott'));
		// Both lose every character to the filesystem-safe slug; the hash is what
		// stops them sharing a directory.
		const first = wakePhraseKey('привет');
		const second = wakePhraseKey('здравствуй');
		expect(first).toMatch(/^phrase-[0-9a-f]{8}$/);
		expect(first).not.toBe(second);
	});

	it('is empty for a phrase with nothing sayable in it', () => {
		expect(wakePhraseKey('')).toBe('');
		expect(wakePhraseKey(' ... !!! ')).toBe('');
	});
});

describe('wakeEnrollmentPassage', () => {
	it('uses each word of a multi-word phrase on its own, never the phrase itself', () => {
		const passage = wakeEnrollmentPassage('Hey Scout').toLowerCase();
		expect(passage).toContain('the word hey ');
		expect(passage).toContain('said scout,');
		// Reading the whole phrase into the "not the phrase" recording would teach
		// the detector that the phrase is ordinary speech.
		expect(passage).not.toContain('hey scout');
	});

	it('does not ask a one-word phrase to be read at all', () => {
		// The only word IS the phrase.
		expect(wakeEnrollmentPassage('Computer').toLowerCase()).not.toContain('computer');
	});

	it('says a repeated word once', () => {
		const passage = wakeEnrollmentPassage('go go scout').toLowerCase();
		expect(passage.match(/\bgo\b/g)).toHaveLength(1);
	});
});

describe('canTrainWakePhrase', () => {
	it('needs both enough recordings and enough other speech', () => {
		const enough = {
			clips: WAKE_ENROLLMENT_MIN_CLIPS,
			backgroundMs: WAKE_ENROLLMENT_BACKGROUND_MIN_MS,
		};
		expect(canTrainWakePhrase(enough)).toBe(true);
		expect(canTrainWakePhrase({ ...enough, clips: enough.clips - 1 })).toBe(false);
		expect(canTrainWakePhrase({ ...enough, backgroundMs: enough.backgroundMs - 1 })).toBe(false);
	});
});

describe('parseWakeEnrollmentRequest', () => {
	it('accepts every verb and trims the phrase', () => {
		expect(parseWakeEnrollmentRequest({ action: 'list' })).toEqual({ action: 'list' });
		expect(parseWakeEnrollmentRequest({ action: 'stop', phrase: 'ignored' })).toEqual({
			action: 'stop',
		});
		expect(parseWakeEnrollmentRequest({ action: 'train', phrase: ' hey scout ' })).toEqual({
			action: 'train',
			phrase: 'hey scout',
		});
		expect(
			parseWakeEnrollmentRequest({ action: 'record', phrase: 'hey scout', kind: 'background' })
		).toEqual({ action: 'record', phrase: 'hey scout', kind: 'background' });
	});

	it('takes a file path for a recording that does not come from the microphone', () => {
		expect(
			parseWakeEnrollmentRequest({
				action: 'import',
				phrase: 'hey scout',
				kind: 'phrase',
				path: '/takes/one.wav',
			})
		).toEqual({ action: 'import', phrase: 'hey scout', kind: 'phrase', path: '/takes/one.wav' });
		expect(
			parseWakeEnrollmentRequest({ action: 'import', phrase: 'hey scout', kind: 'phrase' })
		).toBeNull();
	});

	it('knows which verbs make something and so need voice switched on', () => {
		expect(
			(['record', 'import', 'train'] as const).every((action) =>
				wakeEnrollmentActionNeedsVoice(action)
			)
		).toBe(true);
		expect(
			(['list', 'status', 'stop', 'remove-last-clip', 'clear-background', 'remove'] as const).some(
				(action) => wakeEnrollmentActionNeedsVoice(action)
			)
		).toBe(false);
	});

	it('refuses an unknown verb or recording kind rather than guessing', () => {
		expect(parseWakeEnrollmentRequest(null)).toBeNull();
		expect(parseWakeEnrollmentRequest('train')).toBeNull();
		expect(parseWakeEnrollmentRequest({ action: 'upload', phrase: 'hey scout' })).toBeNull();
		expect(
			parseWakeEnrollmentRequest({ action: 'record', phrase: 'hey scout', kind: 'everything' })
		).toBeNull();
	});
});

describe('what the user is told', () => {
	const report: WakeEnrollmentReport = {
		clipsUsed: 20,
		clipsTotal: 20,
		recognized: 19,
		falseAlarms: 0,
		backgroundMs: 30_000,
		quality: 'strong',
	};

	it('puts a report in one sentence', () => {
		expect(describeWakeEnrollmentReport(report)).toBe(
			'Recognised 19 of 20 recordings, no false alarms in 30 s of other speech.'
		);
		expect(describeWakeEnrollmentReport({ ...report, falseAlarms: 1 })).toContain('1 false alarm ');
		expect(describeWakeEnrollmentReport({ ...report, falseAlarms: 2 })).toContain('2 false alarms');
	});

	it('names why a take was not kept', () => {
		expect(describeWakeClipRejection('too-short')).toMatch(/short/i);
		expect(describeWakeClipRejection('too-long')).toMatch(/longer/i);
		expect(describeWakeClipRejection('full')).toMatch(/many/i);
	});
});
