// Source: src/__tests__/main/process-manager/utils/envBuilder.test.ts
// Source: src/__tests__/main/process-manager/utils/envBuilder.blankKeys.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	buildChildProcessEnv,
	buildPtyTerminalEnv,
	collectMaestroEnvVars,
} from '../../../../main/process-manager/utils/envBuilder';
import {
	CALLER_AGENT_ID_ENV_VAR,
	CALLER_TAB_ID_ENV_VAR,
	CALLER_RUN_PROOF_FILE_ENV_VAR,
	buildCallerIdentityEnv,
} from '../../../../shared/agentDelegation';
vi.mock('../../../../shared/maestro-lib/launch/getShellPath', () => ({
	peekShellPath: () => null,
}));
describe('envBuilder', () => {
	describe('envBuilder caller identity', () => {
		const saved = new Map<string, string | undefined>();

		beforeEach(() => {
			for (const key of [
				CALLER_AGENT_ID_ENV_VAR,
				CALLER_TAB_ID_ENV_VAR,
				CALLER_RUN_PROOF_FILE_ENV_VAR,
			]) {
				saved.set(key, process.env[key]);
			}
			// What Maestro inherits when it was launched from inside another agent.
			process.env[CALLER_AGENT_ID_ENV_VAR] = 'launcher-agent';
			process.env[CALLER_TAB_ID_ENV_VAR] = 'launcher-tab';
			process.env[CALLER_RUN_PROOF_FILE_ENV_VAR] = '/private/launcher-proof';
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
			expect(env[CALLER_RUN_PROOF_FILE_ENV_VAR]).toBeUndefined();
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
			expect(env[CALLER_RUN_PROOF_FILE_ENV_VAR]).toBeUndefined();
		});
	});
});
describe('envBuilder.blankKeys', () => {
	describe('envBuilder drops unnamed env-var rows', () => {
		it('buildChildProcessEnv never exports a blank name', () => {
			const env = buildChildProcessEnv({ '': 'orphan', REAL: 'kept' }, false, {
				'   ': 'also orphan',
			});

			expect('' in env).toBe(false);
			expect('   ' in env).toBe(false);
			expect(env.REAL).toBe('kept');
		});

		it('collectMaestroEnvVars never reports a blank name', () => {
			const vars = collectMaestroEnvVars({ '': 'global orphan' }, { '': 'session orphan', A: '1' });

			expect('' in vars).toBe(false);
			expect(vars.A).toBe('1');
		});

		it('leaves a NAMED blank-valued row cancelling as before', () => {
			// Regression guard: the unnamed-row rule must not weaken the older rule
			// that a blank VALUE cancels a lower layer.
			const env = buildChildProcessEnv({ CANCELLED: '' }, false, { CANCELLED: 'from global' });

			expect('CANCELLED' in env).toBe(false);
		});
	});
});
