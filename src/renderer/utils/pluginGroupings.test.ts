import { describe, expect, it } from 'vitest';
import { buildVirtualGrouping } from './pluginGroupings';

describe('buildVirtualGrouping', () => {
	it('uses first matching rule and places unmatched sessions in Other without mutating session metadata', () => {
		const sessions = [
			{ id: 'a', name: 'API task', toolType: 'claude', cwd: 'C:/work/api' },
			{ id: 'b', name: 'Other', toolType: 'codex', cwd: 'C:/elsewhere' },
		];
		const model = buildVirtualGrouping(
			{
				id: 'com.test/by-type',
				pluginId: 'com.test',
				localId: 'by-type',
				label: 'By type',
				rules: [
					{ match: { toolType: 'claude' }, group: 'Claude' },
					{ match: { cwdGlob: 'C:/work/*', namePattern: 'API *' }, group: 'API' },
				],
			},
			sessions
		);
		expect(model.assignments).toEqual({
			a: 'virtual:com.test/by-type:Claude',
			b: 'virtual:com.test/by-type:Other',
		});
		expect(sessions[0]).toEqual({
			id: 'a',
			name: 'API task',
			toolType: 'claude',
			cwd: 'C:/work/api',
		});
	});
});
