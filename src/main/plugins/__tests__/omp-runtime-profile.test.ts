import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { OmpRuntimeProfileService } from '../omp-runtime-profile';

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
	);
});

async function stateRoot(): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), 'maestro-omp-profile-test-'));
	directories.push(directory);
	return directory;
}

describe('OMP sterile launch profile', () => {
	it('allows only host-generated non-code configuration and produces an empty child cwd', async () => {
		const root = await stateRoot();
		const profile = new OmpRuntimeProfileService({
			stateRoot: root,
			model: 'maestro/approved-model',
			authEnvironment: { MAESTRO_OMP_TOKEN: 'host-issued' },
		});

		const launch = await profile.prepareForLaunch();
		expect(launch.profile).toBe(join(root, 'profile'));
		expect(launch.sterileCwd).toBe(join(root, 'cwd'));
		expect(await fs.readdir(launch.profile)).toEqual(['maestro-omp.yaml']);
		expect(await fs.readdir(launch.sterileCwd)).toEqual([]);
		expect(await fs.readFile(launch.config, 'utf8')).toContain('disabledExtensions: ["*"]');
		expect(await fs.readFile(launch.config, 'utf8')).toContain('enableProjectConfig: false');
		expect(launch.env).toEqual({
			OMP_PROFILE: launch.profile,
			PI_NO_PTY: '1',
			PI_NO_TITLE: '1',
			PI_NOTIFICATIONS: 'off',
			MAESTRO_OMP_TOKEN: 'host-issued',
		});
	});

	it('rejects profile mutations that could register extensions, hooks, custom tools, MCP, or user config', async () => {
		const root = await stateRoot();
		const profile = new OmpRuntimeProfileService({ stateRoot: root });
		const launch = await profile.prepareForLaunch();

		for (const injected of ['.omp', 'hook.ts', 'custom-tool.js', 'mcp.json', 'settings.yaml']) {
			await fs.writeFile(join(launch.profile, injected), 'export default {}');
			await expect(profile.prepareForLaunch()).rejects.toThrow('unapproved discovery state');
			await fs.rm(join(launch.profile, injected));
		}
	});

	it('rejects a modified config or a forbidden inherited discovery environment key', async () => {
		const root = await stateRoot();
		const profile = new OmpRuntimeProfileService({ stateRoot: root });
		const launch = await profile.prepareForLaunch();
		await fs.writeFile(launch.config, 'extensions: ["C:/Users/attacker/extension.js"]\n');
		await expect(profile.prepareForLaunch()).rejects.toThrow('unapproved discovery state');

		expect(
			() => new OmpRuntimeProfileService({ authEnvironment: { HOME: 'C:/attacker' } })
		).not.toThrow();
		await expect(
			new OmpRuntimeProfileService({ authEnvironment: { HOME: 'C:/attacker' } }).prepareForLaunch()
		).rejects.toThrow('auth environment is not allowlisted');
	});
});
