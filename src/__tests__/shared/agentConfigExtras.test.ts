/**
 * @file agentConfigExtras.test.ts
 * @description The Edit Agent settings `update-agent` gained: the Agent
 * Resilience switches, the Codex auto reset, the Additional Directories list
 * and parking an environment variable. The spelling of the directory flag, and
 * the check the app runs on the agent's own record before anything is stored.
 */

import { describe, it, expect } from 'vitest';

import {
	AGENT_CONFIG_EXTRA_KEYS,
	applyAgentConfigExtras,
	parseAdditionalDirFlag,
} from '../../shared/agentConfigExtras';

describe('parseAdditionalDirFlag', () => {
	it('reads a bare path as read-only, which is what a new row in the dialog starts as', () => {
		expect(parseAdditionalDirFlag('/srv/docs')).toEqual({
			path: '/srv/docs',
			read: true,
			write: false,
		});
	});

	it('reads the access word after the last colon', () => {
		expect(parseAdditionalDirFlag('/srv/docs:rw')).toEqual({
			path: '/srv/docs',
			read: true,
			write: true,
		});
		expect(parseAdditionalDirFlag('/srv/out:w')).toEqual({
			path: '/srv/out',
			read: false,
			write: true,
		});
	});

	it('keeps a Windows drive colon as part of the path', () => {
		expect(parseAdditionalDirFlag('C:\\work\\docs')).toEqual({
			path: 'C:\\work\\docs',
			read: true,
			write: false,
		});
		expect(parseAdditionalDirFlag('C:\\work\\docs:rw')).toMatchObject({
			path: 'C:\\work\\docs',
			write: true,
		});
	});

	it('refuses an empty path, and a directory with no access', () => {
		expect(() => parseAdditionalDirFlag('  ')).toThrow('--additional-dir expects');
		expect(() => parseAdditionalDirFlag('/srv/docs:none')).toThrow('needs r, w or rw');
	});
});

describe('applyAgentConfigExtras', () => {
	const agent = {
		customEnvVars: { API_BASE: 'https://example.test', DEBUG: '1' },
		customEnvVarsDisabled: { OLD_FLAG: 'yes' },
	};

	it('ignores a patch that names none of its keys', () => {
		expect(applyAgentConfigExtras(agent, { nudgeMessage: 'hi' })).toEqual({
			ok: true,
			updated: {},
		});
	});

	it('names the keys it owns', () => {
		expect(AGENT_CONFIG_EXTRA_KEYS).toEqual([
			'retryOnAvailabilityErrors',
			'retryOnTokenExhaustion',
			'codexAutoResetOnExhaustion',
			'additionalDirectories',
			'peerDescription',
			'envParkEdits',
		]);
	});

	it('stores a switch on or off, and clears it for null', () => {
		const result = applyAgentConfigExtras(agent, {
			retryOnAvailabilityErrors: false,
			retryOnTokenExhaustion: null,
			codexAutoResetOnExhaustion: true,
		});
		expect(result).toEqual({
			ok: true,
			updated: {
				retryOnAvailabilityErrors: false,
				retryOnTokenExhaustion: undefined,
				codexAutoResetOnExhaustion: true,
			},
		});
		// Cleared is present as a key, so the write removes the stored choice.
		expect(result.ok && 'retryOnTokenExhaustion' in result.updated).toBe(true);
	});

	it('trims an advertised peer specialty and supports clearing it', () => {
		expect(applyAgentConfigExtras(agent, { peerDescription: '  Lab design  ' })).toEqual({
			ok: true,
			updated: { peerDescription: 'Lab design' },
		});
		for (const peerDescription of ['', '  ', null]) {
			expect(applyAgentConfigExtras(agent, { peerDescription })).toEqual({
				ok: true,
				updated: { peerDescription: undefined },
			});
		}
		expect(applyAgentConfigExtras(agent, { peerDescription: { text: 'Lab design' } })).toEqual({
			ok: false,
			error: 'peerDescription must be text or null.',
		});
	});

	it('refuses a switch that is not a boolean', () => {
		expect(applyAgentConfigExtras(agent, { retryOnAvailabilityErrors: 'yes' })).toEqual({
			ok: false,
			error: 'retryOnAvailabilityErrors must be true, false or null.',
		});
	});

	it('normalizes the directory list the way the dialog saves it', () => {
		const result = applyAgentConfigExtras(
			agent,
			{
				additionalDirectories: [
					{ path: ' ~/notes ', read: true, write: false },
					{ path: '/srv/docs', read: true, write: true, description: ' reference ' },
				],
			},
			'/home/pat'
		);
		expect(result).toEqual({
			ok: true,
			updated: {
				additionalDirectories: [
					{ path: '/home/pat/notes', read: true, write: false },
					{ path: '/srv/docs', read: true, write: true, description: 'reference' },
				],
			},
		});
	});

	it('clears the directory list for null, and refuses a malformed one', () => {
		expect(applyAgentConfigExtras(agent, { additionalDirectories: null })).toEqual({
			ok: true,
			updated: { additionalDirectories: undefined },
		});
		expect(
			applyAgentConfigExtras(agent, { additionalDirectories: [{ path: '/srv/docs' }] })
		).toMatchObject({ ok: false });
		expect(applyAgentConfigExtras(agent, { additionalDirectories: '/srv/docs' })).toMatchObject({
			ok: false,
		});
	});

	it('parks a live variable and switches a parked one back on', () => {
		expect(
			applyAgentConfigExtras(agent, { envParkEdits: { park: ['DEBUG'], unpark: ['OLD_FLAG'] } })
		).toEqual({
			ok: true,
			updated: {
				customEnvVars: { API_BASE: 'https://example.test', OLD_FLAG: 'yes' },
				customEnvVarsDisabled: { DEBUG: '1' },
			},
		});
	});

	it('stores no empty record when the last variable is parked or switched on', () => {
		expect(
			applyAgentConfigExtras(
				{ customEnvVars: { DEBUG: '1' } },
				{ envParkEdits: { park: ['DEBUG'] } }
			)
		).toEqual({
			ok: true,
			updated: { customEnvVars: undefined, customEnvVarsDisabled: { DEBUG: '1' } },
		});
	});

	it('names a variable the agent does not have, with the ones it does', () => {
		const result = applyAgentConfigExtras(agent, { envParkEdits: { park: ['DEBGU'] } });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain('DEBGU');
		expect(!result.ok && result.error).toContain('API_BASE, DEBUG, OLD_FLAG');
	});

	it('refuses a name asked to be parked and switched on at once', () => {
		expect(
			applyAgentConfigExtras(agent, { envParkEdits: { park: ['DEBUG'], unpark: ['DEBUG'] } })
		).toMatchObject({ ok: false });
	});

	it('refuses park edits that are not two lists of names', () => {
		expect(applyAgentConfigExtras(agent, { envParkEdits: ['DEBUG'] })).toMatchObject({ ok: false });
		expect(applyAgentConfigExtras(agent, { envParkEdits: { park: 'DEBUG' } })).toMatchObject({
			ok: false,
		});
	});

	it('does not edit the record it was given', () => {
		applyAgentConfigExtras(agent, { envParkEdits: { park: ['DEBUG'] } });
		expect(agent.customEnvVars).toEqual({ API_BASE: 'https://example.test', DEBUG: '1' });
		expect(agent.customEnvVarsDisabled).toEqual({ OLD_FLAG: 'yes' });
	});
});
