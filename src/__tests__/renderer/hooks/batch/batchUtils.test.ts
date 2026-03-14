import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('batchUtils prompt guards', () => {
	let originalPromptsApi: unknown;

	beforeEach(() => {
		vi.resetModules();
		originalPromptsApi = (window as any).maestro?.prompts;
		(window as any).maestro = {
			...(window as any).maestro,
			prompts: {
				get: vi.fn((id: string) => {
					if (id === 'autorun-default') {
						return Promise.resolve({ success: true, content: 'default prompt' });
					}
					if (id === 'autorun-synopsis') {
						return Promise.resolve({ success: true, content: 'synopsis prompt' });
					}
					return Promise.resolve({ success: false, error: `Unknown prompt: ${id}` });
				}),
			},
		};
	});

	afterEach(() => {
		(window as any).maestro.prompts = originalPromptsApi;
	});

	it('throws if prompt getters are called before load', async () => {
		const batchUtils = await import('../../../../renderer/hooks/batch/batchUtils');
		expect(() => batchUtils.getDefaultBatchPrompt()).toThrow('Default Auto Run prompt not loaded');
		expect(() => batchUtils.getAutorunSynopsisPrompt()).toThrow(
			'Auto Run synopsis prompt not loaded'
		);
	});

	it('returns prompt values after load', async () => {
		const batchUtils = await import('../../../../renderer/hooks/batch/batchUtils');
		await batchUtils.loadBatchPrompts();

		expect(batchUtils.getDefaultBatchPrompt()).toBe('default prompt');
		expect(batchUtils.getAutorunSynopsisPrompt()).toBe('synopsis prompt');
	});
});
