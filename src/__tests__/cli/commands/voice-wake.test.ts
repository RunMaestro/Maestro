/**
 * @file voice-wake.test.ts
 * @description Tests for `maestro-cli voice wake`: every verb crosses the WS
 * bridge as one `voice_wake_enrollment` message in the shape the desktop
 * expects, a refusal from the app exits non-zero with its reason, and `add`
 * resolves the files a user typed and survives one bad file among good ones.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as path from 'path';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/storage')>()),
	readSettingValue: vi.fn(),
}));

import {
	formatWakeEnrollmentStatus,
	voiceWakeAdd,
	voiceWakeClearBackground,
	voiceWakeList,
	voiceWakeRecord,
	voiceWakeRemove,
	voiceWakeStatus,
	voiceWakeStop,
	voiceWakeTrain,
	voiceWakeUndo,
} from '../../../cli/commands/voice-wake';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { readSettingValue } from '../../../cli/services/storage';
import { ExitCode } from '../../../cli/exit-codes';
import type {
	WakeEnrollmentReply,
	WakeEnrollmentRequest,
	WakeEnrollmentStatus,
} from '../../../shared/acappella/wake-enrollment';

function status(overrides: Partial<WakeEnrollmentStatus> = {}): WakeEnrollmentStatus {
	return {
		phrase: 'hey scout',
		key: 'hey-scout-1',
		clips: 0,
		backgroundMs: 0,
		model: null,
		recording: null,
		training: false,
		...overrides,
	};
}

const TRAINED = status({
	clips: 20,
	backgroundMs: 30_000,
	model: {
		trainedAt: 1,
		report: {
			clipsUsed: 19,
			clipsTotal: 20,
			recognized: 19,
			falseAlarms: 0,
			backgroundMs: 30_000,
			quality: 'strong',
		},
	},
});

interface Sent {
	request: WakeEnrollmentRequest;
	responseType: string;
	timeout?: number;
}

/** Answer each request from `reply`, recording what was sent. */
function mockBridge(reply: (request: WakeEnrollmentRequest) => WakeEnrollmentReply) {
	const sent: Sent[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation(
					(
						payload: { type: string; request: WakeEnrollmentRequest },
						rt: string,
						timeout?: number
					) => {
						expect(payload.type).toBe('voice_wake_enrollment');
						sent.push({ request: payload.request, responseType: rt, timeout });
						return Promise.resolve({ success: true, reply: reply(payload.request) });
					}
				),
		} as never)
	);
	return sent;
}

