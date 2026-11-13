/**
 * The Sketch tab's Collaborate panel (spec section 6).
 *
 * Signed out, it is the RunMaestro.ai sign-in. Signed in on a sketch that is
 * not shared, it is one step: pick Can edit or Can view, then Share and copy
 * link. Its tabs each hold one job:
 *
 * - Chat (when the sketch has a room or holds anything): the session's chat
 *   and composer (`SketchChatPane`), built by `SketchTabView` and passed in.
 * - Share: the sign-in, a new link, and each live link with Copy, Reset and
 *   Revoke (plus
 *   Unsuspend when the room suspended `@bot` on it).
 * - People (once shared): who is in the room, with Kick and Unlock (`SketchRoomMembers`).
 * - Safety (once shared): who may ask the agent (B2, `SketchBotPolicyToggle`), how guest text
 *   is screened, flagged elements (`SketchFlaggedElements`), and Reset all
 *   access.
 *
 * The tab strip shows once there are two tabs. `SketchTabView` owns which tab
 * is showing, so a guest request can bring Chat forward. The footer, on every
 * tab but Chat, names the signed-in account and holds Stop sharing. Reset all
 * access and Stop sharing ask again in place before they run.
 *
 * The panel's left edge drags to resize it (`PanelResizeHandle`); the width is
 * remembered across sketches and restarts, and clamped at render so the canvas
 * always keeps {@link COLLABORATE_CANVAS_RESERVE} pixels.
 *
 * Every action is a `window.maestro.sketch.*` call into the one SketchService
 * that `maestro-cli sketch share|unshare|link|reset-link|revoke-link|rotate|
 * owner` also reaches. A link holds the room key and its cap; main keeps the
 * cap sealed beside the key, so Copy rebuilds any live link. A link is copied
 * straight to the clipboard (`flashCopiedToClipboard()` names it, never shows
 * it); only when the clipboard refuses is it shown here, to copy by hand.
 *
 * While the email confirmation is pending, the panel waits on main's poll
 * whenever it is open, so it turns to the signed-in state on its own once the
 * link in the email is clicked, also after it was closed and opened again.
 */

import React from 'react';
import { Copy, Link2, RefreshCw, RotateCcw, Share2, Trash2, X } from 'lucide-react';
import type { Theme } from '../../types';
import type { SketchOwnerStatus } from '../../../shared/sketch/server';
import type { SketchLinkRole, SketchRecord } from '../../../shared/sketch/types';
import { formatFutureTime } from '../../../shared/formatters';
import { GhostIconButton } from '../ui/GhostIconButton';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { MiniBadge } from '../ui/MiniBadge';
import { ModalTabStrip, tabPanelProps, type ModalTab } from '../ui/ModalTabStrip';
import { PanelResizeHandle } from '../ui/PanelResizeHandle';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Spinner } from '../ui/Spinner';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { livePanelMaxWidth, usePersistedPanelWidth } from '../../hooks/ui/usePersistedPanelWidth';
import { useResizablePanel } from '../../hooks/ui/useResizablePanel';
import { useSketchSessionStore } from '../../stores/sketchSessionStore';
import {
	copyExistingSketchLink,
	resetSketchLinkAndCopy,
	shareSketchAndCopyLink,
	sketchLinkLabel,
} from '../../services/sketchSharing';
import { SketchBotPolicyToggle } from './SketchBotPolicyToggle';
import { SketchScreeningBadge } from './SketchRoomScreening';
import {
	findRoomStatsCap,
	SketchFlaggedElements,
	SketchMetaLine,
	SketchPanelSection,
	SketchRoomMembers,
	useSketchRoomStats,
} from './SketchRoomSections';

export type CollaborateTab = 'chat' | 'share' | 'people' | 'safety';

export interface SketchSharePanelProps {
	sketchId: string;
	theme: Theme;
	onClose: () => void;
	/** The tab asked for. One that is not offered right now shows the first that is. */
	tab: CollaborateTab;
	onTabChange: (tab: CollaborateTab) => void;
	/** The Chat tab's content (`SketchChatPane`); no Chat tab without it. */
	chat?: React.ReactNode;
	/** Chat messages not seen yet, counted on the Chat tab. */
	chatUnread?: number;
	/** Width of the row the panel sits in, 0 while not measured. */
	availableWidth: number;
}

