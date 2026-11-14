/**
 * @file spoken-notices.test.ts
 *
 * The spoken notices core: the line, the queue, and the speaker seam, with the
 * task router, the settings store, and the speaker mocked. Properties worth
 * protecting:
 *
 *   - **Opt-in.** Nothing is spoken, and no model is called, while the setting
 *     is off or Maestro is focused in `unfocused` mode.
 *   - **Never while a voice session is live**: refused before the model is
 *     called, refused again at the moment of speaking, and cut off when a
 *     session starts under a notice.
 *   - **The plain line needs no model.** Off, unavailable, timed out, unusable,
 *     and a throwing engine all speak `<agent name> finished`.
 *   - **Throttled.** One notice at a time, with a quiet window between them:
 *     queued, never overlapping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const router = vi.hoisted(() => ({ runLocalTask: vi.fn() }));
const settings = vi.hoisted(() => ({ mode: 'always' as unknown }));
const dictation = vi.hoisted(() => ({ recording: false }));
const notices = vi.hoisted(() => ({
	reportLocalTaskUnavailable: vi.fn(),
	clearLocalTaskNotice: vi.fn(),
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock('../../../main/local-models/task-router', () => ({
	runLocalTask: router.runLocalTask,
}));
vi.mock('../../../main/local-models/task-notices', () => notices);
vi.mock('../../../main/local-models/dictation', () => ({
	isDictationRecording: () => dictation.recording,
}));
vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: () => settings.mode }),
}));
vi.mock('../../../main/prompt-manager', () => ({
	getPrompt: (id: string) => `prompt:${id}`,
}));
vi.mock('../../../main/utils/sentry', () => sentry);
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	SPOKEN_NOTICE_MAX_QUEUED,
	SPOKEN_NOTICE_QUIET_MS,
	SPOKEN_NOTICE_STALE_MS,
	__resetSpokenNotices,
	announceAgentFinished,
	announceAgentFinishedRequest,
	cancelSpokenNotices,
	isSpeakingNotice,
	registerNoticeSpeaker,
	speakNotice,
	speakNoticeRequest,
	type NoticeSpeaker,
} from '../../../main/local-models/spoken-notices';
import type { SpokenNoticeResult, SpokenNoticeSkipCode } from '../../../shared/spokenNotices';

const SOURCE = { type: 'local', modelId: 'qwen3-1.7b' } as const;
const NOTICE = { agentName: 'Backend', prompt: 'Fix the test', response: 'Fixed. Tests pass.' };
const UNFOCUSED = { appFocused: false };

/**
 * A speaker a test drives by hand: each `speak` stays open until the test
 * finishes it, so "is something speaking right now" is observable.
 */
function fakeSpeaker() {
	let refusal: { code: SpokenNoticeSkipCode; message: string } | null = null;
	const open: Array<{
		text: string;
		finish: () => void;
		fail: (error: Error) => void;
		signal: AbortSignal;
	}> = [];
	const speaker: NoticeSpeaker = {
		refusal: vi.fn(() => refusal),
		speak: vi.fn(
			(text: string, signal: AbortSignal) =>
				new Promise<void>((resolve, reject) => {
					const fail = (error: Error) => reject(error);
					signal.addEventListener('abort', () => reject(new Error('cut')), { once: true });
					open.push({ text, finish: resolve, fail, signal });
				})
		),
	};
	return {
		speaker,
		open,
		spoken: () => (speaker.speak as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]),
		refuse(next: typeof refusal) {
			refusal = next;
		},
	};
}

