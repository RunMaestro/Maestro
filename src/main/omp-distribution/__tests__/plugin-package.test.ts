import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pluginRoot = join(process.cwd(), 'plugins', 'com.maestro.omp');
const pluginJson = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8')) as Record<
	string,
	unknown
>;

describe('first-party OMP plugin package', () => {
	it('uses the canonical identity with only the headless native-provider permissions', () => {
		expect(pluginJson.id).toBe('com.maestro.omp');
		expect(pluginJson.permissions).toEqual([
			{ capability: 'storage:read' },
			{ capability: 'storage:write' },
			{ capability: 'process:interactive', scope: 'omp' },
		]);
		expect(pluginJson.contributes).toBeUndefined();
	});
});
