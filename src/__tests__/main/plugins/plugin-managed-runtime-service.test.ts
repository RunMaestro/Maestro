import { describe, expect, it } from 'vitest';
import { PluginManagedRuntimeService } from '../../../main/plugins/plugin-managed-runtime-service';

describe('PluginManagedRuntimeService', () => {
	it('owns one capability-authorized JSON runtime and exposes only canonical frames', async () => {
		const sent: Record<string, unknown>[] = [];
		const service = new PluginManagedRuntimeService({
			authorize: (request) => request.capabilities.includes('process:interactive'),
			launch: async () => ({
				writeCanonicalJson: (frame) => sent.push(frame),
				onEvent: () => () => undefined,
				stop: async () => undefined,
			}),
		});
		const handle = await service.start({
			ownerPluginId: 'com.maestro.omp',
			generation: 1n,
			capabilities: ['process:interactive'],
			scope: 'omp',
			workspaceRoot: 'C:/work',
			options: { restore: false },
		});
		handle.writeCanonicalJson({ type: 'get_state' });

		expect(sent).toEqual([{ type: 'get_state' }]);
		await expect(
			service.start({
				ownerPluginId: 'com.maestro.omp',
				generation: 1n,
				capabilities: ['process:interactive'],
				scope: 'omp',
				workspaceRoot: 'C:/work',
				options: {},
			})
		).rejects.toThrow(/active/);
	});
});
