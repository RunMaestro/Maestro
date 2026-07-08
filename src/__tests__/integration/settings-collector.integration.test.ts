import os from 'os';
import { describe, expect, it } from 'vitest';
import type Store from 'electron-store';

import { collectSettings } from '../../main/debug-package/collectors/settings';

function settingsStore(store?: Record<string, unknown>): Store<any> {
	return { store } as Store<any>;
}

function bootstrapStore(customSyncPath: unknown): Store<any> {
	return {
		get: (key: string) => (key === 'customSyncPath' ? customSyncPath : undefined),
	} as Store<any>;
}

describe('settings collector integration', () => {
	it('redacts sensitive keys and sanitizes nested home-directory paths', async () => {
		const home = os.homedir();
		const result = await collectSettings(
			settingsStore({
				openAIApiKey: 'sk-real',
				api_key: 'legacy-key',
				authToken: 'auth-token',
				client_token: 'client-token',
				dbPassword: 'password',
				secretValue: 'secret',
				credentialFile: `${home}/.config/credential.json`,
				accessToken: 'access',
				refresh_token: 'refresh',
				privateKey: 'private',
				workspacePath: `${home}/projects/maestro`,
				ghPath: `${home}/bin/gh`,
				plainValue: 42,
				nested: {
					projectRoot: `${home}/workspace/project`,
					customShellPath: '/usr/local/bin/zsh',
					values: [
						{
							fullPath: `${home}/workspace/project/file.md`,
							auth_token: 'array-token',
							enabled: true,
						},
						null,
						undefined,
						'plain',
					],
				},
			})
		);

		expect(result.raw).toMatchObject({
			openAIApiKey: '[REDACTED]',
			api_key: '[REDACTED]',
			authToken: '[REDACTED]',
			client_token: '[REDACTED]',
			dbPassword: '[REDACTED]',
			secretValue: '[REDACTED]',
			credentialFile: '[REDACTED]',
			accessToken: '[REDACTED]',
			refresh_token: '[REDACTED]',
			privateKey: '[REDACTED]',
			workspacePath: '~/projects/maestro',
			ghPath: '~/bin/gh',
			plainValue: 42,
			nested: {
				projectRoot: '~/workspace/project',
				customShellPath: '/usr/local/bin/zsh',
				values: [
					{
						fullPath: '~/workspace/project/file.md',
						auth_token: '[REDACTED]',
						enabled: true,
					},
					null,
					undefined,
					'plain',
				],
			},
		});
		expect(result.sanitizedFields).toEqual([
			'openAIApiKey',
			'api_key',
			'authToken',
			'client_token',
			'dbPassword',
			'secretValue',
			'credentialFile',
			'accessToken',
			'refresh_token',
			'privateKey',
			'workspacePath',
			'ghPath',
			'nested.projectRoot',
			'nested.values[0].fullPath',
			'nested.values[0].auth_token',
		]);
	});

	it('adds sanitized bootstrap sync info when available', async () => {
		const home = os.homedir();
		const result = await collectSettings(
			settingsStore({ theme: 'dark' }),
			bootstrapStore(`${home}/Library/Application Support/Maestro`)
		);

		expect(result.raw).toEqual({
			theme: 'dark',
			_syncInfo: {
				hasCustomSyncPath: true,
				customSyncPath: '~/Library/Application Support/Maestro',
			},
		});
		expect(result.sanitizedFields).toEqual([]);
	});

	it('handles missing stores, unset sync paths, and non-object settings safely', async () => {
		await expect(collectSettings(settingsStore())).resolves.toEqual({
			raw: {},
			sanitizedFields: [],
		});

		await expect(collectSettings(settingsStore({ shellPath: 123 }))).resolves.toEqual({
			raw: { shellPath: 123 },
			sanitizedFields: [],
		});

		await expect(collectSettings(settingsStore({}), bootstrapStore(''))).resolves.toEqual({
			raw: {
				_syncInfo: {
					hasCustomSyncPath: false,
					customSyncPath: undefined,
				},
			},
			sanitizedFields: [],
		});
	});
});