describe('voice wake commands', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	const printed = () => logSpy.mock.calls.map(([line]) => String(line)).join('\n');
	const errors = () => errorSpy.mock.calls.map(([line]) => String(line)).join('\n');

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readSettingValue).mockReturnValue(undefined);
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`exit:${code}`);
		}) as never);
	});

	it('sends each verb as one request on the enrollment message', async () => {
		const sent = mockBridge(() => ({ ok: true, status: status() }));

		await voiceWakeStatus(' hey scout ', {});
		await voiceWakeRecord('hey scout', {});
		await voiceWakeRecord('hey scout', { otherSpeech: true });
		await voiceWakeStop({});
		await voiceWakeUndo('hey scout', {});
		await voiceWakeClearBackground('hey scout', {});
		await voiceWakeRemove('hey scout', {});

		expect(sent.map((entry) => entry.request)).toEqual([
			{ action: 'status', phrase: 'hey scout' },
			{ action: 'record', phrase: 'hey scout', kind: 'phrase' },
			{ action: 'record', phrase: 'hey scout', kind: 'background' },
			{ action: 'stop' },
			{ action: 'remove-last-clip', phrase: 'hey scout' },
			{ action: 'clear-background', phrase: 'hey scout' },
			{ action: 'remove', phrase: 'hey scout' },
		]);
		expect(new Set(sent.map((entry) => entry.responseType))).toEqual(
			new Set(['voice_wake_enrollment_result'])
		);
	});

	it('still takes --background, the spelling --other-speech replaced', async () => {
		const sent = mockBridge(() => ({ ok: true, status: status() }));

		await voiceWakeRecord('hey scout', { background: true });

		expect(sent[0].request).toEqual({ action: 'record', phrase: 'hey scout', kind: 'background' });
	});

	it('uses the configured wake phrase when none is named', async () => {
		const sent = mockBridge(() => ({ ok: true, status: status() }));

		await voiceWakeStatus(undefined, {});
		vi.mocked(readSettingValue).mockReturnValue('  hey scout  ');
		await voiceWakeTrain(undefined, {});

		expect(readSettingValue).toHaveBeenCalledWith('acappella.controls.wakePhrase');
		expect(sent.map((entry) => entry.request)).toEqual([
			{ action: 'status', phrase: 'Hey Jarvis' },
			{ action: 'train', phrase: 'hey scout' },
		]);
	});

	it('waits far longer for training than for anything else', async () => {
		const sent = mockBridge(() => ({ ok: true, status: TRAINED }));

		await voiceWakeStatus('hey scout', {});
		await voiceWakeTrain('hey scout', {});

		expect(sent[1].request).toEqual({ action: 'train', phrase: 'hey scout' });
		expect(sent[1].timeout!).toBeGreaterThan(sent[0].timeout! * 5);
		expect(printed()).toContain('Trained (strong). Recognised 19 of 19 recordings');
	});

	it("exits non-zero with the app's own reason when the app refuses", async () => {
		mockBridge(() => ({
			ok: false,
			reason: 'End the voice session first, then record the phrase.',
		}));

		await expect(voiceWakeRecord('hey scout', {})).rejects.toThrow(`exit:${ExitCode.GeneralError}`);
		expect(errors()).toContain('End the voice session first');

		await expect(voiceWakeRecord('hey scout', { json: true })).rejects.toThrow('exit:');
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
			success: false,
			error: 'End the voice session first, then record the phrase.',
		});
	});

	it('refuses an empty phrase before opening the bridge', async () => {
		await expect(voiceWakeTrain('   ', {})).rejects.toThrow(`exit:${ExitCode.InvalidUsage}`);
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('reports a bridge failure rather than a refusal', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));

		await expect(voiceWakeStatus('hey scout', {})).rejects.toThrow('exit:');
		expect(errors()).toContain('Maestro desktop app is not running');
	});

	it('adds files by absolute path and keeps going past one the app will not take', async () => {
		const sent = mockBridge((request) =>
			request.action === 'import' && request.path.endsWith('cough.wav')
				? { ok: false, reason: 'Too short to be the phrase. Say it again.' }
				: { ok: true, status: status({ clips: 2 }) }
		);

		await expect(
			voiceWakeAdd('hey scout', ['takes/one.wav', 'takes/cough.wav', '/abs/two.wav'], {})
		).rejects.toThrow(`exit:${ExitCode.GeneralError}`);

		expect(sent.map((entry) => entry.request)).toEqual([
			{
				action: 'import',
				phrase: 'hey scout',
				kind: 'phrase',
				path: path.resolve('takes/one.wav'),
			},
			{
				action: 'import',
				phrase: 'hey scout',
				kind: 'phrase',
				path: path.resolve('takes/cough.wav'),
			},
			{ action: 'import', phrase: 'hey scout', kind: 'phrase', path: path.resolve('/abs/two.wav') },
		]);
		expect(errors()).toContain('Skipped takes/cough.wav: Too short');
		expect(printed()).toContain('"hey scout": 2 recordings');
	});

	it('reports a folder with one skipped take as not entirely added', async () => {
		mockBridge((request) =>
			request.action === 'import' && request.path.endsWith('cough.wav')
				? { ok: false, reason: 'Too short to be the phrase. Say it again.' }
				: { ok: true, status: status({ clips: 1 }) }
		);

		await expect(
			voiceWakeAdd('hey scout', ['one.wav', 'cough.wav'], { json: true })
		).rejects.toThrow(`exit:${ExitCode.GeneralError}`);

		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
			success: false,
			added: 1,
			skipped: [{ file: 'cough.wav', reason: 'Too short to be the phrase. Say it again.' }],
		});
	});

	it('adds other speech with --other-speech, and fails when nothing was added', async () => {
		const sent = mockBridge(() => ({ ok: false, reason: 'No such file: /nope.wav' }));

		await expect(
			voiceWakeAdd('hey scout', ['/nope.wav'], { otherSpeech: true, json: true })
		).rejects.toThrow(`exit:${ExitCode.GeneralError}`);

		expect(sent[0].request).toMatchObject({ action: 'import', kind: 'background' });
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
			success: false,
			added: 0,
			skipped: [{ file: '/nope.wav', reason: 'No such file: /nope.wav' }],
			status: null,
		});
	});

	it('needs at least one file to add', async () => {
		await expect(voiceWakeAdd('hey scout', [], {})).rejects.toThrow(
			`exit:${ExitCode.InvalidUsage}`
		);
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('lists every phrase in one round trip when the app sends the statuses', async () => {
		const sent = mockBridge(() => ({
			ok: true,
			status: null,
			phrases: ['hey scout', 'ok maestro'],
			statuses: [TRAINED, status({ phrase: 'ok maestro', clips: 3 })],
		}));

		await voiceWakeList({});

		expect(sent.map((entry) => entry.request)).toEqual([{ action: 'list' }]);
		expect(printed()).toContain('"hey scout": 20 recordings, 30 s of other speech');
		expect(printed()).toContain('"ok maestro": 3 recordings');
	});

	it('lists every phrase with where it stands, from an app that sends names only', async () => {
		mockBridge((request) =>
			request.action === 'list'
				? { ok: true, status: null, phrases: ['hey scout', 'ok maestro'] }
				: {
						ok: true,
						status:
							request.action === 'status' && request.phrase === 'hey scout'
								? TRAINED
								: status({ phrase: 'ok maestro', clips: 3 }),
					}
		);

		await voiceWakeList({});

		expect(printed()).toContain('"hey scout": 20 recordings, 30 s of other speech');
		expect(printed()).toContain('"ok maestro": 3 recordings');
	});

	it('says so when nothing has been recorded, and when nothing was recording', async () => {
		mockBridge(() => ({ ok: true, status: null, phrases: [] }));

		await voiceWakeList({});
		await voiceWakeStop({});

		expect(printed()).toContain('No wake phrases have been recorded.');
		expect(printed()).toContain('Nothing was recording.');
	});

	it('prints the status as JSON for a script', async () => {
		mockBridge(() => ({ ok: true, status: TRAINED }));

		await voiceWakeStatus('hey scout', { json: true });

		expect(JSON.parse(printed())).toEqual({ success: true, status: TRAINED });
	});
});

describe('formatWakeEnrollmentStatus', () => {
	it('says what training still needs', () => {
		expect(formatWakeEnrollmentStatus(status({ clips: 1 }))).toBe(
			'"hey scout": 1 recording, 0 s of other speech\n' +
				'  Not trained. Training needs at least 8 recordings and 12 s of other speech.'
		);
	});

	it('points at train once there is enough', () => {
		expect(formatWakeEnrollmentStatus(status({ clips: 8, backgroundMs: 12_000 }))).toContain(
			'Run "maestro-cli voice wake train" to train it.'
		);
	});

	it('says a run is live, what was left out, and what to do next', () => {
		const text = formatWakeEnrollmentStatus({
			...TRAINED,
			recording: 'background',
			model: {
				trainedAt: 1,
				report: { ...TRAINED.model!.report, advice: 'More recordings will make it more reliable.' },
			},
		});

		expect(text).toContain(
			'Recording other speech now. Run "maestro-cli voice wake stop" to finish.'
		);
		expect(text).toContain('1 recording(s) were left out');
		expect(text).toContain('More recordings will make it more reliable.');
	});
});
