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
			authEnvironment: { ANTHROPIC_API_KEY: 'test-anthropic-key-12345' },
		});

		const launch = await profile.prepareForLaunch();
		expect(launch.profile).toMatch(/^maestro-omp-[a-f0-9]{32}$/u);
		expect(launch.sterileCwd).toBe(join(root, 'cwd'));
		expect(await fs.readdir(join(root, 'profile'))).toEqual(['maestro-omp.yaml']);
		expect(await fs.readdir(launch.sterileCwd)).toEqual([]);
		expect(await fs.readFile(launch.config, 'utf8')).toContain('disabledExtensions: ["*"]');
		expect(await fs.readFile(launch.config, 'utf8')).toContain('enableProjectConfig: false');
		expect(launch.env).toMatchObject({
			OMP_PROFILE: launch.profile,
			HOME: join(root, 'home'),
			USERPROFILE: join(root, 'home'),
			XDG_CONFIG_HOME: join(root, 'config'),
			APPDATA: join(root, 'appdata'),
			LOCALAPPDATA: join(root, 'localappdata'),
			PI_NO_PTY: '1',
			PI_NO_TITLE: '1',
			PI_NOTIFICATIONS: 'off',
			ANTHROPIC_API_KEY: 'test-anthropic-key-12345',
		});
		expect(JSON.stringify(launch)).not.toContain('test-anthropic-key-12345');
	});

	it('rejects profile mutations that could register extensions, hooks, custom tools, MCP, or user config', async () => {
		const root = await stateRoot();
		const profile = new OmpRuntimeProfileService({ stateRoot: root });
		await profile.prepareForLaunch();

		for (const injected of ['.omp', 'hook.ts', 'custom-tool.js', 'mcp.json', 'settings.yaml']) {
			const injectedPath = join(root, 'profile', injected);
			await fs.writeFile(injectedPath, 'export default {}');
			await expect(profile.prepareForLaunch()).rejects.toThrow('unapproved discovery state');
			await fs.rm(injectedPath);
		}
	});

	it('rejects profile mutations, discovery environment keys, and non-provider auth variables', async () => {
		const root = await stateRoot();
		const profile = new OmpRuntimeProfileService({ stateRoot: root });
		const launch = await profile.prepareForLaunch();
		await fs.writeFile(launch.config, 'extensions: ["C:/Users/attacker/extension.js"]\n');
		await expect(profile.prepareForLaunch()).rejects.toThrow('unapproved discovery state');

		const rejectedAuthEnvironments: readonly Readonly<Record<string, string>>[] = [
			{ HOME: 'C:/attacker' },
			{ MAESTRO_OMP_TOKEN: 'host-issued' },
			{ AWS_SECRET_ACCESS_KEY: 'never-forward-this' },
			{ ANTHROPIC_API_KEY_EXTRA: 'test-anthropic-key-12345' },
		];
		for (const authEnvironment of rejectedAuthEnvironments) {
			await expect(
				new OmpRuntimeProfileService({ authEnvironment }).prepareForLaunch()
			).rejects.toThrow('auth environment is not allowlisted');
		}
	});
});
