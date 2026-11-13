/**
 * Tests for maestro-lib/autorun/launch - the checks every Auto Run launch
 * passes before it is sent, here for the run's own Run on target.
 */

import { describe, it, expect } from 'vitest';
import {
	validateAutoRunLaunch,
	validateGoalRunLaunch,
} from '../../../../shared/maestro-lib/autorun/launch';

const documents = [{ file: '/p/.maestro/playbooks/a.md' }];

describe('validateAutoRunLaunch: runOn', () => {
	it('keeps a valid target, in its stored form', () => {
		const checked = validateAutoRunLaunch({
			documents,
			runOn: { type: 'source', endpointId: ' ep-ollama ', model: 'qwen3:latest' },
		});
		expect(checked).toMatchObject({
			ok: true,
			value: { runOn: { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' } },
		});
	});

	it('keeps the provider as a target', () => {
		expect(validateAutoRunLaunch({ documents, runOn: { type: 'provider' } })).toMatchObject({
			ok: true,
			value: { runOn: { type: 'provider' } },
		});
	});

	it('refuses a malformed target rather than drop it', () => {
		const checked = validateAutoRunLaunch({ documents, runOn: { type: 'source' } as never });
		expect(checked.ok).toBe(false);
		if (checked.ok) throw new Error('expected a refusal');
		expect(checked.reason).toMatch(/^Run on: /);
	});

	it('leaves runOn out when none was given', () => {
		const checked = validateAutoRunLaunch({ documents });
		if (!checked.ok) throw new Error(checked.reason);
		expect(checked.value).not.toHaveProperty('runOn');
	});
});

describe('validateGoalRunLaunch: runOn', () => {
	it('keeps a valid target and refuses a malformed one', () => {
		expect(validateGoalRunLaunch({ goal: 'ship it', runOn: { type: 'provider' } })).toMatchObject({
			ok: true,
			value: { runOn: { type: 'provider' } },
		});
		expect(validateGoalRunLaunch({ goal: 'ship it', runOn: { type: 'source' } as never }).ok).toBe(
			false
		);
	});
});
