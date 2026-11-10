/**
 * @file bridgeDenyList.test.ts
 *
 * What a browser on the web interface may read of a configuration container.
 * Pinned here: a Local Models endpoint's `apiKeyEnvVar` holds the NAME of an
 * environment variable, never a key, so it survives sanitizing. Were it
 * stripped, a browser that saves the endpoint list would write every endpoint
 * back without it, and the host would stop sending the key.
 */

import { describe, expect, it } from 'vitest';
import {
	isRemoteSecretField,
	sanitizeRemoteResult,
} from '../../../../main/web-server/handlers/bridgeDenyList';

describe('isRemoteSecretField', () => {
	it('keeps the name of the variable an endpoint reads its key from', () => {
		expect(isRemoteSecretField('apiKeyEnvVar')).toBe(false);
	});

	it.each(['apiKey', 'api_key', 'openaiApiKey', 'customEnvVars', 'authToken', 'password'])(
		'still treats %s as a secret',
		(key) => {
			expect(isRemoteSecretField(key)).toBe(true);
		}
	);
});

describe('sanitizeRemoteResult', () => {
	it('returns the endpoint list with its key variable names intact', () => {
		const endpoints = [
			{
				id: 'ollama',
				name: 'Ollama',
				kind: 'ollama',
				baseUrl: 'http://127.0.0.1:11434',
				apiKeyEnvVar: 'OLLAMA_API_KEY',
				enabled: true,
			},
		];
		const result = sanitizeRemoteResult('settings:getAll', {
			localModelEndpoints: endpoints,
			apiKey: 'sk-never',
		}) as Record<string, unknown>;

		expect(result.localModelEndpoints).toEqual(endpoints);
		expect(result).not.toHaveProperty('apiKey');
	});
});
