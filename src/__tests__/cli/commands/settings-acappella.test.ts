/**
 * @file settings-acappella.test.ts
 * @description `maestro-cli settings get|set|reset` on the A Cappella blob.
 * Every reader of that blob sanitises, so a bad value used to be stored,
 * reported as set, and silently read back as the default. A write is now
 * checked against the table the Voice settings panels' bounds come from, an
 * unset field reads as its default, a path nothing reads is refused, and the
 * one secret in the blob is masked in an object read.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readSettingValue: vi.fn(),
	writeSettingValue: vi.fn(() => true),
	deleteSettingValue: vi.fn(() => true),
	readSettings: vi.fn(() => ({})),
}));

// `settings set` and `settings get` import the media tools for one unrelated
// key. They are not needed to judge a voice setting.
vi.mock('../../../main/plugins/plugin-media-tools', () => ({
	resolveMediaModelDirectory: vi.fn(),
	getMediaToolStatus: vi.fn(),
	resolveMediaRuntime: vi.fn(),
}));

import { settingsGet } from '../../../cli/commands/settings-get';
import { settingsList } from '../../../cli/commands/settings-list';
import { settingsReset } from '../../../cli/commands/settings-reset';
import { settingsSet } from '../../../cli/commands/settings-set';
import {
	deleteSettingValue,
	readSettingValue,
	readSettings,
	writeSettingValue,
} from '../../../cli/services/storage';
import { SETTINGS_METADATA } from '../../../shared/settingsMetadata';
import {
	DEFAULT_TURN_SETTLE_MS,
	DEFAULT_WAKE_PHRASE,
} from '../../../shared/acappella/voice-controls';

describe('settings commands on the A Cappella blob', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	const printed = () => logSpy.mock.calls.map(([line]) => String(line)).join('\n');
	const errors = () => errorSpy.mock.calls.map(([line]) => String(line)).join('\n');

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readSettingValue).mockReturnValue(undefined);
		vi.mocked(readSettings).mockReturnValue({});
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`exit:${code}`);
		}) as never);
	});

	it('is a known setting, so a write no longer warns that it is not', async () => {
		expect(SETTINGS_METADATA.acappella).toMatchObject({ type: 'object', default: {} });

		await settingsSet('acappella.controls.turnSettleMs', '1200', {});

		expect(errors()).not.toContain('not a known setting');
		expect(writeSettingValue).toHaveBeenCalledWith('acappella.controls.turnSettleMs', 1200);
	});

	it('refuses a value the panel would refuse, and writes nothing', async () => {
		await expect(settingsSet('acappella.controls.turnSettleMs', 'fast', {})).rejects.toThrow(
			'exit:1'
		);
		await expect(settingsSet('acappella.controls.turnSettleMs', '999999', {})).rejects.toThrow(
			'exit:1'
		);
		await expect(settingsSet('acappella.providers.stt', 'no-such-engine', {})).rejects.toThrow(
			'exit:1'
		);

		expect(writeSettingValue).not.toHaveBeenCalled();
		expect(errors()).toContain('acappella.controls.turnSettleMs expects a number from');
	});

	it('refuses a path nothing reads, and lists the ones there are', async () => {
		await expect(settingsSet('acappella.controls.wakeFrase', 'hey scout', {})).rejects.toThrow(
			'exit:1'
		);

		expect(writeSettingValue).not.toHaveBeenCalled();
		expect(errors()).toContain('is not an A Cappella setting');
		expect(errors()).toContain('controls.wakePhrase');
	});

	it('keeps a text field as typed when it looks like a number or a switch', async () => {
		// Auto type detection would turn "007" into a string but "true" into a
		// boolean, and a wake phrase is text whatever it spells.
		await settingsSet('acappella.controls.stopPhrase', 'true', {});
		expect(writeSettingValue).toHaveBeenCalledWith('acappella.controls.stopPhrase', 'true');
	});

	it('checks every field of a section written with --raw', async () => {
		await settingsSet('acappella.controls', '', {
			raw: '{"wakeWordEnabled":true,"turnSettleMs":500}',
		});
		expect(writeSettingValue).toHaveBeenCalledWith('acappella.controls', {
			wakeWordEnabled: true,
			turnSettleMs: 500,
		});

		vi.mocked(writeSettingValue).mockClear();
		await expect(
			settingsSet('acappella.controls', '', { raw: '{"turnSettleMs":"fast"}' })
		).rejects.toThrow('exit:1');
		expect(writeSettingValue).not.toHaveBeenCalled();
	});

	it('leaves a setting with no field table free-form', async () => {
		await settingsSet('someFutureSetting.nested', 'anything', {});
		expect(writeSettingValue).toHaveBeenCalledWith('someFutureSetting.nested', 'anything');
	});

	it('reads an unset field as the default the app runs on', () => {
		settingsGet('acappella.controls.wakePhrase', {});
		expect(printed()).toBe(DEFAULT_WAKE_PHRASE);

		logSpy.mockClear();
		settingsGet('acappella.controls.turnSettleMs', { json: true });
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
			key: 'acappella.controls.turnSettleMs',
			value: DEFAULT_TURN_SETTLE_MS,
			defaultValue: DEFAULT_TURN_SETTLE_MS,
			isDefault: true,
		});
	});

	it('reads a stored field as stored', () => {
		vi.mocked(readSettingValue).mockReturnValue('hey scout');
		settingsGet('acappella.controls.wakePhrase', {});
		expect(printed()).toBe('hey scout');
	});

	it('refuses to read a path nothing stores', () => {
		expect(() => settingsGet('acappella.controls.wakeFrase', {})).toThrow('exit:1');
		expect(errors()).toContain('is not an A Cappella setting');
	});

	it('masks the TURN credential in a read of the object around it', () => {
		vi.mocked(readSettingValue).mockReturnValue({
			turn: { enabled: true, url: 'turn:relay.test:3478', credential: 'hunter2' },
		});
		settingsGet('acappella.ice', {});

		expect(printed()).not.toContain('hunter2');
		expect(printed()).toContain('***');
		expect(printed()).toContain('turn:relay.test:3478');
	});

	it('prints the credential for a read of its own path, like any sensitive key', () => {
		vi.mocked(readSettingValue).mockReturnValue('hunter2');
		settingsGet('acappella.ice.turn.credential', {});
		expect(printed()).toBe('hunter2');
	});

	it('masks the TURN credential in the list, unless secrets are asked for', () => {
		vi.mocked(readSettings).mockReturnValue({
			acappella: { ice: { turn: { credential: 'hunter2' } } },
		});

		settingsList({ json: true });
		expect(printed()).not.toContain('hunter2');

		logSpy.mockClear();
		settingsList({ json: true, showSecrets: true });
		expect(printed()).toContain('hunter2');
	});

	it('resets one field to its own default, not to the blob default', () => {
		vi.mocked(readSettingValue).mockReturnValue('hey scout');
		settingsReset('acappella.controls.wakePhrase', { json: true });

		expect(deleteSettingValue).toHaveBeenCalledWith('acappella.controls.wakePhrase');
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
			key: 'acappella.controls.wakePhrase',
			oldValue: 'hey scout',
			defaultValue: DEFAULT_WAKE_PHRASE,
		});
	});

	it('refuses to reset a path nothing stores', () => {
		expect(() => settingsReset('acappella.controls.wakeFrase', {})).toThrow('exit:1');
		expect(deleteSettingValue).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
