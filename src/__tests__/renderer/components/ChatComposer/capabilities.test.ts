import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
	GROUP_CHAT_COMPOSER_CAPABILITIES,
	MODERATOR_CANNOT_READ_IMAGES_MESSAGE,
	REMOVE_ATTACHED_IMAGES_TO_SEND_DETAIL,
	aiCanAttachImages,
	canModeratorReadImages,
	deriveAiComposerCapabilities,
	deriveGroupChatComposerCapabilities,
	flashModeratorCannotReadImages,
	type AiComposerCapabilitiesInput,
} from '../../../../renderer/components/ChatComposer';
import type { AgentCapabilities } from '../../../../shared/types';
import {
	setCapabilitiesCache,
	clearCapabilitiesCache,
	DEFAULT_CAPABILITIES,
} from '../../../../renderer/hooks/agent/useAgentCapabilities';
import { notifyCenterFlash } from '../../../../renderer/stores/centerFlashStore';

vi.mock('../../../../renderer/stores/centerFlashStore', async () => {
	const actual = await vi.importActual<
		typeof import('../../../../renderer/stores/centerFlashStore')
	>('../../../../renderer/stores/centerFlashStore');
	return {
		...actual,
		notifyCenterFlash: vi.fn(),
	};
});

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

describe('deriveGroupChatComposerCapabilities', () => {
	it('defaults imageAttach to true when input is omitted', () => {
		const caps = deriveGroupChatComposerCapabilities();
		expect(caps.imageAttach).toBe(true);
	});

	it('honors canAttachImages boolean flag directly', () => {
		expect(deriveGroupChatComposerCapabilities({ canAttachImages: true }).imageAttach).toBe(true);
		expect(deriveGroupChatComposerCapabilities({ canAttachImages: false }).imageAttach).toBe(false);
	});

	it('enables imageAttach when moderator supportsImageInput', () => {
		const caps = deriveGroupChatComposerCapabilities({
			hasCapability: capabilitiesOf('supportsImageInput'),
		});
		expect(caps.imageAttach).toBe(true);
		expect(caps.upload).toBe(true);
		expect(caps.voice).toBe(true);
		expect(caps.saveToHistory).toBe(false);
	});

	it('disables imageAttach when moderator lacks supportsImageInput', () => {
		const caps = deriveGroupChatComposerCapabilities({
			hasCapability: capabilitiesOf(),
		});
		expect(caps.imageAttach).toBe(false);
		expect(caps.upload).toBe(true);
		expect(caps.voice).toBe(true);
		expect(caps.saveToHistory).toBe(false);
	});
});

describe('canModeratorReadImages', () => {
	beforeEach(() => {
		clearCapabilitiesCache();
	});

	it('returns true when moderator is undefined or null', () => {
		expect(canModeratorReadImages(undefined)).toBe(true);
		expect(canModeratorReadImages(null)).toBe(true);
	});

	it('returns true while capabilities are loading', () => {
		expect(
			canModeratorReadImages('some-agent', {
				loading: true,
				capabilities: { ...DEFAULT_CAPABILITIES, supportsImageInput: false },
			})
		).toBe(true);
	});

	it('returns true when capability fetch produced an error', () => {
		expect(
			canModeratorReadImages('some-agent', {
				loading: false,
				error: new Error('network down'),
				capabilities: { ...DEFAULT_CAPABILITIES, supportsImageInput: false },
			})
		).toBe(true);
	});

	it('returns false only on known supportsImageInput: false in state', () => {
		expect(
			canModeratorReadImages('terminal', {
				loading: false,
				capabilities: { ...DEFAULT_CAPABILITIES, supportsImageInput: false },
			})
		).toBe(false);
	});

	it('returns true on known supportsImageInput: true in state', () => {
		expect(
			canModeratorReadImages('claude-code', {
				loading: false,
				capabilities: { ...DEFAULT_CAPABILITIES, supportsImageInput: true },
			})
		).toBe(true);
	});

	it('returns true for uncached moderator id (miss)', () => {
		expect(canModeratorReadImages('uncached-agent')).toBe(true);
	});

	it('reads cached capability when no state is passed', () => {
		setCapabilitiesCache('terminal', {
			...DEFAULT_CAPABILITIES,
			supportsImageInput: false,
		});
		setCapabilitiesCache('claude-code', {
			...DEFAULT_CAPABILITIES,
			supportsImageInput: true,
		});

		expect(canModeratorReadImages('terminal')).toBe(false);
		expect(canModeratorReadImages('claude-code')).toBe(true);
	});
});

describe('flashModeratorCannotReadImages', () => {
	beforeEach(() => {
		vi.mocked(notifyCenterFlash).mockClear();
	});

	it('flashes yellow notification with standard message', () => {
		flashModeratorCannotReadImages();
		expect(notifyCenterFlash).toHaveBeenCalledWith({
			message: MODERATOR_CANNOT_READ_IMAGES_MESSAGE,
			color: 'yellow',
		});
	});

	it('includes optional detail when provided', () => {
		flashModeratorCannotReadImages(REMOVE_ATTACHED_IMAGES_TO_SEND_DETAIL);
		expect(notifyCenterFlash).toHaveBeenCalledWith({
			message: MODERATOR_CANNOT_READ_IMAGES_MESSAGE,
			color: 'yellow',
			detail: REMOVE_ATTACHED_IMAGES_TO_SEND_DETAIL,
		});
	});
});
