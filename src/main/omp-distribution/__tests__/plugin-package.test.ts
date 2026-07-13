import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatePluginManifest } from '../../../shared/plugins/plugin-manifest';

const pluginRoot = join(process.cwd(), 'plugins', 'com.maestro.omp');
const pluginJson = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8')) as Record<
	string,
	unknown
>;
const artifactBuild = JSON.parse(
	readFileSync(join(pluginRoot, 'artifact-build.json'), 'utf8')
) as Record<string, unknown>;

describe('first-party OMP plugin package', () => {
	it('uses the canonical plugin identity and valid paired workspace/panel declaration', () => {
		const validated = validatePluginManifest(pluginJson);

		expect(validated.errors).toEqual([]);
		expect(validated.manifest).toMatchObject({ id: 'com.maestro.omp' });
		expect(pluginJson.permissions).toEqual([
			{ capability: 'ui:workspace' },
			{ capability: 'ui:interactivePanel' },
			{ capability: 'process:interactive', scope: 'omp' },
		]);
	});

	it('binds artifact metadata to the single closed OMP bridge descriptor source', () => {
		expect(artifactBuild).toEqual({
			schemaVersion: 1,
			pluginId: 'com.maestro.omp',
			bridgeDescriptor: 'src/bridge/descriptor.ts',
		});
		expect(existsSync(join(pluginRoot, artifactBuild.bridgeDescriptor as string))).toBe(true);
	});
});
