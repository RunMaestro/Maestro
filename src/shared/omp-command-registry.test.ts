import { describe, expect, it } from 'vitest';
import { OMP_16_4_8_COMMAND_IDS, OMP_16_4_8_COMMAND_REGISTRY } from './omp-command-registry';

describe('OMP 16.4.8 command registry', () => {
	it('only claims adapter dispatch and renderer callers for supported commands', () => {
		expect(Object.keys(OMP_16_4_8_COMMAND_REGISTRY)).toEqual([...OMP_16_4_8_COMMAND_IDS]);

		for (const entry of Object.values(OMP_16_4_8_COMMAND_REGISTRY)) {
			if (entry.disposition === 'unsupported') {
				expect(entry.adapterHandler).toBeUndefined();
				expect(entry.rendererCaller).toBeUndefined();
				expect(entry.rationale).toBeTruthy();
				continue;
			}
			expect(entry.adapterHandler).toBeTruthy();
			if (entry.disposition === 'ui') expect(entry.rendererCaller).toBeTruthy();
			if (entry.disposition === 'host') expect(entry.rationale).toBeTruthy();
		}
	});

	it('marks unimplemented OMP verbs as unsupported instead of borrowing another dispatcher', () => {
		expect(
			Object.entries(OMP_16_4_8_COMMAND_REGISTRY)
				.filter(([, entry]) => entry.disposition === 'unsupported')
				.map(([id]) => id)
		).toEqual([
			'steer',
			'follow_up',
			'abort_and_prompt',
			'set_todos',
			'get_subagent_messages',
			'get_branch_messages',
			'get_last_assistant_text',
		]);
	});

	it('projects discovered login providers into the native runtime surface', () => {
		expect(OMP_16_4_8_COMMAND_REGISTRY.get_login_providers).toMatchObject({
			disposition: 'host',
			adapterHandler: 'refreshFeatures',
		});
	});
});
