/**
 * @file mic-permission.test.ts
 *
 * Two properties, and the second one is the reason this module exists at all:
 *
 *   1. Every OS state is distinguished. `not-determined` is not `denied`, and
 *      `restricted` is not `denied` either, because the recovery differs: wait
 *      to be asked, tick a checkbox, or talk to whoever manages the machine.
 *   2. A microphone problem and a model problem produce DIFFERENT gate reasons.
 *      Conflating them is what turns a one-checkbox fix into a support ticket,
 *      so the gate is tested here alongside the permission itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getMediaAccessStatus = vi.fn();
const askForMediaAccess = vi.fn();
const openExternal = vi.fn();

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/acappella-mic-permission-test' },
	shell: { openExternal: (url: string) => openExternal(url) },
	systemPreferences: {
		getMediaAccessStatus: (type: string) => getMediaAccessStatus(type),
		askForMediaAccess: (type: string) => askForMediaAccess(type),
	},
}));

import {
	getMicPermission,
	noteCaptureFailure,
	noteCaptureStarted,
	openMicSystemSettings,
	requestMicPermission,
	resetMicPermissionObservation,
} from '../../../../main/acappella/permissions/mic-permission';
import { resolveVoiceReadiness } from '../../../../main/acappella/models/capability-gate';
import type { ModelStatus } from '../../../../main/acappella/models/model-store';
import { WHISPER_BASE_EN_ID } from '../../../../shared/acappella/model-catalog';

const REAL_PLATFORM = process.platform;

function setPlatform(platform: string): void {
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function statusReader(overrides: Record<string, ModelStatus['status']> = {}) {
	return async (modelId: string): Promise<ModelStatus> => ({
		id: modelId,
		status: overrides[modelId] ?? 'installed',
		manifest: null,
		bytesOnDisk: 1024,
	});
}

describe('mic-permission', () => {
	beforeEach(() => {
		resetMicPermissionObservation();
		getMediaAccessStatus.mockReset();
		askForMediaAccess.mockReset();
		openExternal.mockReset();
		setPlatform('darwin');
	});

	afterEach(() => {
		setPlatform(REAL_PLATFORM);
		resetMicPermissionObservation();
	});

	describe('every state stays its own state', () => {
		it.each([
			['not-determined', 'not-determined'],
			['granted', 'granted'],
			['denied', 'denied'],
			['restricted', 'restricted'],
		])('reports %s as %s', (osStatus, expected) => {
			getMediaAccessStatus.mockReturnValue(osStatus);
			expect(getMicPermission().state).toBe(expected);
		});

		it('offers a prompt only when the OS has one to show', () => {
			getMediaAccessStatus.mockReturnValue('not-determined');
			expect(getMicPermission().canPrompt).toBe(true);

			getMediaAccessStatus.mockReturnValue('denied');
			// Once the user has said no, the app cannot ask again. A "Grant access"
			// button here would do nothing, which is worse than no button.
			expect(getMicPermission().canPrompt).toBe(false);
		});

		it('never prompts while querying', () => {
			getMediaAccessStatus.mockReturnValue('not-determined');
			getMicPermission();
			// The whole point: readiness is resolved on every Settings render, so a
			// query that could raise a TCC dialog would ask for the microphone behind
			// a user who has not asked for voice.
			expect(askForMediaAccess).not.toHaveBeenCalled();
		});

		it('falls back to unknown when the OS query throws', () => {
			getMediaAccessStatus.mockImplementation(() => {
				throw new Error('not implemented on this platform');
			});
			expect(getMicPermission().state).toBe('unknown');
		});
	});

	describe('requesting', () => {
		it('asks once on macOS when the state is undetermined', async () => {
			getMediaAccessStatus.mockReturnValue('not-determined');
			askForMediaAccess.mockResolvedValue(true);

			const info = await requestMicPermission();

			expect(askForMediaAccess).toHaveBeenCalledWith('microphone');
			expect(info.state).toBe('granted');
		});

		it('does not re-ask once the user has answered', async () => {
			getMediaAccessStatus.mockReturnValue('denied');

			const info = await requestMicPermission();

			expect(askForMediaAccess).not.toHaveBeenCalled();
			expect(info.state).toBe('denied');
		});

		it('reports the refusal when the user says no', async () => {
			getMediaAccessStatus.mockReturnValue('not-determined');
			askForMediaAccess.mockResolvedValue(false);

			expect((await requestMicPermission()).state).toBe('denied');
		});

		it('does not claim a denial when the API itself throws', async () => {
			getMediaAccessStatus.mockReturnValue('not-determined');
			askForMediaAccess.mockRejectedValue(new Error('unavailable'));

			// Reporting "denied" here would send the user to fix a checkbox that is
			// already correct.
			expect((await requestMicPermission()).state).toBe('not-determined');
		});

		it('never pretends to prompt on Windows', async () => {
			setPlatform('win32');
			getMediaAccessStatus.mockReturnValue('denied');

			const info = await requestMicPermission();

			expect(askForMediaAccess).not.toHaveBeenCalled();
			expect(info.state).toBe('denied');
			expect(info.canPrompt).toBe(false);
		});
	});

	describe('the getUserMedia failure path', () => {
		it('is the only permission signal on Linux', () => {
			setPlatform('linux');
			expect(getMicPermission().state).toBe('unknown');

			noteCaptureFailure('permission-denied');

			expect(getMicPermission().state).toBe('denied');
			// Linux has no privacy-pane deep link that works across desktops, so the
			// UI has to offer words rather than a button.
			expect(getMicPermission().settingsUrl).toBeNull();
		});

		it('does not mistake a missing device for a denial', () => {
			setPlatform('linux');
			noteCaptureFailure('no-device');
			noteCaptureFailure('device-lost');
			expect(getMicPermission().state).toBe('unknown');
		});

		it('does not outrank an OS that has an answer', () => {
			setPlatform('win32');
			getMediaAccessStatus.mockReturnValue('granted');
			noteCaptureFailure('permission-denied');

			// The OS wins because it is what will actually decide the next capture,
			// and it updates the instant the user changes the setting. A remembered
			// denial that outranked it would keep blocking sessions after the user
			// had already fixed the problem.
			expect(getMicPermission().state).toBe('granted');
		});

		it('fills the gap when the OS query is unavailable', () => {
			setPlatform('win32');
			getMediaAccessStatus.mockImplementation(() => {
				throw new Error('not implemented');
			});
			noteCaptureFailure('permission-denied');

			expect(getMicPermission().state).toBe('denied');
		});

		it('clears once capture actually starts, which is the only proof of a grant', () => {
			setPlatform('linux');
			noteCaptureFailure('permission-denied');
			expect(getMicPermission().state).toBe('denied');

			noteCaptureStarted();
			expect(getMicPermission().state).toBe('unknown');
		});

		it('does not survive the next session start, so one denial cannot deadlock voice', async () => {
			setPlatform('linux');
			noteCaptureFailure('permission-denied');
			expect(getMicPermission().state).toBe('denied');

			// The user granted access and pressed the button again. Without this, the
			// capability gate would block the session forever on the strength of one
			// old failure, and the successful capture that would clear it is exactly
			// what the gate is refusing to allow.
			await requestMicPermission();

			expect(getMicPermission().state).toBe('unknown');
		});
	});

	describe('opening system settings', () => {
		it('opens the privacy pane where one exists', async () => {
			expect(await openMicSystemSettings()).toBe(true);
			expect(openExternal).toHaveBeenCalledWith(
				'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
			);
		});

		it('reports false rather than opening nothing on Linux', async () => {
			setPlatform('linux');
			expect(await openMicSystemSettings()).toBe(false);
			expect(openExternal).not.toHaveBeenCalled();
		});
	});

	describe('the capability gate keeps permission and models apart', () => {
		it('blocks on a denied microphone with its own reason and recovery', async () => {
			const readiness = await resolveVoiceReadiness({
				readModelStatus: statusReader(),
				readMicPermission: () => 'denied',
			});

			const mic = readiness.slots.find((slot) => slot.slot === 'microphone')!;
			expect(mic.satisfied).toBe(false);
			expect(mic.reason).toBe('mic-permission-denied');
			expect(mic.detail).toContain('microphone access');
			expect(mic.suggestedAction).toContain('privacy settings');
			expect(readiness.canStartSession).toBe(false);
		});

		it('distinguishes a restricted microphone, which the user cannot fix', async () => {
			const readiness = await resolveVoiceReadiness({
				readModelStatus: statusReader(),
				readMicPermission: () => 'restricted',
			});

			const mic = readiness.slots.find((slot) => slot.slot === 'microphone')!;
			expect(mic.reason).toBe('mic-permission-restricted');
			// No privacy-pane instruction: sending someone to a checkbox they are not
			// allowed to tick is a dead end.
			expect(mic.suggestedAction).not.toContain('privacy settings');
		});

		it.each(['not-determined', 'unknown', 'granted'] as const)(
			'does not block on %s, because nothing has been refused',
			async (permission) => {
				const readiness = await resolveVoiceReadiness({
					readModelStatus: statusReader(),
					readMicPermission: () => permission,
				});

				expect(readiness.slots.find((slot) => slot.slot === 'microphone')?.satisfied).toBe(true);
				expect(readiness.canStartSession).toBe(true);
			}
		);

		it('gives a missing model and a denied microphone two different reasons at once', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: { stt: 'whisper-local' },
				readModelStatus: statusReader({ [WHISPER_BASE_EN_ID]: 'not-installed' }),
				readMicPermission: () => 'denied',
			});

			// The failure this whole module exists to prevent: one generic "voice
			// unavailable" covering two unrelated problems with two unrelated fixes.
			const reasons = readiness.blocking.map((slot) => slot.reason);
			expect(reasons).toContain('mic-permission-denied');
			expect(reasons).toContain('model-not-installed');
			expect(new Set(reasons).size).toBe(2);
		});

		it('reports the microphone permission on the slot even when satisfied', async () => {
			const readiness = await resolveVoiceReadiness({
				readModelStatus: statusReader(),
				readMicPermission: () => 'not-determined',
			});

			expect(readiness.slots.find((slot) => slot.slot === 'microphone')?.micPermission).toBe(
				'not-determined'
			);
		});
	});
});
