/**
 * AgentPowersModal - the last first-run step.
 *
 * The two steps before it hand the user a settings screen. This one tells them
 * they did not have to use it: an agent running in Maestro can drive Maestro,
 * through the same CLI the UI itself calls. That is the single least
 * discoverable thing about the app - nothing on screen suggests the chat pane
 * can rearrange the window around it - so it is stated once, plainly, at the
 * moment the user has just been shown two things they can change.
 *
 * Deliberately a disclosure and not a decision: no preset, no toggle, one way
 * out. It closes the series rather than adding to it.
 */

import { useCallback, useRef } from 'react';
import { Bot, Palette, Type, Users, FileText, Sparkles } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { ModalBackButton } from './ui/ModalBackButton';

export interface AgentPowersModalProps {
	theme: Theme;
	isOpen: boolean;
	/** Mark the step seen and end the series. */
	onDismiss: () => void;
	/**
	 * Reopen the previous step of the series. Omitted when this ran on its own,
	 * in which case no Back control is drawn - a disabled one would claim a
	 * history that does not exist.
	 */
	onBack?: () => void;
	/**
	 * Drop a ready-made request into the active agent's composer, so the user
	 * can try this without inventing the phrasing. Omitted when there is no
	 * agent to talk to, in which case the examples read as illustrations.
	 */
	onTryExample?: (prompt: string) => void;
}

/**
 * Examples worth showing, in the order they build confidence: the two things
 * the user was JUST offered (so the claim is immediately checkable), then the
 * ones that show the range.
 */
const EXAMPLES: Array<{
	icon: typeof Palette;
	label: string;
	prompt: string;
}> = [
	{
		icon: Type,
		label: 'Change the fonts',
		prompt: 'Set my AI chat font to Inter and my terminal font to JetBrains Mono.',
	},
	{
		icon: Palette,
		label: 'Change the theme',
		prompt: 'Switch Maestro to a light theme and tell me which one you picked.',
	},
	{
		icon: Users,
		label: 'Create agents',
		prompt: 'Create a new agent called Scratch pointed at my home directory.',
	},
	{
		icon: FileText,
		label: 'Write an Auto Run doc',
		prompt:
			'Write me an Auto Run document that reviews this repo for TODOs and lists them as tasks.',
	},
];

export function AgentPowersModal({
	theme,
	isOpen,
	onDismiss,
	onBack,
	onTryExample,
}: AgentPowersModalProps) {
	const confirmRef = useRef<HTMLButtonElement>(null);

	const handleTry = useCallback(
		(prompt: string) => {
			onTryExample?.(prompt);
			onDismiss();
		},
		[onTryExample, onDismiss]
	);

	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title="Your agents can drive Maestro"
			headerIcon={<Bot className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.AGENT_POWERS}
			onClose={onDismiss}
			closeOnBackdropClick={false}
			width={720}
			maxWidthCss="92vw"
			initialFocusRef={confirmRef}
			testId="agent-powers-modal"
			footer={
				<div className="flex items-center gap-3 w-full">
					{onBack && <ModalBackButton theme={theme} onBack={onBack} testId="agent-powers-back" />}
					<button
						ref={confirmRef}
						type="button"
						onClick={onDismiss}
						data-testid="agent-powers-confirm"
						className="ml-auto px-3 py-1.5 rounded text-xs font-bold"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						Got it
					</button>
				</div>
			}
		>
			<div className="space-y-4">
				<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
					You just picked your typography and your theme by hand. You didn't have to. Anything you
					can do in Maestro, the agents inside it can do too - they reach the same controls the
					interface does, so you can simply ask.
				</p>

				<div className="grid grid-cols-2 gap-2">
					{EXAMPLES.map(({ icon: Icon, label, prompt }) => {
						const interactive = Boolean(onTryExample);
						return (
							<button
								key={label}
								type="button"
								disabled={!interactive}
								onClick={interactive ? () => handleTry(prompt) : undefined}
								data-testid={`agent-powers-example-${label.toLowerCase().replace(/\s+/g, '-')}`}
								className={`flex flex-col gap-1.5 p-3 rounded-lg border text-left transition-colors ${
									interactive ? 'hover:bg-white/5 cursor-pointer' : 'cursor-default'
								}`}
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgActivity,
								}}
							>
								<span className="flex items-center gap-2">
									<Icon className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
									<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
										{label}
									</span>
								</span>
								<span className="text-[11px] leading-snug" style={{ color: theme.colors.textDim }}>
									&ldquo;{prompt}&rdquo;
								</span>
							</button>
						);
					})}
				</div>

				<div
					className="flex items-start gap-2 p-3 rounded-lg border-l-4"
					style={{
						backgroundColor: `${theme.colors.accent}10`,
						borderLeftColor: theme.colors.accent,
					}}
				>
					<Sparkles className="w-4 h-4 mt-0.5 shrink-0" style={{ color: theme.colors.accent }} />
					<p className="text-xs leading-relaxed" style={{ color: theme.colors.textMain }}>
						This is not a fixed list. Creating agents, opening files, running playbooks, scheduling
						automation, rearranging the window - if it is in Maestro, it is reachable. Ask for what
						you want and let the agent find the way there.
						{onTryExample ? ' Pick an example above to drop it into the composer.' : ''}
					</p>
				</div>
			</div>
		</Modal>
	);
}

export default AgentPowersModal;