const ROLE_OPTIONS = [
	{ value: 'rw' as const, label: 'Can edit' },
	{ value: 'ro' as const, label: 'Can view' },
];

const TAB_PREFIX = 'sketch-collaborate';

/** localStorage key for the width the user dragged the panel to. */
export const COLLABORATE_WIDTH_STORAGE_KEY = 'sketchBook.collaborateWidth';
/** Narrowest panel where the four tabs still fit in one row. */
export const COLLABORATE_MIN_WIDTH = 288;
export const COLLABORATE_DEFAULT_WIDTH = 320;
export const COLLABORATE_MAX_WIDTH = 720;
/** Canvas left of the panel that a drag may never eat into. */
export const COLLABORATE_CANVAS_RESERVE = 320;

const ROTATE_WARNING =
	'Every link stops working and every guest is disconnected. The room history is cleared and the sketch is uploaded again under a new key.';
const UNSHARE_WARNING =
	'The room is deleted on RunMaestro.ai and every guest is disconnected. The sketch stays on this computer.';

/** A button that asks again in place, with the consequence, before it runs. */
function ConfirmInPlace({
	theme,
	label,
	warning,
	icon,
	busy,
	onConfirm,
}: {
	theme: Theme;
	label: string;
	warning: string;
	icon?: React.ReactNode;
	busy: boolean;
	onConfirm: () => void;
}) {
	const [armed, setArmed] = React.useState(false);
	if (!armed) {
		return (
			<HeaderActionButton
				theme={theme}
				variant="ghost"
				icon={icon}
				disabled={busy}
				onClick={() => setArmed(true)}
			>
				{label}
			</HeaderActionButton>
		);
	}
	return (
		<div className="basis-full flex flex-col gap-2">
			<div style={{ color: theme.colors.warning }}>{warning}</div>
			<div className="flex gap-2">
				<HeaderActionButton
					theme={theme}
					disabled={busy}
					onClick={() => {
						setArmed(false);
						onConfirm();
					}}
				>
					{label}
				</HeaderActionButton>
				<HeaderActionButton theme={theme} variant="ghost" onClick={() => setArmed(false)}>
					Cancel
				</HeaderActionButton>
			</div>
		</div>
	);
}

