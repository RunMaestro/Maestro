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
import {
	Bot,
	SlidersHorizontal,
	Users,
	FileText,
	CalendarClock,
	Workflow,
	LayoutDashboard,
	Sparkles,
} from 'lucide-react';
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
 * Examples worth showing, in the order they build confidence: the thing the
 * user was JUST offered (so the claim is immediately checkable), then the ones
 * that show the range.
 *
 * The first example deliberately names the font and the theme the user has this
 * second finished picking, and then keeps going past them - the claim being
 * made is "any setting", and a pill that stopped at typography would read as a
 * shortcut for the two screens behind it rather than a door onto all of them.
 *
 * The two automation examples are split by what STARTS them, because that is
 * the distinction the app actually makes: a Scheduled Task is clock-driven
 * (`time.scheduled` / `time.once`), while a pipeline hangs off an event nobody
 * can predict the timing of. Giving both a wall-clock prompt would present one
 * feature twice under two names.
 */
const EXAMPLES: Array<{
	icon: typeof Users;
	label: string;
	prompt: string;
}> = [
	{
		icon: SlidersHorizontal,
		label: 'Change any setting',
		prompt:
			'Set my AI chat font to Inter, switch me to a light theme, and turn on OS notifications.',
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
	{
		icon: CalendarClock,
		label: 'Schedule a task',
		prompt: 'Every weekday at 9am, summarize what changed in this repo overnight.',
	},
	{
		icon: Workflow,
		label: 'Build a Cue pipeline',
		prompt: 'Whenever a pull request opens on this repo, have an agent review it and report back.',
	},
	{
		icon: LayoutDashboard,
		label: 'Build me a dashboard',
		prompt:
			'Build me an HTML dashboard of this repo: commits per week, top contributors, open TODOs.',
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
						Maestro is a power tool. If you are a hacker it will feel like home: keyboard shortcuts
						all the way down, dozens of agents conducted at once, hands never leaving the keys. You
						do not have to work that way to get the benefit. Every agent running in Maestro is
						handed the knowledge of how to drive Maestro, down to the advanced parts like Auto Run
						and Cue pipelines, so ask for what you want in plain language and let the agent find the
						way there.
						{onTryExample ? ' Pick an example above to drop it into the composer.' : ''}
					</p>
				</div>
			</div>
		</Modal>
	);
}

export default AgentPowersModal;
