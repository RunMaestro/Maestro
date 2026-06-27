/**
 * @file contributions-tools.test.ts
 * @description A `tools` (AgentToolContribution) declared by a tier-1 plugin is
 * parsed, namespaced, and aggregated across plugins, while a tier-0 plugin's
 * tools are rejected (they run plugin code). This is the read seam the host
 * exposes via plugins:contributions; the brokered invoke that actually runs a
 * tool handler is exercised separately (plugin-sandbox-host-invoke-tool.test).
 */

import { describe, it, expect } from 'vitest';
import {
	collectContributions,
	aggregateContributions,
} from '../../../shared/plugins/contributions';
import type { PluginManifest } from '../../../shared/plugins/plugin-manifest';

function manifest(
	id: string,
	contributes: Record<string, unknown> | undefined,
	tier: 0 | 1 | 2 = 0
): PluginManifest {
	return {
		id,
		name: id,
		version: '1.0.0',
		tier,
		maestro: { minHostApi: '1.0.0' },
		...(contributes ? { contributes } : {}),
	};
}

describe('tool contributions', () => {
	it('parses and namespaces a tier-1 tool contribution', () => {
		const out = collectContributions(
			manifest(
				'p',
				{
					tools: [
						{
							id: 'lookup',
							name: 'Lookup',
							description: 'Look something up',
							inputSchema: { type: 'object' },
						},
					],
				},
				1
			)
		);
		expect(out.errors).toEqual([]);
		expect(out.tools).toHaveLength(1);
		expect(out.tools[0]).toMatchObject({
			id: 'p/lookup',
			localId: 'lookup',
			pluginId: 'p',
			name: 'Lookup',
			description: 'Look something up',
			inputSchema: { type: 'object' },
		});
	});

	it('rejects tools for a tier-0 plugin (they run code)', () => {
		const out = collectContributions(
			manifest('p', { tools: [{ id: 'lookup', name: 'Lookup', description: 'd' }] }, 0)
		);
		expect(out.tools).toHaveLength(0);
		expect(out.errors.some((e) => e.includes('tools require tier'))).toBe(true);
	});

	it('aggregates tools across plugins under errorsByPlugin', () => {
		const a = manifest('a', { tools: [{ id: 'one', name: 'One', description: 'd' }] }, 1);
		const b = manifest('b', { tools: [{ id: 'two', name: 'Two', description: 'd' }] }, 1);
		const agg = aggregateContributions([a, b]);
		expect(agg.tools.map((t) => t.id).sort()).toEqual(['a/one', 'b/two']);
		expect(agg.errorsByPlugin).toEqual({});
	});
});
