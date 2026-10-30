import { describe, expect, it } from 'vitest';
import {
	GROUP_CHAT_COMPOSER_CAPABILITIES,
	aiCanAttachImages,
	deriveAiComposerCapabilities,
	type AiComposerCapabilitiesInput,
} from '../../../../renderer/components/ChatComposer';
import type { AgentCapabilities } from '../../../../shared/types';

function capabilitiesOf(...on: Array<keyof AgentCapabilities>) {
	return (capability: keyof AgentCapabilities) => on.includes(capability);
}

function input(overrides: Partial<AiComposerCapabilitiesInput> = {}): AiComposerCapabilitiesInput {
	return {
		inputMode: 'ai',
		commandMode: 'off',
		isResumingSession: false,
		hasCapability: capabilitiesOf('supportsImageInput', 'supportsReadOnlyMode'),
		supportsThinking: true,
		...overrides,
	};
}

describe('aiCanAttachImages', () => {
	it('follows supportsImageInput for a new session', () => {
		expect(aiCanAttachImages(input({ hasCapability: capabilitiesOf('supportsImageInput') }))).toBe(
			true
		);
		expect(aiCanAttachImages(input({ hasCapability: capabilitiesOf() }))).toBe(false);
	});

	it('follows supportsImageInputOnResume for a resumed session', () => {
		expect(
			aiCanAttachImages(
				input({
					isResumingSession: true,
					hasCapability: capabilitiesOf('supportsImageInput'),
				})
			)
		).toBe(false);
		expect(
			aiCanAttachImages(
				input({
					isResumingSession: true,
					hasCapability: capabilitiesOf('supportsImageInputOnResume'),
				})
			)
		).toBe(true);
	});

	it('is off on either command rung', () => {
		expect(aiCanAttachImages(input({ commandMode: 'shell' }))).toBe(false);
		expect(aiCanAttachImages(input({ commandMode: 'ai' }))).toBe(false);
	});
});

describe('deriveAiComposerCapabilities', () => {
	it('offers every control in AI mode on a fully capable agent', () => {
		expect(deriveAiComposerCapabilities(input())).toEqual({
			imageAttach: true,
			upload: true,
			voice: true,
			saveToHistory: true,
			permission: true,
			thinking: true,
			modelEffort: true,
		});
	});

	it('offers nothing in terminal mode', () => {
		expect(deriveAiComposerCapabilities(input({ inputMode: 'terminal' }))).toEqual({
			imageAttach: false,
			upload: false,
			voice: false,
			saveToHistory: false,
			permission: false,
			thinking: false,
			modelEffort: false,
		});
	});

	it('takes imageAttach from the image rule', () => {
		expect(deriveAiComposerCapabilities(input({ commandMode: 'shell' })).imageAttach).toBe(false);
		expect(
			deriveAiComposerCapabilities(input({ hasCapability: capabilitiesOf('supportsReadOnlyMode') }))
				.imageAttach
		).toBe(false);
	});

	it('takes permission from supportsReadOnlyMode', () => {
		expect(
			deriveAiComposerCapabilities(input({ hasCapability: capabilitiesOf('supportsImageInput') }))
				.permission
		).toBe(false);
	});

	it('takes thinking from the provider streaming its reasoning', () => {
		expect(deriveAiComposerCapabilities(input({ supportsThinking: false })).thinking).toBe(false);
	});

	it('keeps the mode-only flags on whatever the agent supports', () => {
		const caps = deriveAiComposerCapabilities(
			input({ hasCapability: capabilitiesOf(), supportsThinking: false })
		);
		expect(caps).toMatchObject({
			upload: true,
			voice: true,
			saveToHistory: true,
			modelEffort: true,
		});
	});
});

describe('GROUP_CHAT_COMPOSER_CAPABILITIES', () => {
	it('offers attach, upload and voice, and no per-tab agent setting', () => {
		expect(GROUP_CHAT_COMPOSER_CAPABILITIES).toEqual({
			imageAttach: true,
			upload: true,
			voice: true,
			saveToHistory: false,
			permission: false,
			thinking: false,
			modelEffort: false,
		});
	});

	it('cannot be changed by a caller', () => {
		expect(Object.isFrozen(GROUP_CHAT_COMPOSER_CAPABILITIES)).toBe(true);
	});
});
