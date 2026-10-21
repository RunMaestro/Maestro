/**
 * QuickChatRouteLine - what became of one message sent from Quick Chat.
 *
 * Every message is routed on its own, so one chat can move between tabs. This
 * is the line under a message that says where it went: "Searching tabs" while a
 * tab is being chosen, then a pill naming the tab. The pill is the way to that
 * tab in the main window. A message whose tab is mid-reply shows that it is
 * queued, with the ways out: steer it into the reply already running (when the
 * agent can take it mid-turn), or send it to a new tab instead of waiting. A message
 * that went to a tab the user disagrees with has a thumbs-down beside the pill,
 * which sends it to a new tab instead.
 *
 * Explanations are hover overlays, not native titles, which do not show in the
 * Quick Chat panel while another app is active.
 */

import { useEffect, useState } from 'react';
import { Clock, History, MessagesSquare, Navigation, Plus, ThumbsDown } from 'lucide-react';
import { formatDurationHuman } from '../../shared/duration';
import type { QuickChatRoute, QuickChatRouteOrigin } from '../../shared/quickChat';
import { HoverTooltip } from '../components/ui/HoverTooltip';
import { Spinner } from '../components/ui/Spinner';
import type { Theme } from '../types';

const NO_DRAG_REGION = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
const TOOLTIP_MAX_WIDTH = 260;

/** How each kind of tab is drawn and described. */
const ORIGINS: Record<QuickChatRouteOrigin, { icon: typeof Plus; label: string }> = {
	open: { icon: MessagesSquare, label: 'Sent to an open tab' },
	reopened: { icon: History, label: 'Reopened a closed tab' },
	new: { icon: Plus, label: 'Started a new tab' },
};

function useElapsedSeconds(since: number | null): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (since === null) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [since]);
	return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

/** The "Working for 12s" line under a reply that is still being written. */
export function QuickChatWorkingLine({ since, theme }: { since: number | null; theme: Theme }) {
	const elapsed = useElapsedSeconds(since);
	return (
		<div style={{ color: theme.colors.textDim }} data-testid="quick-chat-working">
			{/* No known start: say so rather than freeze a "0s" that never moves. */}
			{since === null ? 'Working…' : `Working for ${formatDurationHuman(elapsed * 1000)}`}
		</div>
	);
}

function Explained({
	label,
	hint,
	theme,
	children,
}: {
	label: string;
	hint: string;
	theme: Theme;
	children: React.ReactNode;
}) {
	return (
		<HoverTooltip
			theme={theme}
			maxWidth={TOOLTIP_MAX_WIDTH}
			triggerStyle={NO_DRAG_REGION}
			triggerClassName="inline-flex min-w-0"
			label={
				<span className="flex flex-col gap-0.5">
					<span className="font-medium">{label}</span>
					<span style={{ color: theme.colors.textDim }}>{hint}</span>
				</span>
			}
		>
			{children}
		</HoverTooltip>
	);
}

interface QuickChatRouteLineProps {
	route: QuickChatRoute;
	theme: Theme;
	/** Open the message's tab in the main window. */
	onOpenTab: () => void;
	/**
	 * Send the message to a new tab instead: out of the queue, or stopped and
	 * sent again when it already ran in the tab it went to.
	 */
	onMoveToNewTab: () => void;
	/** Hand a queued message to the reply already running in its tab. */
	onSteer: () => void;
}

