/**
 * MentionRoutingBar - shows, BEFORE send, how a message's `@agent` mentions
 * will run, and lets the user change it.
 *
 * The order is read from the user's own words (`inferMentionTiming`): "check
 * with @Backend first" consults before this agent answers, "then send what you
 * find to @Backend" hands this agent's answer over afterwards, and anything
 * else runs both at once. A guess the user cannot see is a guess they cannot
 * correct, so the strip states it plainly and offers two ways to change it:
 *
 * - The mode label is a menu. A pick overrides the wording for THIS message
 *   (`composerInputStore.mentionRoutingOverride`), travels with it into the
 *   queue (`QueuedItem.mentionRouting`), and "Auto" hands control back.
 * - "reword to change" opens the phrasings that ask for each mode, so the
 *   message itself carries the routing (which is also how `maestro-cli
 *   dispatch` and the other non-composer senders pick one).
 *
 * AI mode only, and only while the draft mentions another agent.
 */

import {
	memo,
	useCallback,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Wand2 } from 'lucide-react';
import type { Theme } from '../../../types';
import type { MentionRouting } from '../../../../shared/crossAgentContext';
import { formatConsultedAgentNames } from '../../../services/crossAgentConsultHold';
import { useAnchoredMenuPosition } from '../../../hooks/ui/useAnchoredMenuPosition';
import { useClickOutside } from '../../../hooks/ui/useClickOutside';
import { useFocusOnMount } from '../../../hooks/utils/useFocusAfterRender';
import { EscCloseButton } from '../../ui/EscCloseButton';
import { MiniBadge } from '../../ui/MiniBadge';
import { MENTION_ROUTING_COPY, MENTION_ROUTING_ORDER } from './mentionRoutingCopy';

interface MentionRoutingBarProps {
	theme: Theme;
	/** The routing the send will take. */
	routing: MentionRouting;
	/** What the wording alone says. Defaults to `routing`. */
	inferredRouting?: MentionRouting;
	/** True when `routing` is the user's pick, not the wording's. */
	explicit?: boolean;
	/** Display names of the mentioned agents, in message order. */
	agentNames: string[];
	/** Pick a routing for this message; `null` goes back to the wording. Omit for a read-only strip. */
	onRoutingChange?: (routing: MentionRouting | null) => void;
}

type OpenPopover = 'modes' | 'hint' | null;