/** Let queued microtasks (the awaits inside the module) run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	__resetSpokenNotices();
	settings.mode = 'always';
	dictation.recording = false;
	router.runLocalTask.mockResolvedValue({ status: 'off' });
});

afterEach(() => {
	__resetSpokenNotices();
	vi.useRealTimers();
});

describe('announceAgentFinished: the gates', () => {
	it('says nothing and calls no model while the setting is off', async () => {
		const { speaker } = fakeSpeaker();
		registerNoticeSpeaker(speaker);
		settings.mode = 'off';

		const result = await announceAgentFinished(NOTICE, UNFOCUSED);

		expect(result).toMatchObject({ spoken: false, code: 'setting-off' });
		expect(router.runLocalTask).not.toHaveBeenCalled();
		expect(speaker.speak).not.toHaveBeenCalled();
	});

	it('reads an unknown stored mode as off', async () => {
		const { speaker } = fakeSpeaker();
		registerNoticeSpeaker(speaker);
		settings.mode = 'loud';

		expect(await announceAgentFinished(NOTICE, UNFOCUSED)).toMatchObject({ code: 'setting-off' });
		expect(speaker.speak).not.toHaveBeenCalled();
	});

	it('stays quiet in unfocused mode while Maestro is focused', async () => {
		const { speaker } = fakeSpeaker();
		registerNoticeSpeaker(speaker);
		settings.mode = 'unfocused';

		const result = await announceAgentFinished(NOTICE, { appFocused: true });

		expect(result).toMatchObject({ spoken: false, code: 'app-focused' });
		expect(router.runLocalTask).not.toHaveBeenCalled();
		expect(speaker.speak).not.toHaveBeenCalled();
	});

	it('speaks in unfocused mode while Maestro is not focused', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);
		settings.mode = 'unfocused';

		const pending = announceAgentFinished(NOTICE, UNFOCUSED);
		await flush();
		fake.open[0].finish();

		expect(await pending).toMatchObject({ spoken: true, text: 'Backend finished' });
	});

	it('speaks in always mode even while Maestro is focused', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);

		const pending = announceAgentFinished(NOTICE, { appFocused: true });
		await flush();
		fake.open[0].finish();

		expect(await pending).toMatchObject({ spoken: true });
	});

	it('is refused by name when nothing can speak', async () => {
		expect(await announceAgentFinished(NOTICE, UNFOCUSED)).toMatchObject({
			spoken: false,
			code: 'no-speaker',
		});
		expect(router.runLocalTask).not.toHaveBeenCalled();
	});
});

describe('announceAgentFinished: the voice session', () => {
	const LIVE = { code: 'voice-session-active' as const, message: 'A voice session is live.' };

	it('is refused before the model is called while a session is live', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);
		fake.refuse(LIVE);

		const result = await announceAgentFinished(NOTICE, UNFOCUSED);

		expect(result).toEqual({ spoken: false, ...LIVE });
		expect(router.runLocalTask).not.toHaveBeenCalled();
		expect(fake.speaker.speak).not.toHaveBeenCalled();
	});

	it('is refused at the moment of speaking when a session started while it waited', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);

		const first = speakNotice('one');
		const second = speakNotice('two');
		await flush();
		// The session starts while "one" is still being spoken.
		fake.refuse(LIVE);
		fake.open[0].finish();
		expect(await first).toMatchObject({ spoken: true });
		await vi.advanceTimersByTimeAsync(SPOKEN_NOTICE_QUIET_MS);

		expect(await second).toEqual({ spoken: false, ...LIVE });
		expect(fake.spoken()).toEqual(['one']);
	});

	it('cuts off the notice being spoken and drops the ones waiting when a session starts', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);

		const first = speakNotice('one');
		const second = speakNotice('two');
		await flush();

		cancelSpokenNotices('voice-session-active', 'A voice session started.');

		expect(fake.open[0].signal.aborted).toBe(true);
		expect(await first).toEqual({
			spoken: false,
			code: 'voice-session-active',
			message: 'A voice session started.',
		});
		expect(await second).toMatchObject({ spoken: false, code: 'voice-session-active' });
		expect(isSpeakingNotice()).toBe(false);
		expect(fake.spoken()).toEqual(['one']);
	});
});

describe('announceAgentFinished: the line', () => {
	async function lineFor(verdict: unknown): Promise<SpokenNoticeResult> {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);
		if (verdict instanceof Error) router.runLocalTask.mockRejectedValue(verdict);
		else router.runLocalTask.mockResolvedValue(verdict);

		const pending = announceAgentFinished(NOTICE, UNFOCUSED);
		await flush();
		fake.open[0].finish();
		return pending;
	}

	it('asks the spoken-notices task, with the prompt and the JSON schema', async () => {
		await lineFor({ status: 'off' });

		expect(router.runLocalTask).toHaveBeenCalledTimes(1);
		const [taskId, input] = router.runLocalTask.mock.calls[0];
		expect(taskId).toBe('spoken-notices');
		expect(input.system).toBe('prompt:spoken-notice-local');
		expect(input.prompt).toContain('Agent: Backend');
		expect(input.prompt).toContain('Fixed. Tests pass.');
		expect(input.jsonSchema).toMatchObject({ required: ['summary'] });
		expect(input.signal).toBeInstanceOf(AbortSignal);
	});

	it("speaks the model's summary behind the agent's name", async () => {
		const result = await lineFor({
			status: 'ok',
			text: '{"summary":"tests pass, two files changed"}',
			json: { summary: 'tests pass, two files changed' },
			source: SOURCE,
			durationMs: 10,
		});

		expect(result).toEqual({
			spoken: true,
			text: 'Backend finished: tests pass, two files changed',
			lineSource: 'model',
		});
		expect(notices.clearLocalTaskNotice).toHaveBeenCalledWith('spoken-notices');
	});

	it('speaks the plain line when the task is off', async () => {
		expect(await lineFor({ status: 'off' })).toEqual({
			spoken: true,
			text: 'Backend finished',
			lineSource: 'fallback',
		});
	});

	it('speaks the plain line and reports once when the model is unavailable', async () => {
		const verdict = {
			status: 'unavailable',
			source: SOURCE,
			reason: 'Qwen3 is not downloaded.',
			code: 'model-not-installed',
		};
		const result = await lineFor(verdict);

		expect(result).toMatchObject({
			spoken: true,
			text: 'Backend finished',
			lineSource: 'fallback',
		});
		expect(notices.reportLocalTaskUnavailable).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: 'spoken-notices', verdict })
		);
	});

	it('speaks the plain line when the model timed out', async () => {
		expect(await lineFor({ status: 'cancelled', source: SOURCE })).toMatchObject({
			spoken: true,
			text: 'Backend finished',
			lineSource: 'fallback',
		});
	});

	it('speaks the plain line when the model wrote nothing usable', async () => {
		expect(
			await lineFor({ status: 'ok', text: 'hello', source: SOURCE, durationMs: 5 })
		).toMatchObject({ spoken: true, text: 'Backend finished', lineSource: 'fallback' });
	});

	it('speaks the plain line and reports the bug when the engine throws', async () => {
		const result = await lineFor(new Error('engine exploded'));

		expect(result).toMatchObject({
			spoken: true,
			text: 'Backend finished',
			lineSource: 'fallback',
		});
		expect(sentry.captureException).toHaveBeenCalledTimes(1);
	});
});

describe('the queue', () => {
	it('speaks one notice at a time, with a quiet window between them', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);

		const first = speakNotice('one');
		const second = speakNotice('two');
		const third = speakNotice('three');
		await flush();

		// Only the first is speaking; the others wait rather than overlap.
		expect(fake.spoken()).toEqual(['one']);

		fake.open[0].finish();
		expect(await first).toMatchObject({ spoken: true, text: 'one', lineSource: 'given' });
		// Still quiet just before the window ends.
		await vi.advanceTimersByTimeAsync(SPOKEN_NOTICE_QUIET_MS - 1);
		expect(fake.spoken()).toEqual(['one']);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.spoken()).toEqual(['one', 'two']);

		fake.open[1].finish();
		expect(await second).toMatchObject({ spoken: true, text: 'two' });
		await vi.advanceTimersByTimeAsync(SPOKEN_NOTICE_QUIET_MS);
		expect(fake.spoken()).toEqual(['one', 'two', 'three']);

		fake.open[2].finish();
		expect(await third).toMatchObject({ spoken: true, text: 'three' });
		expect(isSpeakingNotice()).toBe(false);
	});

	it('keeps the quiet window after the last notice for one that arrives later', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);

		const first = speakNotice('one');
		await flush();
		fake.open[0].finish();
		await first;

		void speakNotice('two');
		await flush();
		expect(fake.spoken()).toEqual(['one']);
		await vi.advanceTimersByTimeAsync(SPOKEN_NOTICE_QUIET_MS);
		expect(fake.spoken()).toEqual(['one', 'two']);
	});

	it('drops the oldest waiting notice when too many pile up', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);

		const speaking = speakNotice('speaking');
		await flush();
		const waiting = Array.from({ length: SPOKEN_NOTICE_MAX_QUEUED + 1 }, (_, index) =>
			speakNotice(`waiting ${index}`)
		);
		await flush();

		// The oldest waiter gave way; the one being spoken was not interrupted.
		expect(await waiting[0]).toMatchObject({ spoken: false, code: 'superseded' });
		expect(fake.open[0].signal.aborted).toBe(false);
		fake.open[0].finish();
		expect(await speaking).toMatchObject({ spoken: true });
	});

	it('drops a notice that waited so long it is no longer news', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);

		const first = speakNotice('one');
		const second = speakNotice('two');
		await flush();
		// "one" takes longer to speak than a notice stays news.
		await vi.advanceTimersByTimeAsync(SPOKEN_NOTICE_STALE_MS + 1);
		fake.open[0].finish();
		await first;
		await vi.advanceTimersByTimeAsync(SPOKEN_NOTICE_QUIET_MS);

		expect(await second).toMatchObject({ spoken: false, code: 'stale' });
		expect(fake.spoken()).toEqual(['one']);
	});

	it('waits while a dictation is recording, then speaks', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);
		dictation.recording = true;

		const pending = speakNotice('one');
		await flush();
		await vi.advanceTimersByTimeAsync(5000);
		expect(fake.spoken()).toEqual([]);

		dictation.recording = false;
		await vi.advanceTimersByTimeAsync(1000);
		expect(fake.spoken()).toEqual(['one']);
		fake.open[0].finish();
		expect(await pending).toMatchObject({ spoken: true });
	});

	it('reports a voice that could not speak, with its reason, and carries on', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);

		const first = speakNotice('one');
		const second = speakNotice('two');
		await flush();
		fake.open[0].fail(new Error('No system speech engine is installed (espeak-ng).'));

		expect(await first).toEqual({
			spoken: false,
			code: 'speech-failed',
			message: 'No system speech engine is installed (espeak-ng).',
		});
		await vi.advanceTimersByTimeAsync(SPOKEN_NOTICE_QUIET_MS);
		fake.open[1].finish();
		expect(await second).toMatchObject({ spoken: true, text: 'two' });
	});

	it('drops what is waiting when the speaker goes away', async () => {
		const fake = fakeSpeaker();
		const unregister = registerNoticeSpeaker(fake.speaker);

		const first = speakNotice('one');
		const second = speakNotice('two');
		await flush();
		unregister();

		expect(await first).toMatchObject({ spoken: false, code: 'no-speaker' });
		expect(await second).toMatchObject({ spoken: false, code: 'no-speaker' });
		expect(await speakNotice('three')).toMatchObject({ spoken: false, code: 'no-speaker' });
	});
});

describe('speakNotice', () => {
	it('speaks whatever the setting says, because it was asked for', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);
		settings.mode = 'off';

		const pending = speakNotice('The build is green.');
		await flush();
		fake.open[0].finish();

		expect(await pending).toEqual({
			spoken: true,
			text: 'The build is green.',
			lineSource: 'given',
		});
		expect(router.runLocalTask).not.toHaveBeenCalled();
	});

	it('flattens markup before it reaches the voice', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);

		void speakNotice('**Done**\n`ok`');
		await flush();

		expect(fake.spoken()).toEqual(['Done ok']);
	});

	it('is refused while a voice session is live', async () => {
		const fake = fakeSpeaker();
		registerNoticeSpeaker(fake.speaker);
		fake.refuse({ code: 'voice-session-active', message: 'A voice session is live.' });

		expect(await speakNotice('hello')).toMatchObject({
			spoken: false,
			code: 'voice-session-active',
		});
		expect(fake.speaker.speak).not.toHaveBeenCalled();
	});

	it('has nothing to say for text that is all markup', async () => {
		const { speaker } = fakeSpeaker();
		registerNoticeSpeaker(speaker);

		expect(await speakNotice('```\ncode\n```')).toMatchObject({ spoken: false, code: 'empty' });
	});
});

describe('the transport entries', () => {
	it('refuses a speak request with no text or too much', async () => {
		await expect(speakNoticeRequest(undefined)).rejects.toThrow(/required/);
		await expect(speakNoticeRequest('   ')).rejects.toThrow(/required/);
		await expect(speakNoticeRequest('x'.repeat(601))).rejects.toThrow(/600 characters/);
	});

	it('refuses a malformed finished-turn report', async () => {
		await expect(announceAgentFinishedRequest({ agent: 'Backend' }, UNFOCUSED)).rejects.toThrow(
			/agent name/
		);
	});

	it('passes a well-formed report through', async () => {
		settings.mode = 'off';
		expect(await announceAgentFinishedRequest(NOTICE, UNFOCUSED)).toMatchObject({
			code: 'setting-off',
		});
	});
});
