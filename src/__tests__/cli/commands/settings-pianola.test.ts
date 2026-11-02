import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { settingsSet } from '../../../cli/commands/settings-set';
import { settingsGet } from '../../../cli/commands/settings-get';
import { encoreList } from '../../../cli/commands/encore';
import { readSettingValue } from '../../../cli/services/storage';

let root: string;
let previousUserData: string | undefined;
beforeEach(() => {
	previousUserData = process.env.MAESTRO_USER_DATA;
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-settings-pianola-'));
	process.env.MAESTRO_USER_DATA = root;
	fs.writeFileSync(
		path.join(root, 'maestro-settings.json'),
		JSON.stringify({
			encoreFeatures: { pianola: true, autopilot: true },
		})
	);
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
	if (previousUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = previousUserData;
	fs.rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('Pianola repair permission through real CLI storage', () => {
	it('starts in supervision with a legacy flag, persists explicit consent, and revokes it', async () => {
		encoreList({ json: true });
		expect(JSON.parse(vi.mocked(console.log).mock.lastCall![0]).pianola.mode).toBe('supervision');
		await settingsSet('pianolaAutoFixEnabled', 'true', { json: true });
		expect(readSettingValue('pianolaAutoFixEnabled')).toBe(true);
		settingsGet('pianolaAutoFixEnabled', { json: true, verbose: true });
		expect(JSON.parse(vi.mocked(console.log).mock.lastCall![0])).toMatchObject({
			key: 'pianolaAutoFixEnabled',
			value: true,
			defaultValue: false,
			valueType: 'boolean',
		});
		encoreList({ json: true });
		expect(JSON.parse(vi.mocked(console.log).mock.lastCall![0]).pianola.mode).toBe(
			'automatic_repairs'
		);
		await settingsSet('pianolaAutoFixEnabled', 'false', { json: true });
		encoreList({ json: true });
		expect(JSON.parse(vi.mocked(console.log).mock.lastCall![0]).pianola.mode).toBe('supervision');
		expect(readSettingValue('encoreFeatures')).toEqual({ pianola: true, autopilot: true });
	});
});