export const MentionRoutingBar = memo(function MentionRoutingBar({
	theme,
	routing,
	inferredRouting = routing,
	explicit = false,
	agentNames,
	onRoutingChange,
}: MentionRoutingBarProps) {
	const [open, setOpen] = useState<OpenPopover>(null);
	const modesAnchorRef = useRef<HTMLButtonElement>(null);
	const hintAnchorRef = useRef<HTMLButtonElement>(null);
	const close = useCallback(() => setOpen(null), []);
	const toggle = (which: Exclude<OpenPopover, null>) =>
		setOpen((current) => (current === which ? null : which));

	const copy = MENTION_ROUTING_COPY[routing];
	const { Icon } = copy;
	const pick = (next: MentionRouting | null) => {
		onRoutingChange?.(next);
		setOpen(null);
	};

	return (
		<div
			className="flex items-center gap-2 px-3 py-1 border-b text-2xs select-none"
			style={{
				borderColor: `${theme.colors.accent}30`,
				backgroundColor: `color-mix(in srgb, ${theme.colors.accent} 10%, transparent)`,
			}}
			data-testid="mention-routing-bar"
			data-routing={routing}
			data-routing-explicit={explicit || undefined}
		>
			<Icon className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
			{onRoutingChange ? (
				<button
					ref={modesAnchorRef}
					type="button"
					onClick={() => toggle('modes')}
					className="flex items-center gap-0.5 font-medium uppercase tracking-wide shrink-0 rounded px-1 -mx-1 hover:bg-white/10 transition-colors"
					style={{ color: theme.colors.accent }}
					title="Change how the mentioned agents are consulted"
					aria-haspopup="menu"
					aria-expanded={open === 'modes'}
					data-testid="mention-routing-mode-button"
				>
					{copy.label}
					<ChevronDown className="w-3 h-3" />
				</button>
			) : (
				<span
					className="font-medium uppercase tracking-wide shrink-0"
					style={{ color: theme.colors.accent }}
				>
					{copy.label}
				</span>
			)}
			{explicit && (
				<MiniBadge
					label="set"
					theme={theme}
					title="You picked this routing. It applies to this message only."
					testId="mention-routing-explicit-badge"
				/>
			)}
			<span className="truncate" style={{ color: theme.colors.textDim }}>
				{copy.describe(
					formatConsultedAgentNames(agentNames.map((n) => `@${n}`)),
					agentNames.length > 1
				)}
			</span>
			<button
				ref={hintAnchorRef}
				type="button"
				onClick={() => toggle('hint')}
				className="ml-auto shrink-0 hidden sm:inline underline decoration-dotted hover:opacity-100 opacity-80"
				style={{ color: theme.colors.textDim }}
				aria-haspopup="dialog"
				aria-expanded={open === 'hint'}
				data-testid="mention-routing-hint-button"
			>
				reword to change
			</button>

			{open === 'modes' && onRoutingChange && (
				<RoutingPopover
					theme={theme}
					anchorRef={modesAnchorRef}
					align="start"
					onClose={close}
					label="Mention routing"
					testId="mention-routing-menu"
				>
					<RoutingMenuRow
						theme={theme}
						selected={!explicit}
						Icon={Wand2}
						label={`Auto: ${MENTION_ROUTING_COPY[inferredRouting].label}`}
						summary="Follow the wording of the message."
						onSelect={() => pick(null)}
						testId="mention-routing-option-auto"
					/>
					<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
					{MENTION_ROUTING_ORDER.map((mode) => {
						const row = MENTION_ROUTING_COPY[mode];
						return (
							<RoutingMenuRow
								key={mode}
								theme={theme}
								selected={explicit && mode === routing}
								Icon={row.Icon}
								label={row.label}
								summary={row.summary}
								onSelect={() => pick(mode)}
								testId={`mention-routing-option-${mode}`}
							/>
						);
					})}
				</RoutingPopover>
			)}

			{open === 'hint' && (
				<RoutingPopover
					theme={theme}
					anchorRef={hintAnchorRef}
					align="end"
					onClose={close}
					label="How to change the routing"
					testId="mention-routing-hint"
					title="Change the routing with your wording"
				>
					<div className="px-2 pb-2 space-y-2.5">
						{MENTION_ROUTING_ORDER.map((mode) => {
							const row = MENTION_ROUTING_COPY[mode];
							const current = mode === routing;
							return (
								<div
									key={mode}
									className="space-y-0.5"
									data-testid={`mention-routing-hint-${mode}`}
								>
									<div
										className="flex items-center gap-1.5 text-xs font-medium"
										style={{ color: current ? theme.colors.accent : theme.colors.textMain }}
									>
										<row.Icon className="w-3 h-3 shrink-0" />
										{row.label}
										{current && <MiniBadge label="now" theme={theme} />}
									</div>
									<div className="text-xs" style={{ color: theme.colors.textDim }}>
										{row.wording}
									</div>
									{row.examples.map((example) => (
										<div
											key={example}
											className="text-xs font-mono pl-2 border-l select-text"
											style={{ color: theme.colors.textMain, borderColor: theme.colors.border }}
										>
											{example}
										</div>
									))}
								</div>
							);
						})}
						{onRoutingChange && (
							<div
								className="pt-2 border-t text-xs"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							>
								Or pick a mode from the{' '}
								<button
									type="button"
									className="underline decoration-dotted"
									style={{ color: theme.colors.accent }}
									onClick={() => setOpen('modes')}
								>
									{copy.label}
								</button>{' '}
								menu. A pick applies to this message only.
							</div>
						)}
					</div>
				</RoutingPopover>
			)}
		</div>
	);
});

