/**
 * Prompt Links window.
 *
 * Three ways in (Opt+Cmd+Shift+L, "Prompt Links" in the command palette, the
 * Left Bar hamburger menu) plus "Create Prompt Link" in an AI tab's menu, which
 * opens it on that tab's agent with its unsent draft as the prompt. Two ways
 * out: Escape and the header X. All of them go through `openPromptLinks`, which
 * refuses while the Encore Feature is off.
 */

import { Modal } from '../ui/Modal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import type { PromptLinksModalData } from '../../stores/modalStore';
import type { Theme } from '../../types';
import { PromptLinksPanel } from './PromptLinksPanel';

export interface PromptLinksModalProps {
	theme: Theme;
	data?: PromptLinksModalData;
	onClose: () => void;
}

export function PromptLinksModal({ theme, data, onClose }: PromptLinksModalProps) {
	return (
		<Modal
			theme={theme}
			title="Prompt Links"
			subtitle="maestro://run links that send a prompt to an agent"
			priority={MODAL_PRIORITIES.PROMPT_LINKS}
			onClose={onClose}
			width={880}
			resizeKey="modal-prompt-links"
			defaultSize={{ width: 880, height: 600 }}
			minSize={{ width: 640, height: 420 }}
			testId="prompt-links-modal"
			// Flush: the split pane draws its own column divider and scrolls each side.
			contentClassName="flex-1 min-h-0 overflow-hidden"
		>
			<PromptLinksPanel
				theme={theme}
				initialAgentId={data?.agentId}
				initialPrompt={data?.prompt}
				compose={data?.compose}
			/>
		</Modal>
	);
}
