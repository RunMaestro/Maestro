/**
 * @file bridgeDenyList.test.ts
 * @description What a web client may reach and read through the bridge.
 *
 * What a browser on the web interface may read of a configuration container.
 * Pinned here: a Local Models endpoint's `apiKeyEnvVar` holds the NAME of an
 * environment variable, never a key, so it survives sanitizing. Were it
 * stripped, a browser that saves the endpoint list would write every endpoint
 * back without it, and the host would stop sending the key.
 *
 * rc's bridge is an exact allowlist: a channel is reachable from a web client only when the
 * inventory names it, and host lifecycle channels are deliberately absent. Rolling back replaces
 * the host's app with an OLDER build, which can reopen vulnerabilities a later release closed, so
 * only the person at the desktop (or its CLI) may run it.
 */

import { describe, expect, it } from 'vitest';
import {
	isRemoteMethodAllowed,
	isRemoteSecretField,
	remoteDeniedChannelError,
	sanitizeRemoteResult,
} from '../../../../main/web-server/handlers/bridgeDenyList';

describe('context audit bridge availability', () => {
	it('allows the same read-only audit method on web desktop without opening arbitrary context methods', () => {
		expect(isRemoteMethodAllowed('context:getFootprint')).toBe(true);
		expect(isRemoteMethodAllowed('context:writeFootprint')).toBe(false);
	});
});

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

describe('remote method inventory', () => {
	it.each(['updates:rollback', 'webLogin:createUser', 'promptLinks:create'])(
		'refuses %s',
		(channel) => {
			expect(isRemoteMethodAllowed(channel)).toBe(false);
		}
	);

	it('names the channel in its refusal', () => {
		expect(remoteDeniedChannelError('updates:rollback')).toContain('updates:rollback');
	});
});