interface RoutingPopoverProps {
	theme: Theme;
	anchorRef: RefObject<HTMLElement | null>;
	align: 'start' | 'end';
	onClose: () => void;
	label: string;
	testId: string;
	/** Header text. Omit for a bare menu. */
	title?: string;
	children: ReactNode;
}

/**
 * The shell both popovers share: portaled above the strip (the composer clips
 * its own overflow), closed by a click elsewhere or Escape. Escape stops here:
 * in the composer it would otherwise interrupt the running turn. Arrow keys
 * walk the menu rows.
 */
function RoutingPopover({
	theme,
	anchorRef,
	align,
	onClose,
	label,
	testId,
	title,
	children,
}: RoutingPopoverProps) {
	const popoverRef = useRef<HTMLDivElement>(null);
	const { left, top, maxHeight, ready } = useAnchoredMenuPosition(popoverRef, anchorRef, {
		placement: 'above',
		align,
	});
	useClickOutside([popoverRef, anchorRef] as RefObject<HTMLElement | null>[], onClose, true, {
		delay: true,
	});
	useFocusOnMount(popoverRef, 0);

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
			e.preventDefault();
			e.stopPropagation();
			onClose();
			anchorRef.current?.focus();
			return;
		}
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		const rows = Array.from(
			popoverRef.current?.querySelectorAll<HTMLButtonElement>('[data-routing-row]') ?? []
		);
		if (rows.length === 0) return;
		e.preventDefault();
		e.stopPropagation();
		const at = rows.indexOf(document.activeElement as HTMLButtonElement);
		const step = e.key === 'ArrowDown' ? 1 : -1;
		rows[(at + step + rows.length) % rows.length]?.focus();
	};

	return createPortal(
		<div
			ref={popoverRef}
			role={title ? 'dialog' : 'menu'}
			aria-label={label}
			tabIndex={-1}
			onKeyDown={handleKeyDown}
			data-testid={testId}
			// Above the composer's own overlays, below modals.
			className="fixed z-[100] w-80 py-1 rounded shadow-xl border overflow-y-auto select-none outline-none"
			style={{
				left,
				top,
				maxHeight,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
			}}
		>
			{title && (
				<div className="flex items-center gap-2 pl-2 pr-1 pb-1.5">
					<span
						className="text-2xs uppercase tracking-wide flex-1"
						style={{ color: theme.colors.textDim }}
					>
						{title}
					</span>
					<EscCloseButton theme={theme} onClose={onClose} label="Close (Esc)" />
				</div>
			)}
			{children}
		</div>,
		document.body
	);
}

function RoutingMenuRow({
	theme,
	selected,
	Icon,
	label,
	summary,
	onSelect,
	testId,
}: {
	theme: Theme;
	selected: boolean;
	Icon: typeof Check;
	label: string;
	summary: string;
	onSelect: () => void;
	testId: string;
}) {
	return (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={selected}
			data-routing-row
			onClick={onSelect}
			className="w-full flex items-start gap-2 px-2.5 py-1.5 text-left hover:bg-white/10 focus:bg-white/10 outline-none transition-colors"
			data-testid={testId}
		>
			<Icon
				className="w-3.5 h-3.5 mt-0.5 shrink-0"
				style={{ color: selected ? theme.colors.accent : theme.colors.textDim }}
			/>
			<span className="flex-1 min-w-0">
				<span
					className="block text-xs font-medium"
					style={{ color: selected ? theme.colors.accent : theme.colors.textMain }}
				>
					{label}
				</span>
				<span className="block text-xs" style={{ color: theme.colors.textDim }}>
					{summary}
				</span>
			</span>
			{selected && (
				<Check className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: theme.colors.accent }} />
			)}
		</button>
	);
}
