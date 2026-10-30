/**
 * The Sketch tab's chat pane: the session's chat, newest at the bottom. It
 * holds what the agent posts with `sketch_chat_post` (T12), the room's chat
 * as the bot relay mirrors it (`sketchBotRelay.ts`), and the conductor's own
 * `@bot` messages and their local replies. Names come from the posting actor,
 * never from the text. Every message renders as chat markdown; a guest's
 * images stay placeholders (`blockImages`). Bot replies the outbound screen
 * holds wait at the bottom with their "Publish anyway" chip
 * (`SketchHeldReplyChip`), after the guests' requests waiting on Run or Deny
 * (`SketchApprovalChip`, B2).
 *
 * A conductor message whose turn ran restricted because a guest edited the
 * board carries "Run with full access" once that turn is over (Q2). It runs
 * that one message again; the next message is restricted again.
 *
 * With `onSend`, the pane ends in the composer (`SketchChatComposer`): the
 * conductor chats with the room, or asks the agent with `@bot`.
 *
 * It is the Chat tab of the Collaborate panel (`SketchSharePanel`), so it has
 * no frame of its own: it fills its parent, which sets the width.
 */

import { ShieldOff } from 'lucide-react';
import type { Theme } from '../../types';
import { formatRelativeTime } from '../../../shared/formatters';
import { useStickToBottom } from '../../hooks/ui/useStickToBottom';
import type { SketchBotRequest, SketchChatMessage } from '../../stores/sketchSessionStore';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { Markdown } from '../Markdown';
import { SketchApprovalChip } from './SketchApprovalChip';
import { SketchHeldReplyChip } from './SketchHeldReplyChip';
import { SketchChatComposer } from './SketchChatComposer';

export interface SketchChatPaneProps {
	messages: readonly SketchChatMessage[];
	theme: Theme;
	/** Bot replies held for "Publish anyway" (`status: 'held'`). */
	heldReplies?: readonly SketchBotRequest[];
	onPublishHeld?: (replyTo: string) => void;
	onDiscardHeld?: (replyTo: string) => void;
	/** Guest requests shown as chips: awaiting Run or Deny, or running. */
	approvals?: readonly SketchBotRequest[];
	/** Requests waiting behind the per-link chip limit. */
	waitingApprovals?: number;
	onRunRequest?: (replyTo: string) => void;
	onDenyRequest?: (replyTo: string) => void;
	/** Ids of the messages "Run with full access" is offered on (`canEscalateSketchMessage()`). */
	escalatable?: ReadonlySet<string>;
	onEscalate?: (replyTo: string) => void;
	/** Send the conductor's chat; no composer without it. */
	onSend?: (text: string) => Promise<unknown>;
	/** The sketch has a room, so a plain message goes to it. */
	shared?: boolean;
}

const NO_REQUESTS: readonly SketchBotRequest[] = [];
const NO_IDS: ReadonlySet<string> = new Set();
const noop = () => {};

/** "Run with full access" under a conductor message that ran restricted (Q2). */
function EscalateControl({
	replyTo,
	theme,
	onEscalate,
}: {
	replyTo: string;
	theme: Theme;
	onEscalate: (replyTo: string) => void;
}) {
	return (
		<div className="flex flex-col items-start gap-1 pt-1 select-none">
			<span className="text-xs" style={{ color: theme.colors.textDim }}>
				A guest edited this board, so this ran restricted.
			</span>
			<HeaderActionButton
				theme={theme}
				variant="ghost"
				icon={<ShieldOff />}
				onClick={() => onEscalate(replyTo)}
			>
				Run with full access
			</HeaderActionButton>
		</div>
	);
}

export function SketchChatPane({
	messages,
	theme,
	heldReplies = NO_REQUESTS,
	onPublishHeld = noop,
	onDiscardHeld = noop,
	approvals = NO_REQUESTS,
	waitingApprovals = 0,
	onRunRequest = noop,
	onDenyRequest = noop,
	escalatable = NO_IDS,
	onEscalate = noop,
	onSend,
	shared = false,
}: SketchChatPaneProps) {
	const listRef = useStickToBottom<HTMLDivElement>(
		messages.length + heldReplies.length + approvals.length
	);
	return (
		<div className="flex-1 flex flex-col min-h-0" data-sketch-chat="">
			<div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 flex flex-col gap-3">
				{messages.map((message) => (
					<div key={message.id} className="flex flex-col gap-0.5">
						<div className="flex items-baseline gap-2 text-xs select-none">
							<span className="font-medium" style={{ color: theme.colors.accent }}>
								{message.actor.name}
							</span>
							<span style={{ color: theme.colors.textDim }}>{formatRelativeTime(message.ts)}</span>
						</div>
						<div className="text-sm select-text">
							<Markdown
								preset="chat"
								theme={theme}
								content={message.text}
								className="text-[inherit] break-words"
								chatLineBreaks
								chatMath
								blockImages={message.actor.kind === 'guest'}
							/>
						</div>
						{message.request && escalatable.has(message.id) && (
							<EscalateControl
								replyTo={message.request.replyTo}
								theme={theme}
								onEscalate={onEscalate}
							/>
						)}
					</div>
				))}
				{approvals.map((request) => (
					<SketchApprovalChip
						key={request.replyTo}
						request={request}
						theme={theme}
						onRun={onRunRequest}
						onDeny={onDenyRequest}
					/>
				))}
				{waitingApprovals > 0 && (
					<div className="text-xs select-none" style={{ color: theme.colors.textDim }}>
						{waitingApprovals} more {waitingApprovals === 1 ? 'request waits' : 'requests wait'}{' '}
						behind these.
					</div>
				)}
				{heldReplies.map((request) => (
					<SketchHeldReplyChip
						key={request.replyTo}
						request={request}
						theme={theme}
						onPublish={onPublishHeld}
						onDiscard={onDiscardHeld}
					/>
				))}
				{messages.length === 0 && approvals.length === 0 && heldReplies.length === 0 && (
					<div className="text-xs select-none" style={{ color: theme.colors.textDim }}>
						No messages yet.
					</div>
				)}
			</div>
			{onSend && <SketchChatComposer theme={theme} shared={shared} onSend={onSend} />}
		</div>
	);
}
