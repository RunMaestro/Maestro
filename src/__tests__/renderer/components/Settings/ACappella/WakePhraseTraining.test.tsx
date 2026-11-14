/**
 * @file WakePhraseTraining.test.tsx
 *
 * Teaching the wake word a phrase, as the user meets it in Voice Controls: the
 * row that says whether the phrase is trained, and the dialog that records and
 * trains it. The flow itself runs in the main process; what is under test here
 * is that the panel asks for the right thing, shows what it is told, and never
 * leaves a microphone open behind a closed dialog.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { VoiceControlsPanel } from '../../../../../renderer/components/Settings/ACappella/VoiceControlsPanel';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import {
	wakePhraseKey,
	type WakeEnrollmentEvent,
	type WakeEnrollmentReply,
	type WakeEnrollmentReport,
	type WakeEnrollmentRequest,
	type WakeEnrollmentStatus,
} from '../../../../../shared/acappella/wake-enrollment';
import { mockTheme } from '../../../../helpers/mockTheme';

vi.mock('../../../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		shortcuts: {},
		setShortcuts: vi.fn(),
		tabShortcuts: {},
		setTabShortcuts: vi.fn(),
	}),
}));

const voice = () => window.maestro.voice;
const PHRASE = 'hey scout';
const KEY = wakePhraseKey(PHRASE);

const REPORT: WakeEnrollmentReport = {
	clipsUsed: 20,
	clipsTotal: 20,
	recognized: 19,
	falseAlarms: 0,
	backgroundMs: 30_000,
	quality: 'strong',
};

function status(overrides: Partial<WakeEnrollmentStatus> = {}): WakeEnrollmentStatus {
	return {
		phrase: PHRASE,
		key: KEY,
		clips: 0,
		backgroundMs: 0,
		model: null,
		recording: null,
		training: false,
		...overrides,
	};
}

/** What the main process holds for the phrase. Every reply reads it. */
let current: WakeEnrollmentStatus;
/** Every request the panel sent, in order. */
let requests: WakeEnrollmentRequest[];
/** Push an event the way the main process would. */
let emit: (event: WakeEnrollmentEvent) => void;
/** Replies that are not "here is the status", by action. */
let replies: Partial<Record<WakeEnrollmentRequest['action'], WakeEnrollmentReply>>;

function requestsFor(action: WakeEnrollmentRequest['action']): WakeEnrollmentRequest[] {
	return requests.filter((request) => request.action === action);
}

async function renderPanel(engine: 'classifier' | 'transcription' = 'classifier') {
	vi.mocked(window.maestro.settings.get).mockResolvedValue({
		controls: { wakePhrase: PHRASE, wakeEngine: engine },
	});
	render(
		<LayerStackProvider>
			<VoiceControlsPanel theme={mockTheme} enabled />
		</LayerStackProvider>
	);
	// The phrase arrives from settings, then the status read for it lands.
	await waitFor(() => expect(requestsFor('status').at(-1)).toMatchObject({ phrase: PHRASE }));
	await waitFor(() =>
		expect((screen.getByTestId('wake-phrase-train-open') as HTMLButtonElement).disabled).toBe(false)
	);
}

async function openDialog() {
	fireEvent.click(screen.getByTestId('wake-phrase-train-open'));
	await screen.findByTestId('wake-phrase-training-modal');
}

beforeEach(() => {
	vi.clearAllMocks();
	current = status();
	requests = [];
	replies = {};
	emit = () => undefined;
	vi.mocked(voice().getRoster).mockResolvedValue([]);
	vi.mocked(voice().hotkeyStatus).mockResolvedValue({ statuses: [], note: '' });
	vi.mocked(voice().wakeEnrollment).mockImplementation(async (request) => {
		requests.push(request);
		return replies[request.action] ?? { ok: true, status: current };
	});
	vi.mocked(voice().onWakeEnrollment).mockImplementation((handler) => {
		emit = handler;
		return () => {
			emit = () => undefined;
		};
	});
	useModalStore.getState().closeModal('confirm');
});

describe('the row in the Wake word card', () => {
	it("says a phrase of the user's own cannot fire yet, and offers to train it", async () => {
		await renderPanel();

		expect(screen.getByText(/No trained model exists for/)).toBeTruthy();
		expect(screen.getByText(/Train it from\s+your own voice below/)).toBeTruthy();
		expect(screen.getByTestId('wake-phrase-train-open').textContent).toContain('Train');
		expect(screen.queryByTestId('wake-phrase-quality')).toBeNull();
	});

	it('drops the warning and reports the result once the phrase is trained', async () => {
		current = status({ clips: 20, backgroundMs: 30_000, model: { trainedAt: 1, report: REPORT } });
		await renderPanel();

		await waitFor(() => expect(screen.queryByText(/No trained model exists for/)).toBeNull());
		expect(
			screen.getByText(/Trained from 20 recordings\. Recognised 19 of 20 recordings/)
		).toBeTruthy();
		expect(screen.getByTestId('wake-phrase-quality').textContent).toMatch(/Stands well apart/);
		expect(screen.getByTestId('wake-phrase-train-open').textContent).toContain('Improve');
	});

	it('counts recordings that have not been trained yet', async () => {
		current = status({ clips: 5 });
		await renderPanel();

		expect(await screen.findByText('5 recordings so far, not trained yet.')).toBeTruthy();
	});
});

