import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { settingsSet } from '../../../cli/commands/settings-set';
import { settingsMediaStatus } from '../../../cli/commands/settings-get';
import { readSettingValue, writeSettingValue } from '../../../cli/services/storage';

vi.mock('../../../cli/services/storage', () => ({
	readSettingValue: vi.fn(),
	writeSettingValue: vi.fn(() => true),
}));
vi.mock('../../../main/agents/path-prober', () => ({ findAllBinaryPaths: vi.fn(async () => []) }));

let root: string;
beforeEach(async () => {
	vi.clearAllMocks();
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-settings-media-'));
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('CLI host media settings parity', () => {
	it('persists the real directory behind a symlink, as desktop validation does', async () => {
		const models = path.join(root, 'models');
		const alias = path.join(root, 'alias');
		await fs.mkdir(models);
		await fs.symlink(models, alias, 'junction');
		await settingsSet('mediaModelDirectory', alias, { json: true });
		expect(writeSettingValue).toHaveBeenCalledWith(
			'mediaModelDirectory',
			await fs.realpath(models)
		);
		expect(process.exit).not.toHaveBeenCalled();
	});
	it.each(['relative/models', 'missing', 'file', 'nested', 'non-string'])(
		'refuses invalid %s without a settings write',
		async (kind) => {
			let key = 'mediaModelDirectory';
			let value = path.join(root, 'missing');
			let raw: string | undefined;
			if (kind === 'relative/models') value = kind;
			if (kind === 'file') {
				value = path.join(root, 'file');
				await fs.writeFile(value, 'data');
			}
			if (kind === 'nested') {
				key += '.child';
				value = root;
			}
			if (kind === 'non-string') raw = 'null';
			await settingsSet(key, value, { json: true, raw });
			expect(writeSettingValue).not.toHaveBeenCalled();
			expect(process.exit).toHaveBeenCalledWith(1);
		}
	);
	it('accepts clearing the directory to use the environment fallback', async () => {
		await settingsSet('mediaModelDirectory', '', { json: true });
		expect(writeSettingValue).toHaveBeenCalledWith('mediaModelDirectory', '');
	});
	it('reports the allowed local models through the host runtime resolver', async () => {
		await fs.writeFile(path.join(root, 'ggml-base.bin'), 'fixture');
		vi.mocked(readSettingValue).mockReturnValue(root);
		await settingsMediaStatus();
		expect(readSettingValue).toHaveBeenCalledWith('mediaModelDirectory');
		expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
			models: ['base'],
			missing: ['ffprobe', 'ffmpeg', 'whisper-cli'],
		});
	});
});