export function QuickChatRouteLine({
	route,
	theme,
	onOpenTab,
	onMoveToNewTab,
	onSteer,
}: QuickChatRouteLineProps) {
	const c = theme.colors;
	const lineClass = 'flex justify-end items-center gap-2 min-w-0 text-[0.85em]';

	if (route.status === 'searching') {
		return (
			<div className={lineClass} style={{ color: c.textDim }} data-testid="quick-chat-route">
				{/* The text beside it already says what is happening. */}
				<Spinner size={14} decorative />
				<span>Searching tabs…</span>
			</div>
		);
	}
	// A failed message is followed by its error; there is no tab to name.
	if (!route.tabId || !route.origin) {
		return route.status === 'cancelled' ? (
			<div className={lineClass} style={{ color: c.textDim }} data-testid="quick-chat-route">
				Cancelled
			</div>
		) : null;
	}

	const { icon: Icon, label } = ORIGINS[route.origin];
	const name = route.tabName ?? 'Tab';
	return (
		<div className={lineClass} data-testid="quick-chat-route">
			{route.status === 'queued' && (
				<>
					<Explained
						theme={theme}
						label="Send to a new tab"
						hint="Stop waiting. This message leaves the queue and runs in a new tab now."
					>
						<button
							type="button"
							onClick={onMoveToNewTab}
							aria-label="Send to a new tab instead of waiting"
							className="shrink-0 underline underline-offset-2 opacity-80 hover:opacity-100"
							style={{ ...NO_DRAG_REGION, color: c.accent }}
						>
							Send to a new tab
						</button>
					</Explained>
					{route.canSteer && (
						<Explained
							theme={theme}
							label="Steer"
							hint="Send this into the reply running now, so the agent can change course mid-task."
						>
							<button
								type="button"
								onClick={onSteer}
								aria-label="Steer this message into the running reply"
								className="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium transition-opacity hover:opacity-80"
								style={{
									...NO_DRAG_REGION,
									color: c.accent,
									backgroundColor: c.accent + '33',
								}}
								data-testid="quick-chat-route-steer"
							>
								<Navigation className="w-3.5 h-3.5" />
								Steer
							</button>
						</Explained>
					)}
					<Explained
						theme={theme}
						label="Queued"
						hint="This tab is writing another reply. The message runs when it finishes."
					>
						<span
							className="shrink-0 inline-flex items-center gap-1"
							style={{ color: c.warning }}
							data-testid="quick-chat-route-queued"
						>
							<Clock className="w-3.5 h-3.5" />
							Queued
						</span>
					</Explained>
				</>
			)}
			{route.status === 'cancelled' && <span style={{ color: c.textDim }}>Cancelled</span>}
			<Explained
				theme={theme}
				label={label}
				hint={
					route.tabOpen
						? `"${name}". Click to open it in Maestro.`
						: `"${name}". This tab is closed now.`
				}
			>
				<button
					type="button"
					onClick={onOpenTab}
					disabled={!route.tabOpen}
					aria-label={`${label}: ${name}. Open it in Maestro`}
					className="inline-flex items-center gap-1 min-w-0 max-w-[16rem] rounded-full px-2 py-0.5 transition-opacity opacity-80 hover:opacity-100 disabled:opacity-50"
					style={{
						...NO_DRAG_REGION,
						color: c.textMain,
						border: `1px solid ${c.border}`,
						backgroundColor: c.bgSidebar,
					}}
					data-testid="quick-chat-route-pill"
				>
					<Icon className="w-3.5 h-3.5 shrink-0" style={{ color: c.accent }} />
					<span className="truncate">{name}</span>
				</button>
			</Explained>
			{/* A tab Maestro picked, not one it made. A queued message has its own way out above. */}
			{route.origin !== 'new' && route.status !== 'queued' && (
				<Explained
					theme={theme}
					label="Wrong tab"
					hint={
						route.status === 'running'
							? `Stop the reply in "${name}" and send this message to a new tab. The chat continues there.`
							: 'Send this message again in a new tab. The chat continues there.'
					}
				>
					<button
						type="button"
						onClick={onMoveToNewTab}
						aria-label="Wrong tab. Send this message to a new tab"
						className="shrink-0 w-[2em] h-[2em] inline-flex items-center justify-center rounded-full transition-opacity opacity-90 hover:opacity-100"
						style={{
							...NO_DRAG_REGION,
							color: c.accentForeground,
							backgroundColor: c.accent,
						}}
						data-testid="quick-chat-route-reject"
					>
						<ThumbsDown className="w-3.5 h-3.5" />
					</button>
				</Explained>
			)}
		</div>
	);
}