describe('recording', () => {
	it('asks the main process to record the phrase, and to stop', async () => {
		await renderPanel();
		await openDialog();

		fireEvent.click(screen.getByTestId('wake-training-record-phrase'));
		await waitFor(() =>
			expect(requestsFor('record')).toEqual([{ action: 'record', phrase: PHRASE, kind: 'phrase' }])
		);

		current = status({ recording: 'phrase', clips: 3 });
		act(() => emit({ type: 'status', status: current }));
		expect(screen.getByTestId('wake-training-clip-count').textContent).toBe('3 of 20');
		expect(screen.getByText('Listening. Say the phrase.')).toBeTruthy();
		expect(screen.getByTestId('wake-training-level')).toBeTruthy();

		fireEvent.click(screen.getByTestId('wake-training-record-phrase'));
		await waitFor(() => expect(requestsFor('stop')).toHaveLength(1));
	});

	it("ignores another phrase's progress on the shared channel", async () => {
		await renderPanel();
		await openDialog();

		act(() =>
			emit({
				type: 'status',
				status: status({ phrase: 'ok maestro', key: 'ok-maestro-1', clips: 9 }),
			})
		);
		act(() => emit({ type: 'clip-rejected', key: 'ok-maestro-1', reason: 'too-short' }));

		expect(screen.getByTestId('wake-training-clip-count').textContent).toBe('0 of 20');
		expect(screen.queryByText(/Too short/)).toBeNull();
	});

	it('says why a take was not kept', async () => {
		await renderPanel();
		await openDialog();

		act(() => emit({ type: 'clip-rejected', key: KEY, reason: 'too-long' }));

		expect(screen.getByText(/longer than a wake phrase/)).toBeTruthy();
	});

	it('shows why a recording could not start', async () => {
		replies.record = { ok: false, reason: 'End the voice session first, then record the phrase.' };
		await renderPanel();
		await openDialog();

		fireEvent.click(screen.getByTestId('wake-training-record-phrase'));

		expect((await screen.findByTestId('wake-training-error')).textContent).toContain(
			'End the voice session first'
		);
	});

	it('records other speech, shows the passage, and can start over', async () => {
		current = status({ backgroundMs: 12_500 });
		await renderPanel();
		await openDialog();

		expect(screen.getByTestId('wake-training-background').textContent).toBe('12 of 30 s');
		// The passage uses the phrase's words apart, never the phrase.
		expect(screen.getByText(/The word hey came up/)).toBeTruthy();

		fireEvent.click(screen.getByTestId('wake-training-record-background'));
		await waitFor(() =>
			expect(requestsFor('record')).toEqual([
				{ action: 'record', phrase: PHRASE, kind: 'background' },
			])
		);
		fireEvent.click(screen.getByTestId('wake-training-clear-background'));
		await waitFor(() => expect(requestsFor('clear-background')).toHaveLength(1));
	});

	it('removes the last take', async () => {
		current = status({ clips: 4 });
		await renderPanel();
		await openDialog();

		fireEvent.click(screen.getByTestId('wake-training-undo'));

		await waitFor(() =>
			expect(requestsFor('remove-last-clip')).toEqual([
				{ action: 'remove-last-clip', phrase: PHRASE },
			])
		);
	});

	it('closes the microphone when the dialog closes mid-recording', async () => {
		await renderPanel();
		await openDialog();
		current = status({ recording: 'phrase' });
		act(() => emit({ type: 'status', status: current }));

		fireEvent.click(screen.getByTestId('wake-training-done'));

		await waitFor(() => expect(requestsFor('stop')).toHaveLength(1));
		expect(screen.queryByTestId('wake-phrase-training-modal')).toBeNull();
	});

	it('leaves the microphone alone when the dialog closes with nothing recording', async () => {
		await renderPanel();
		await openDialog();

		fireEvent.click(screen.getByTestId('wake-training-done'));

		await waitFor(() => expect(screen.queryByTestId('wake-phrase-training-modal')).toBeNull());
		expect(requestsFor('stop')).toHaveLength(0);
	});
});

