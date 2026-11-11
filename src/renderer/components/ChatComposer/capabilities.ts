/**
 * ComposerCapabilities - which optional controls a composer's toolbar offers.
 *
 * The toolbar and the phone options sheet read only this object, so a control
 * is switched on or off for a surface in one place instead of each control
 * asking which agent, tab or room it is in. A flag exists only once something
 * reads it: a later step that needs a new switch adds the flag in the same
 * change that reads it.
 *
 * A flag says the surface OFFERS the control. Whether it can render right now
 * is still the control's own business (voice needs the Web Speech API and a
 * touch pointer, upload needs the web-desktop runtime and a handler).
 */

import type { AgentCapabilities } from '../../../shared/types';
import { agentCanReadImages } from '../../../shared/maestro-lib/providers/capabilities';
import type { ComposerCommandMode } from '../../utils/shellCommandInput';
import { getCachedCapabilities } from '../../hooks/agent/useAgentCapabilities';
import { notifyCenterFlash } from '../../stores/centerFlashStore';

export const MODERATOR_CANNOT_READ_IMAGES_MESSAGE = "This room's moderator can't read images";
export const REMOVE_ATTACHED_IMAGES_TO_SEND_DETAIL = 'Remove the attached images to send';

/**
 * Flash a standard yellow center notification explaining that the room's
 * moderator cannot read images.
 */
export function flashModeratorCannotReadImages(detail?: string): void {
	notifyCenterFlash({
		message: MODERATOR_CANNOT_READ_IMAGES_MESSAGE,
		color: 'yellow',
		...(detail ? { detail } : {}),
	});
}

export interface ModeratorCapabilitiesState {
	loading?: boolean;
	error?: unknown;
	capabilities?: AgentCapabilities;
}

/**
 * Answers whether the room's moderator can read attached images.
 *
 * Rules:
 * - If capabilities are unknown (loading, failed fetch, or not yet cached),
 *   we keep the pre-change behavior and return true.
 * - Only a known, successfully loaded `supportsImageInput: false` returns false.
 */
export function canModeratorReadImages(
	moderatorAgentId?: string | null,
	state?: ModeratorCapabilitiesState
): boolean {
	if (!moderatorAgentId) return true;
	if (state) {
		if (state.loading || state.error) return true;
		if (state.capabilities) {
			return agentCanReadImages(state.capabilities);
		}
	}
	return agentCanReadImages(getCachedCapabilities(moderatorAgentId));
}

export interface ComposerCapabilities {
	/** Attach Image button and its file picker. */
	imageAttach: boolean;
	/** Upload local files to the host (web-desktop only). */
	upload: boolean;
	/** Voice dictation (coarse pointer with the Web Speech API only). */
	voice: boolean;
	/** Save to History pill, and its row in the phone sheet. */
	saveToHistory: boolean;
	/** Permission / Read-Only pill, and its row in the phone sheet. */
	permission: boolean;
	/** Thinking pill, and its row in the phone sheet. */
	thinking: boolean;
	/** Model and effort pills, and their rows in the phone sheet. */
	modelEffort: boolean;
	/**
	 * The Enter-to-send toggle in the toolbar row. The AI composer leaves it to
	 * Settings > General to keep its pill row short; its terminal mode, which
	 * draws no pills, and a room keep it inline.
	 */
	enterToSendToggle: boolean;
}

/**
 * Group Chat's composer baseline. Every per-tab agent setting is off: a room
 * has no tab to save history from, mixes providers, and keeps its own Read-Only
 * toggle. `imageAttach` defaults to true on the frozen baseline; call
 * `deriveGroupChatComposerCapabilities` to gate on the moderator's provider.
 */
export const GROUP_CHAT_COMPOSER_CAPABILITIES: Readonly<ComposerCapabilities> = Object.freeze({
	imageAttach: true,
	upload: true,
	voice: true,
	saveToHistory: false,
	permission: false,
	thinking: false,
	modelEffort: false,
	enterToSendToggle: true,
});

export interface GroupChatComposerCapabilitiesInput {
	/** Result of `canModeratorReadImages()`; omitted means the preserved default. */
	canAttachImages?: boolean;
}

/**
 * Group Chat's composer capabilities, with `imageAttach` gated on whether
 * the moderator's provider can read images.
 */
export function deriveGroupChatComposerCapabilities(
	input?: GroupChatComposerCapabilitiesInput
): ComposerCapabilities {
	return {
		...GROUP_CHAT_COMPOSER_CAPABILITIES,
		imageAttach: input?.canAttachImages ?? true,
	};
}

export interface AiImageAttachInput {
	/** The AI composer's command-mode rung. */
	commandMode: ComposerCommandMode;
	/** The active tab already has a provider session (the next send resumes it). */
	isResumingSession: boolean;
	hasCapability: (capability: keyof AgentCapabilities) => boolean;
}

/**
 * Whether the AI composer can take an image right now. Neither command rung has
 * anywhere to put one (one pipes the draft to a shell, the other asks for a
 * command line), and a resumed session needs the provider to accept images on
 * resume.
 */
export function aiCanAttachImages({
	commandMode,
	isResumingSession,
	hasCapability,
}: AiImageAttachInput): boolean {
	if (commandMode !== 'off') return false;
	return isResumingSession
		? hasCapability('supportsImageInputOnResume')
		: hasCapability('supportsImageInput');
}

export interface AiComposerCapabilitiesInput extends AiImageAttachInput {
	inputMode: 'ai' | 'terminal';
	/** Whether the tab's provider can stream its reasoning. */
	supportsThinking: boolean;
}

/**
 * The AI composer's capabilities. Terminal mode offers none of them: the
 * toolbar there is the shell's working directory and the Enter toggle.
 */
export function deriveAiComposerCapabilities(
	input: AiComposerCapabilitiesInput
): ComposerCapabilities {
	const isAiMode = input.inputMode === 'ai';
	return {
		imageAttach: isAiMode && aiCanAttachImages(input),
		// The AI composer attaches images only; uploading arbitrary files to the
		// host is a room affordance.
		upload: false,
		voice: isAiMode,
		saveToHistory: isAiMode,
		permission: isAiMode && input.hasCapability('supportsReadOnlyMode'),
		thinking: isAiMode && input.supportsThinking,
		modelEffort: isAiMode,
		enterToSendToggle: !isAiMode,
	};
}
