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
import type { ComposerCommandMode } from '../../utils/shellCommandInput';

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
}

/**
 * Group Chat's composer. Every per-tab agent setting is off: a room has no tab
 * to save history from, mixes providers, and keeps its own Read-Only toggle.
 * `imageAttach` stays on because the room offers Attach today; deriving it from
 * the moderator's provider is a later step.
 */
export const GROUP_CHAT_COMPOSER_CAPABILITIES: Readonly<ComposerCapabilities> = Object.freeze({
	imageAttach: true,
	upload: true,
	voice: true,
	saveToHistory: false,
	permission: false,
	thinking: false,
	modelEffort: false,
});

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
		upload: isAiMode,
		voice: isAiMode,
		saveToHistory: isAiMode,
		permission: isAiMode && input.hasCapability('supportsReadOnlyMode'),
		thinking: isAiMode && input.supportsThinking,
		modelEffort: isAiMode,
	};
}