describe('training', () => {
	it('will not train until there is enough, and says what is missing', async () => {
		current = status({ clips: 7, backgroundMs: 30_000 });
		await renderPanel();
		await openDialog();

		expect((screen.getByTestId('wake-training-train') as HTMLButtonElement).disabled).toBe(true);
		expect(
			screen.getByText(/Needs at least 8 recordings of the phrase and\s+12 seconds/)
		).toBeTruthy();
	});

	it('trains, shows progress, and then shows what it measured', async () => {
		current = status({ clips: 20, backgroundMs: 30_000 });
		let finish!: (reply: WakeEnrollmentReply) => void;
		await renderPanel();
		await openDialog();
		vi.mocked(voice().wakeEnrollment).mockImplementation(async (request) => {
			requests.push(request);
			if (request.action !== 'train') return { ok: true, status: current };
			return new Promise<WakeEnrollmentReply>((resolve) => (finish = resolve));
		});

		fireEvent.click(screen.getByTestId('wake-training-train'));
		await waitFor(() => expect(requestsFor('train')).toHaveLength(1));
		act(() => emit({ type: 'training', key: KEY, phase: 'comparing', progress: 0.9 }));

		expect(screen.getByTestId('wake-training-progress').getAttribute('aria-valuenow')).toBe('90');
		expect(screen.getByText('Comparing them with other speech...')).toBeTruthy();
		expect(screen.getByTestId('wake-training-train').textContent).toContain('Training...');

		current = status({
			clips: 20,
			backgroundMs: 30_000,
			model: {
				trainedAt: 2,
				report: { ...REPORT, clipsUsed: 18, advice: 'More recordings will make it more reliable.' },
			},
		});
		await act(async () => finish({ ok: true, status: current }));

		const report = await screen.findByTestId('wake-training-report');
		expect(report.textContent).toMatch(/Stands well apart from other speech/);
		expect(report.textContent).toMatch(/Recognised 19 of 18 recordings/);
		expect(report.textContent).toMatch(/2 recordings were left out/);
		expect(report.textContent).toMatch(/More recordings will make it more reliable/);
		expect(screen.queryByTestId('wake-training-progress')).toBeNull();
		expect(screen.getByTestId('wake-training-train').textContent).toContain('Train again');
	});

	it('shows why training failed', async () => {
		current = status({ clips: 20, backgroundMs: 30_000 });
		replies.train = { ok: false, reason: 'The wake word model is not installed.' };
		await renderPanel();
		await openDialog();

		fireEvent.click(screen.getByTestId('wake-training-train'));

		expect((await screen.findByTestId('wake-training-error')).textContent).toContain(
			'not installed'
		);
	});

	it("lends the card's Test run to the dialog once the phrase is trained", async () => {
		current = status({ clips: 20, backgroundMs: 30_000, model: { trainedAt: 1, report: REPORT } });
		vi.mocked(voice().wakeTest).mockResolvedValue({ started: true });
		await renderPanel();
		await openDialog();

		fireEvent.click(screen.getByTestId('wake-training-test'));

		await waitFor(() =>
			expect(voice().wakeTest).toHaveBeenCalledWith(expect.objectContaining({ phrase: PHRASE }))
		);
		expect((await screen.findByTestId('wake-training-test')).textContent).toBe('Stop test');
	});

	it('warns, and offers no Test, when Detection would not use the trained phrase', async () => {
		current = status({ clips: 20, backgroundMs: 30_000, model: { trainedAt: 1, report: REPORT } });
		await renderPanel('transcription');
		await openDialog();

		expect(
			screen.getByText(/Detection is set to Transcription, which does not use this/)
		).toBeTruthy();
		expect(screen.queryByTestId('wake-training-test')).toBeNull();
	});
});

describe('deleting', () => {
	it("asks before deleting recordings of the user's voice, then deletes", async () => {
		current = status({ clips: 20, backgroundMs: 30_000, model: { trainedAt: 1, report: REPORT } });
		await renderPanel();
		await openDialog();

		fireEvent.click(screen.getByTestId('wake-training-delete'));

		const confirm = useModalStore.getState().getData('confirm');
		expect(confirm).toMatchObject({ destructive: true });
		expect(confirm?.message).toContain(PHRASE);
		expect(requestsFor('remove')).toHaveLength(0);

		confirm?.onConfirm?.();
		await waitFor(() =>
			expect(requestsFor('remove')).toEqual([{ action: 'remove', phrase: PHRASE }])
		);
	});

	it('has nothing to delete for a phrase with nothing recorded', async () => {
		await renderPanel();
		await openDialog();

		expect((screen.getByTestId('wake-training-delete') as HTMLButtonElement).disabled).toBe(true);
	});
});
