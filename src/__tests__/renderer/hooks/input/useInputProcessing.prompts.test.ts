import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('useInputProcessing prompt guards', () => {
	let originalPromptsApi: unknown;

	beforeEach(() => {
		vi.resetModules();
		originalPromptsApi = (window as any).maestro?.prompts;
		(window as any).maestro = {
			...(window as any).maestro,
			prompts: {
				get: vi.fn((id: string) => {
					if (id === 'image-only-default') {
						return Promise.resolve({ success: true, content: 'image prompt' });
					}
					if (id === 'maestro-system-prompt') {
						return Promise.resolve({ success: true, content: 'system prompt' });
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
		const inputPrompts = await import('../../../../renderer/hooks/input/useInputProcessing');

		expect(() => inputPrompts.getImageOnlyPrompt()).toThrow('Image-only prompt not loaded');
		expect(() => inputPrompts.getMaestroSystemPrompt()).toThrow(
			'Maestro system prompt not loaded'
		);
	});

	it('returns prompt values after load', async () => {
		const inputPrompts = await import('../../../../renderer/hooks/input/useInputProcessing');
		await inputPrompts.loadInputProcessingPrompts();

		expect(inputPrompts.getImageOnlyPrompt()).toBe('image prompt');
		expect(inputPrompts.getMaestroSystemPrompt()).toBe('system prompt');
	});
});