export function SketchSharePanel({
	sketchId,
	theme,
	onClose,
	tab: requestedTab,
	onTabChange,
	chat,
	chatUnread = 0,
	availableWidth,
}: SketchSharePanelProps) {
	const [record, setRecord] = React.useState<SketchRecord | null>(null);
	const [owner, setOwner] = React.useState<SketchOwnerStatus | null>(null);
	const [email, setEmail] = React.useState('');
	const [role, setRole] = React.useState<SketchLinkRole>('rw');
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	/** A link the clipboard refused, to copy by hand. */
	const [uncopied, setUncopied] = React.useState<string | null>(null);
	const stats = useSketchRoomStats(sketchId);
	const screening = useSketchSessionStore((s) => {
		const room = s.sessions[sketchId]?.room;
		return room && room.connection !== 'stopped' ? room.screening.server : null;
	});
	const {
		width: storedWidth,
		setWidth,
		reset: resetWidth,
	} = usePersistedPanelWidth(COLLABORATE_WIDTH_STORAGE_KEY, {
		defaultWidth: COLLABORATE_DEFAULT_WIDTH,
		minWidth: COLLABORATE_MIN_WIDTH,
		maxWidth: COLLABORATE_MAX_WIDTH,
	});
	const maxWidth = livePanelMaxWidth(availableWidth, {
		minWidth: COLLABORATE_MIN_WIDTH,
		maxWidth: COLLABORATE_MAX_WIDTH,
		reserve: COLLABORATE_CANVAS_RESERVE,
	});
	// The drag starts from the width on screen, which a narrow window clamps.
	const width = Math.min(storedWidth, maxWidth);
	const { panelRef, onResizeStart } = useResizablePanel({
		width,
		minWidth: COLLABORATE_MIN_WIDTH,
		maxWidth,
		setWidth,
		side: 'right',
	});
	const mounted = React.useRef(true);
	/** True while this panel waits on main's confirmation poll. */
	const waiting = React.useRef(false);

	React.useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const refresh = React.useCallback(async () => {
		const [nextRecord, nextOwner] = await Promise.all([
			window.maestro.sketch.get(sketchId),
			window.maestro.sketch.ownerStatus(),
		]);
		if (!mounted.current) return;
		setRecord(nextRecord);
		setOwner(nextOwner);
	}, [sketchId]);

	React.useEffect(() => {
		refresh().catch((err) => setError(ipcErrorMessage(err)));
	}, [refresh]);

	const shared = record?.share ?? null;

	// Ask the server for fresh stats once the panel shows a shared sketch;
	// pushes keep them current after.
	React.useEffect(() => {
		if (shared) window.maestro.sketch.roomStats(sketchId).catch(() => undefined);
	}, [sketchId, shared]);

	// Wait for the click whenever a confirmation is pending: after Send, and when
	// the panel opens on a pending one. Main polls (15 minutes at most per wait,
	// one poll shared by every caller); a wait that ends still pending sets a new
	// status, which starts the next one. Not part of the busy state: the panel
	// stays usable, to send the email again.
	React.useEffect(() => {
		if (owner?.state !== 'pending' || owner.otherServer || waiting.current) return;
		waiting.current = true;
		window.maestro.sketch
			.waitForOwner()
			.then((status) => {
				waiting.current = false;
				if (mounted.current) setOwner(status);
			})
			.catch((err) => {
				waiting.current = false;
				if (mounted.current) setError(ipcErrorMessage(err));
			});
	}, [owner]);

	/** Run one action: busy while it runs, its error shown, the state read again after. */
	const run = React.useCallback(
		async (action: () => Promise<unknown>) => {
			setBusy(true);
			setError(null);
			try {
				await action();
			} catch (err) {
				if (mounted.current) setError(ipcErrorMessage(err));
			} finally {
				if (mounted.current) setBusy(false);
				await refresh().catch(() => undefined);
			}
		},
		[refresh]
	);

	const register = () =>
		run(async () => {
			await window.maestro.sketch.registerOwner(email);
			if (mounted.current) setOwner(await window.maestro.sketch.ownerStatus());
		});

	/** Run a link action that copies a link; a refused clipboard shows the link instead. */
	const runCopy = (action: () => Promise<{ url: string; copied: boolean }>) =>
		run(async () => {
			setUncopied(null);
			const { url, copied } = await action();
			if (!copied && mounted.current) setUncopied(url);
		});

	const share = () =>
		runCopy(async () => {
			const { result, copied } = await shareSketchAndCopyLink(sketchId, { role });
			return { url: result.link.url, copied };
		});

	const dim = { color: theme.colors.textDim };
	const liveLinks = shared?.links.filter((link) => !link.revoked) ?? [];
	const signedIn = owner?.state === 'confirmed' && !owner.otherServer;
	const roomTabs = Boolean(shared && signedIn);
	const tabs: ModalTab<CollaborateTab>[] = [
		...(chat ? [{ id: 'chat' as const, label: 'Chat', unread: chatUnread }] : []),
		{ id: 'share', label: 'Share' },
		...(roomTabs
			? [
					{ id: 'people' as const, label: 'People', count: stats?.actors.length },
					{ id: 'safety' as const, label: 'Safety' },
				]
			: []),
	];
	const tab: CollaborateTab = tabs.some((entry) => entry.id === requestedTab)
		? requestedTab
		: tabs[0].id;
	const tabbed = tabs.length > 1;

	const newLink = (
		<div className="flex flex-col gap-2">
			<SegmentedControl
				value={role}
				onChange={setRole}
				options={ROLE_OPTIONS}
				theme={theme}
				ariaLabel="What the link allows"
				appearance="pills"
				stretch
			/>
			<HeaderActionButton
				theme={theme}
				onClick={() => void share()}
				disabled={busy}
				icon={shared ? <Link2 /> : <Share2 />}
				className="w-full justify-center py-1.5"
			>
				{shared ? 'Copy a new link' : 'Share and copy link'}
			</HeaderActionButton>
			<div className="text-center" style={dim}>
				{role === 'rw'
					? 'Anyone with it can view and edit for 7 days.'
					: 'Anyone with it can view for 30 days.'}
			</div>
		</div>
	);

	const linkRows = (
		<SketchPanelSection title="Live links" theme={theme}>
			{liveLinks.length === 0 && <div style={dim}>No live links.</div>}
			{liveLinks.map((link) => {
				const cap = findRoomStatsCap(stats, link.capId);
				const label = sketchLinkLabel(link.role, link.label);
				return (
					<div key={link.capId} className="flex flex-col gap-1 py-1" data-sketch-link={link.capId}>
						<div className="flex items-center gap-1">
							<div className="min-w-0 flex-1 flex flex-col gap-0.5">
								<span className="break-words" style={{ color: theme.colors.textMain }}>
									{label}
								</span>
								<SketchMetaLine
									theme={theme}
									items={[
										link.expiresAt !== null
											? `Expires ${formatFutureTime(link.expiresAt)}`
											: 'Never expires',
										cap && cap.online > 0 && `${cap.online} online`,
										cap && cap.guardrailTotal > 0 && `rejected ${cap.guardrailTotal}`,
									]}
								/>
							</div>
							<GhostIconButton
								ariaLabel={`Copy ${label}`}
								title="Copy this link"
								color={theme.colors.textDim}
								padding="p-1.5"
								disabled={busy}
								onClick={() => void runCopy(() => copyExistingSketchLink(sketchId, link.capId))}
							>
								<Copy className="w-3.5 h-3.5" />
							</GhostIconButton>
							<GhostIconButton
								ariaLabel={`Reset ${label}`}
								title="Replace it with a new link: guests on this one are disconnected"
								color={theme.colors.textDim}
								padding="p-1.5"
								disabled={busy}
								onClick={() =>
									void runCopy(async () => {
										const { result, copied } = await resetSketchLinkAndCopy(sketchId, link.capId);
										return { url: result.link.url, copied };
									})
								}
							>
								<RefreshCw className="w-3.5 h-3.5" />
							</GhostIconButton>
							<GhostIconButton
								ariaLabel={`Revoke ${label}`}
								title="Revoke: the link stops working and guests on it are disconnected"
								color={theme.colors.textDim}
								padding="p-1.5"
								disabled={busy}
								onClick={() =>
									void run(() => window.maestro.sketch.revokeLink(sketchId, link.capId))
								}
							>
								<Trash2 className="w-3.5 h-3.5" />
							</GhostIconButton>
						</div>
						{cap?.botSuspended && (
							<div className="flex items-center gap-2">
								<MiniBadge label="@bot suspended" theme={theme} color={theme.colors.warning} />
								<HeaderActionButton
									theme={theme}
									variant="ghost"
									disabled={busy}
									onClick={() =>
										void run(() =>
											window.maestro.sketch.roomAction(sketchId, 'unsuspend', {
												capId: link.capId,
											})
										)
									}
								>
									Unsuspend
								</HeaderActionButton>
							</div>
						)}
					</div>
				);
			})}
		</SketchPanelSection>
	);

	return (
		<aside
			ref={panelRef}
			className="relative shrink-0 flex flex-col min-h-0 select-none"
			aria-label="Collaborate on this sketch"
			data-sketch-share-panel=""
			style={{
				width,
				borderLeft: `1px solid ${theme.colors.border}`,
				backgroundColor: theme.colors.bgSidebar,
			}}
		>
			<PanelResizeHandle
				onResizeStart={onResizeStart}
				onReset={resetWidth}
				label="Resize the Collaborate panel"
			/>
			<div
				className="px-3 py-2 flex items-center justify-between text-xs font-medium"
				style={{ ...dim, borderBottom: tabbed ? undefined : `1px solid ${theme.colors.border}` }}
			>
				<span>{shared ? 'Shared on RunMaestro.ai' : 'Collaborate'}</span>
				<button
					type="button"
					aria-label="Close the Collaborate panel"
					className="p-0.5 rounded hover:bg-white/10"
					onClick={onClose}
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>
			{tabbed && (
				<ModalTabStrip
					theme={theme}
					tabs={tabs}
					activeTab={tab}
					onChange={onTabChange}
					label="Collaborate"
					idPrefix={TAB_PREFIX}
					className="px-2"
					density="compact"
				/>
			)}

			{tab === 'chat' && (
				<div className="flex-1 min-h-0 flex flex-col" {...tabPanelProps(TAB_PREFIX, tab)}>
					{chat}
				</div>
			)}

			{tab !== 'chat' && (
				<div
					className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3 text-xs"
					{...(tabbed ? tabPanelProps(TAB_PREFIX, tab) : {})}
				>
					{tab === 'share' && owner === null && <Spinner size={16} color={theme.colors.accent} />}

					{tab === 'share' && owner !== null && !signedIn && (
						<div className="flex flex-col gap-2">
							<div style={dim}>
								{owner.state === 'pending' && !owner.otherServer
									? `A confirmation email went to ${owner.email}. Open the link in it; this panel updates when it is clicked.`
									: owner.otherServer
										? `You are signed in on ${owner.serverUrl}, not the server Sketch Book uses now. Sign in again.`
										: 'Sharing goes through RunMaestro.ai. Sign in with your email first: you get a link to confirm it.'}
							</div>
							<input
								type="email"
								value={email}
								placeholder="you@example.com"
								aria-label="Email"
								className="px-2 py-1 rounded outline-none select-text"
								style={{
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
								onChange={(event) => setEmail(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === 'Enter' && email.trim() && !busy) void register();
								}}
							/>
							<HeaderActionButton
								theme={theme}
								onClick={() => void register()}
								disabled={busy || !email.trim()}
							>
								{owner.state === 'pending' ? 'Send it again' : 'Send confirmation link'}
							</HeaderActionButton>
						</div>
					)}

					{signedIn && tab === 'share' && newLink}

					{uncopied && (
						<div className="flex flex-col gap-1">
							<div style={{ color: theme.colors.warning }}>
								The clipboard refused the link. Copy it from here.
							</div>
							<textarea
								readOnly
								value={uncopied}
								rows={3}
								className="px-2 py-1 rounded resize-none select-text"
								style={{
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
								onFocus={(event) => event.currentTarget.select()}
							/>
						</div>
					)}

					{shared && tab === 'share' && linkRows}

					{tab === 'people' && (
						<SketchRoomMembers
							sketchId={sketchId}
							theme={theme}
							stats={stats}
							busy={busy}
							run={run}
						/>
					)}

					{tab === 'safety' && record && (
						<>
							<SketchBotPolicyToggle sketchId={sketchId} sketchName={record.name} theme={theme} />
							{stats?.guestEdited && (
								<div style={dim}>
									A guest has edited the board, so your @bot turns run restricted.
								</div>
							)}
							<SketchPanelSection title="Guest text" theme={theme}>
								<div className="flex items-center justify-between gap-2">
									<span style={dim}>Screened for prompt injection</span>
									<SketchScreeningBadge screening={screening} theme={theme} />
								</div>
							</SketchPanelSection>
							<SketchFlaggedElements
								sketchId={sketchId}
								theme={theme}
								stats={stats}
								busy={busy}
								run={run}
								onError={setError}
							/>
							<SketchPanelSection title="Access" theme={theme}>
								<ConfirmInPlace
									theme={theme}
									label="Reset all access"
									warning={ROTATE_WARNING}
									icon={<RotateCcw />}
									busy={busy}
									onConfirm={() => void run(() => window.maestro.sketch.rotate(sketchId))}
								/>
							</SketchPanelSection>
						</>
					)}

					{busy && <Spinner size={16} color={theme.colors.accent} />}
					{error && (
						<div className="select-text" role="alert" style={{ color: theme.colors.error }}>
							{error}
						</div>
					)}
				</div>
			)}

			{signedIn && tab !== 'chat' && (
				<div
					className="px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
					data-sketch-collaborate-footer=""
					style={{ borderTop: `1px solid ${theme.colors.border}` }}
				>
					<span
						className="min-w-0 flex-1 truncate"
						style={dim}
						title={owner?.email ? `Signed in as ${owner.email}` : undefined}
					>
						{owner?.email}
					</span>
					{shared && (
						<ConfirmInPlace
							theme={theme}
							label="Stop sharing"
							warning={UNSHARE_WARNING}
							busy={busy}
							onConfirm={() => void run(() => window.maestro.sketch.unshare(sketchId))}
						/>
					)}
				</div>
			)}
		</aside>
	);
}
