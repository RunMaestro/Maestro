/**
 * The spawn env must never carry an UNNAMED row.
 *
 * "Add Variable" creates a row with no name on purpose, so the name field can
 * offer the provider's own variables instead of a placeholder the user has to
 * delete. That row lives in the same record as the real ones until it is filled
 * in, and a user who types the value before the name leaves `{'': 'x'}` behind.
 * `env[''] = 'x'` is a variable no child can read, and Windows rejects the empty
 * name outright, so both merge paths drop it.
 */

import { describe, it, expect } from 'vitest';
import {
	buildChildProcessEnv,
	collectMaestroEnvVars,
} from '../../../../main/process-manager/utils/envBuilder';

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
