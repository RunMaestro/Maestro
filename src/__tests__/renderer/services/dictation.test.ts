/**
 * @file dictation.test.ts
 *
 * The renderer's dictation state machine, with the main process mocked.
 * Properties worth protecting:
 *
 *   - **The transcript goes to the text box the dictation started in.**
 *   - **One dictation at a time.**
 *   - **A stop before the microphone opened cancels**, and the late answer to
 *     that start changes nothing.
 *   - **Every refusal reaches the user**, and a denied microphone offers the
 *     OS setting.
 *   - **Words are never dropped**: a text box that closed gets them in a toast.
 *   - **The shortcut writes through a registered surface's own path.**
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../renderer/stores/centerFlashStore', () => ({ notifyCenterFlash: vi.fn() }));
vi.mock('../../../renderer/utils/platformUtils', () => ({ getPlatform: () => 'darwin' }));

import {
	__resetDictationService,
	cancelDictation,
	registerDictationTarget,
	resolveDictationTarget,
	setDictationAvailabilityRefresher,
	startDictation,
	stopDictation,
	toggleDictation,
} from '../../../renderer/services/dictation';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';
import { resetDictationStore, useDictationStore } from '../../../renderer/stores/dictationStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import type { DictationTarget } from '../../../renderer/utils/dictationTargets';

const api = window.maestro.localModels.dictation;
const openMicSettings = vi.fn();

function fakeTarget(element: HTMLElement | null = null, accepts = true) {
	const insert = vi.fn(() => accepts);
	const target: DictationTarget = { getElement: () => element, insert };
	return { target, insert };
}

/** A promise a test settles by hand. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

const phase = () => useDictationStore.getState().phase;

beforeEach(() => {
	vi.clearAllMocks();
	__resetDictationService();
	resetDictationStore();
	useDictationStore.setState({ availability: { state: 'ready', source: 'Parakeet' } });
	vi.mocked(api.start).mockResolvedValue({ started: true });
	vi.mocked(api.stop).mockResolvedValue({ status: 'ok', text: 'hello world', audioMs: 900 });
	vi.mocked(api.cancel).mockResolvedValue(undefined);
	vi.mocked(api.onInterrupted).mockReturnValue(() => {});
	(window.maestro as unknown as { voice: unknown }).voice = { openMicSettings };
});

describe('start and stop', () => {
	it('records, then puts the transcript in the text box it started in', async () => {
		const { target, insert } = fakeTarget();

		await startDictation(target);
		expect(phase()).toBe('recording');
		expect(useDictationStore.getState().target).toBe(target);

		await stopDictation();

		expect(insert).toHaveBeenCalledWith('hello world');
		expect(phase()).toBe('idle');
		expect(useDictationStore.getState().target).toBeNull();
	});

	it('shows "transcribing" while the clip decodes', async () => {
		const pending = deferred<{ status: 'ok'; text: string; audioMs: number }>();
		vi.mocked(api.stop).mockReturnValue(pending.promise);
		const { target, insert } = fakeTarget();
		await startDictation(target);

		const stopping = stopDictation();
		expect(phase()).toBe('transcribing');

		pending.resolve({ status: 'ok', text: 'done', audioMs: 10 });
		await stopping;
		expect(insert).toHaveBeenCalledWith('done');
	});

	it('ignores a second start while one is in flight', async () => {
		const first = fakeTarget();
		const second = fakeTarget();
		await startDictation(first.target);
		await startDictation(second.target);

		expect(api.start).toHaveBeenCalledTimes(1);
		expect(useDictationStore.getState().target).toBe(first.target);
	});

	it('cancels a start that is stopped before the microphone opened', async () => {
		const opening = deferred<{ started: true }>();
		vi.mocked(api.start).mockReturnValue(opening.promise);
		const { target, insert } = fakeTarget();

		const starting = startDictation(target);
		expect(phase()).toBe('starting');
		await stopDictation();

		expect(api.cancel).toHaveBeenCalledTimes(1);
		expect(api.stop).not.toHaveBeenCalled();
		expect(phase()).toBe('idle');

		// The microphone's late answer must not put the dictation back.
		opening.resolve({ started: true });
		await starting;
		expect(phase()).toBe('idle');
		expect(insert).not.toHaveBeenCalled();
	});

	it('discards a transcript that arrives after a cancel', async () => {
		const pending = deferred<{ status: 'ok'; text: string; audioMs: number }>();
		vi.mocked(api.stop).mockReturnValue(pending.promise);
		const { target, insert } = fakeTarget();
		await startDictation(target);
		const stopping = stopDictation();

		await cancelDictation();
		pending.resolve({ status: 'ok', text: 'too late', audioMs: 10 });
		await stopping;

		expect(insert).not.toHaveBeenCalled();
		expect(phase()).toBe('idle');
	});

	it('stops a recording that ended on its own and keeps what was captured', async () => {
		let interrupted: (() => void) | undefined;
		vi.mocked(api.onInterrupted).mockImplementation((handler) => {
			interrupted = handler as () => void;
			return () => {};
		});
		vi.mocked(api.stop).mockResolvedValue({
			status: 'ok',
			text: 'first half',
			audioMs: 300_000,
			interruption: { code: 'max-duration', message: 'The recording reached 5 minutes.' },
		});
		const { target, insert } = fakeTarget();
		await startDictation(target);

		interrupted?.();
		await vi.waitFor(() => expect(phase()).toBe('idle'));

		expect(insert).toHaveBeenCalledWith('first half');
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Dictation stopped early',
				message: 'The recording reached 5 minutes.',
			})
		);
	});
});

describe('outcomes', () => {
	it('says so when the clip held no speech, and writes nothing', async () => {
		vi.mocked(api.stop).mockResolvedValue({ status: 'ok', text: '  ', audioMs: 400 });
		const { target, insert } = fakeTarget();
		await startDictation(target);
		await stopDictation();

		expect(insert).not.toHaveBeenCalled();
		expect(notifyCenterFlash).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'No speech heard' })
		);
	});

	it('shows the words in a toast when the text box is gone', async () => {
		const { target } = fakeTarget(null, false);
		await startDictation(target);
		await stopDictation();

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'hello world', dismissible: true })
		);
	});

	it('reports a source that could not transcribe, and re-reads readiness', async () => {
		const refresh = vi.fn();
		setDictationAvailabilityRefresher(refresh);
		vi.mocked(api.stop).mockResolvedValue({
			status: 'unavailable',
			reason: 'The endpoint did not answer.',
			code: 'endpoint-unreachable',
		});
		const { target, insert } = fakeTarget();
		await startDictation(target);
		await stopDictation();

		expect(insert).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalled();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', message: 'The endpoint did not answer.' })
		);
	});
});

describe('refusals', () => {
	it('passes the main process reason to the user and returns to idle', async () => {
		vi.mocked(api.start).mockResolvedValue({
			started: false,
			code: 'voice-session-active',
			message: 'A voice session is using the microphone.',
		});
		await startDictation(fakeTarget().target);

		expect(phase()).toBe('idle');
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'A voice session is using the microphone.' })
		);
	});

	it('re-reads readiness when the task itself is why', async () => {
		const refresh = vi.fn();
		setDictationAvailabilityRefresher(refresh);
		vi.mocked(api.start).mockResolvedValue({
			started: false,
			code: 'task-unavailable',
			message: 'Parakeet is not downloaded.',
		});
		await startDictation(fakeTarget().target);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('offers the OS microphone setting for a denied microphone', async () => {
		vi.mocked(api.start).mockResolvedValue({
			started: false,
			code: 'permission-denied',
			message: 'Maestro does not have access to the microphone.',
		});
		await startDictation(fakeTarget().target);

		const toast = vi.mocked(notifyToast).mock.calls[0][0];
		expect(toast.title).toBe('Microphone access denied');
		expect(toast.message).toContain('open privacy settings');
		toast.onClick?.();
		expect(openMicSettings).toHaveBeenCalledTimes(1);
	});

	it('says nothing for a start the user cancelled', async () => {
		vi.mocked(api.start).mockResolvedValue({
			started: false,
			code: 'cancelled',
			message: 'Dictation was cancelled.',
		});
		await startDictation(fakeTarget().target);
		expect(notifyToast).not.toHaveBeenCalled();
	});
});

describe('toggleDictation', () => {
	it('starts when idle and stops when recording', async () => {
		const { target, insert } = fakeTarget();
		toggleDictation(target);
		await vi.waitFor(() => expect(phase()).toBe('recording'));

		toggleDictation(target);
		await vi.waitFor(() => expect(phase()).toBe('idle'));
		expect(insert).toHaveBeenCalledWith('hello world');
	});

	it('asks for a text box when there is nowhere to dictate', () => {
		toggleDictation(null);
		expect(api.start).not.toHaveBeenCalled();
		expect(notifyCenterFlash).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Nowhere to dictate' })
		);
	});

	it('stops a recording even when the caret is nowhere', async () => {
		const { target, insert } = fakeTarget();
		await startDictation(target);
		toggleDictation(null);
		await vi.waitFor(() => expect(phase()).toBe('idle'));
		expect(insert).toHaveBeenCalledWith('hello world');
	});
});

describe('resolveDictationTarget', () => {
	it('prefers the registered surface that contains the focused element', () => {
		const host = document.createElement('div');
		const inner = document.createElement('textarea');
		host.appendChild(inner);
		document.body.appendChild(host);
		const { target } = fakeTarget(host);
		const unregister = registerDictationTarget(target);

		expect(resolveDictationTarget(inner)).toBe(target);

		unregister();
		const generic = resolveDictationTarget(inner);
		expect(generic).not.toBeNull();
		expect(generic).not.toBe(target);
		host.remove();
	});

	it('answers null when the focused element is not a text box', () => {
		expect(resolveDictationTarget(document.body)).toBeNull();
		expect(resolveDictationTarget(null)).toBeNull();
	});
});
