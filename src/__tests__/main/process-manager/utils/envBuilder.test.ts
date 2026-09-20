/**
 * Caller identity in spawned environments.
 *
 * `MAESTRO_CALLER_AGENT_ID` / `MAESTRO_CALLER_TAB_ID` tell an agent's shell which
 * agent and tab it runs under, so a `maestro-cli dispatch` it runs can be marked
 * in that agent's transcript. A copy inherited from whatever launched Maestro (an
 * agent shell, in development) names some OTHER agent, so it must never reach a
 * child - while the identity the spawn stamps on purpose must survive.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../main/runtime/getShellPath', () => ({
	peekShellPath: () => null,
}));

import {
	buildChildProcessEnv,
	buildPtyTerminalEnv,
} from '../../../../main/process-manager/utils/envBuilder';
import {
	CALLER_AGENT_ID_ENV_VAR,
	CALLER_TAB_ID_ENV_VAR,
	buildCallerIdentityEnv,
} from '../../../../shared/agentDelegation';

describe('envBuilder caller identity', () => {
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of [CALLER_AGENT_ID_ENV_VAR, CALLER_TAB_ID_ENV_VAR]) {
			saved.set(key, process.env[key]);
		}
		// What Maestro inherits when it was launched from inside another agent.
		process.env[CALLER_AGENT_ID_ENV_VAR] = 'launcher-agent';
		process.env[CALLER_TAB_ID_ENV_VAR] = 'launcher-tab';
	});

	afterEach(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		saved.clear();
	});

	it('strips an inherited identity from an agent spawn', () => {
		const env = buildChildProcessEnv();
		expect(env[CALLER_AGENT_ID_ENV_VAR]).toBeUndefined();
		expect(env[CALLER_TAB_ID_ENV_VAR]).toBeUndefined();
	});

	it('keeps the identity the spawn stamps through the session layer', () => {
		const env = buildChildProcessEnv(buildCallerIdentityEnv('agent-1', 'tab-1'));
		expect(env[CALLER_AGENT_ID_ENV_VAR]).toBe('agent-1');
		expect(env[CALLER_TAB_ID_ENV_VAR]).toBe('tab-1');
	});

	it('never hands an identity to a terminal the user drives', () => {
		const env = buildPtyTerminalEnv();
		expect(env[CALLER_AGENT_ID_ENV_VAR]).toBeUndefined();
		expect(env[CALLER_TAB_ID_ENV_VAR]).toBeUndefined();
	});
});
