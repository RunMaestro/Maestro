/**
 * @file drill-down.test.ts
 *
 * "Tell me more", served from the retained output of the last turn.
 *
 * The property that matters most is the negative one: no follow-up dispatches a
 * new agent turn. Re-asking would cost a full round trip AND would answer a
 * different question, because the agent has moved on since the sentence the user
 * is asking about.
 */

import { describe, it, expect } from 'vitest';

import {
	DetailBuffer,
	detectDrillDownIntent,
	speakPath,
} from '../../../../main/acappella/speech/drill-down';

const DETAIL = [
	'I refactored the authentication middleware in src/main/auth/middleware.ts.',
	'The stale token check was in the refresh path.',
	'Six call sites needed updating.',
	'All eighteen tests pass.',
	'Nothing else changed.',
].join(' ');

function buffer(): DetailBuffer {
	const detail = new DetailBuffer({ sentencesPerSlice: 2 });
	detail.record({
		agentSessionId: 'agent-1',
		tabId: 'tab-7',
		detail: DETAIL,
		spoken: ['Done, the auth bug was a stale token check.'],
	});
	return detail;
}

describe('detectDrillDownIntent', () => {
	it('recognises each follow-up', () => {
		expect(detectDrillDownIntent('tell me more')).toBe('more');
		expect(detectDrillDownIntent('go on')).toBe('more');
		expect(detectDrillDownIntent('what else?')).toBe('more');
		expect(detectDrillDownIntent('say that again')).toBe('repeat');
		expect(detectDrillDownIntent('read that again')).toBe('repeat');
		expect(detectDrillDownIntent('what was the file?')).toBe('file');
		expect(detectDrillDownIntent('which file was it')).toBe('file');
		expect(detectDrillDownIntent('show me that')).toBe('show');
		expect(detectDrillDownIntent('pull up the diff')).toBe('show');
	});

	it('leaves a real request alone', () => {
		expect(detectDrillDownIntent('run the tests again')).toBeNull();
		expect(detectDrillDownIntent('open a new tab for the migration')).toBeNull();
		expect(detectDrillDownIntent('show me the backlog for next sprint')).toBeNull();
		expect(detectDrillDownIntent('')).toBeNull();
	});

	it('prefers show over file, because a request to LOOK is answered on screen', () => {
		expect(detectDrillDownIntent('show me the file')).toBe('show');
	});
});

describe('DetailBuffer', () => {
	it('serves successive slices of detail without a new agent turn', () => {
		const detail = buffer();

		expect(detail.serve('more')).toEqual({
			kind: 'speak',
			text: 'I refactored the authentication middleware in src/main/auth/middleware.ts. The stale token check was in the refresh path.',
		});
		expect(detail.serve('more')).toEqual({
			kind: 'speak',
			text: 'Six call sites needed updating. All eighteen tests pass.',
		});
		expect(detail.serve('more')).toEqual({ kind: 'speak', text: 'Nothing else changed.' });
		expect(detail.serve('more')).toEqual({ kind: 'speak', text: "That's everything it said." });
	});

	it('repeats exactly what was said, not a fresh rewrite of it', () => {
		const detail = buffer();
		detail.noteSpoken(['Want the details?']);

		expect(detail.serve('repeat')).toEqual({
			kind: 'speak',
			text: 'Done, the auth bug was a stale token check. Want the details?',
		});
	});

	it('names the file the way a person would say it', () => {
		expect(buffer().serve('file')).toEqual({ kind: 'speak', text: 'It was middleware dot ts.' });
	});

	it('says so when no file was named rather than inventing one', () => {
		const detail = new DetailBuffer();
		detail.record({
			agentSessionId: 'agent-1',
			tabId: 'tab-7',
			detail: 'It all worked out fine in the end.',
			spoken: [],
		});

		expect(detail.serve('file')).toEqual({ kind: 'speak', text: 'It did not name a file.' });
	});

	it('answers "show me" on screen and says nothing at all', () => {
		expect(buffer().serve('show')).toEqual({
			kind: 'focus',
			agentSessionId: 'agent-1',
			tabId: 'tab-7',
			path: 'src/main/auth/middleware.ts',
		});
	});

	it('has nothing to serve before a turn is recorded, and nothing after it is cleared', () => {
		const detail = new DetailBuffer();
		expect(detail.hasTurn).toBe(false);
		expect(detail.serve('more')).toEqual({ kind: 'none' });

		const live = buffer();
		live.clear();
		expect(live.serve('repeat')).toEqual({ kind: 'none' });
	});

	it('rewinds the read cursor when a new turn replaces the old one', () => {
		const detail = buffer();
		detail.serve('more');
		detail.record({
			agentSessionId: 'agent-2',
			tabId: 'tab-9',
			detail: 'A brand new answer entirely.',
			spoken: [],
		});

		expect(detail.serve('more')).toEqual({ kind: 'speak', text: 'A brand new answer entirely.' });
	});
});

describe('speakPath', () => {
	it('says the basename and its extension, never the directories', () => {
		expect(speakPath('src/main/acappella/speech/speech-scheduler.ts')).toBe(
			'speech-scheduler dot ts'
		);
		expect(speakPath('C:\\Users\\dev\\project\\index.ts')).toBe('index dot ts');
		expect(speakPath('Makefile')).toBe('Makefile');
	});
});
