import { describe, expect, it } from 'vitest';
import { buildAgentConfigPatch } from '../../agents/rules';
import type { AgentPatch } from '../../client/types';
import { agentPatchFromConfig } from '../server-requests';

describe('agentPatchFromConfig', () => {
	it('reads back every config field buildAgentConfigPatch writes, so the wire loses none', () => {
		const patch: AgentPatch = {
			model: 'opus',
			effort: 'high',
			customPath: '/bin/claude',
			customArgs: '--x',
			env: { KEY: 'v' },
			nudgeMessage: 'n',
			newSessionMessage: 'm',
			bookmarked: true,
			// DG6: what the desktop's Edit Agent writes.
			customProviderPath: '/opt/claude',
			envDisabled: { PARKED: 'x' },
			additionalDirectories: [{ path: '/a', read: true, write: false }],
			retryOnAvailabilityErrors: false,
			retryOnTokenExhaustion: true,
			codexAutoResetOnExhaustion: true,
			enableMaestroP: false,
			maestroPPath: '/p',
			maestroPMode: 'dynamic',
		};
		const config = buildAgentConfigPatch(patch).patch;
		expect(agentPatchFromConfig(config)).toEqual(patch);
	});

	it('reads back a clear as null for the new fields too', () => {
		const patch: AgentPatch = {
			customProviderPath: null,
			envDisabled: null,
			additionalDirectories: null,
			retryOnAvailabilityErrors: null,
			enableMaestroP: null,
			maestroPMode: null,
		};
		expect(agentPatchFromConfig(buildAgentConfigPatch(patch).patch)).toEqual(patch);
	});

	it('leaves out a field the config did not carry', () => {
		expect(agentPatchFromConfig({ customModel: 'opus' })).toEqual({ model: 'opus' });
	});
});
