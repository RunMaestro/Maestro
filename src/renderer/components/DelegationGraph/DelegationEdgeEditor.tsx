/**
 * DelegationEdgeEditor - the popover that states one relationship.
 *
 * It opens where an edge was dropped on the Delegation Graph, or where an edge
 * already drawn was clicked, and it is the only place on the canvas where a
 * relationship is written. Nothing is stored until the user confirms: a dropped
 * edge, and a clicked one, is a question and not a change.
 *
 * It edits ONE direction. The edge from A to B is A's statement about whom A
 * may reach, so the editor writes to A alone. When the opposite edge exists it
 * says so, in words, and offers nothing automatic: two agents may hold any
 * combination of the bits across the two directions, and a manager who
 * delegates down to an employee who only consults up is two separate gestures.
 *
 * The bits and the note are named with the wording of the Peers tab
 * (`PEER_ACCESS_CONTROLS`, `PEER_NOTE_PLACEHOLDER`) and drawn with its own
 * `PermissionSquare`, because the row this editor writes is the row that tab
 * shows.
 *
 * A NEW edge with neither bit is not a relationship, so it cannot be confirmed.
 *
 * An edge that EXISTS can be taken away here, and there are two ways, which do
 * not write the same thing:
 *
 *   - The delete action. For an edge the user wrote it deletes the row. An
 *     edge a group or worktree grant derived has no row to delete, so the
 *     action is named for what it does there: it excludes the peer.
 *   - Clearing both bits and saving. That keeps a row with no access, which
 *     is the exclusion and not a delete. The editor says so before the click.
 *
 * The caller says which of them happened once it is done (a toast), because
 * the two leave different things in the agent's settings.
 *
 * `DelegationEdgeRefusal` is the same popover with one sentence in it, for a
 * drop the graph will not turn into an edge at all (an agent onto itself).
 *
 * Both register a layer above the graph, so Escape closes the popover and
 * leaves the graph open.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Trash2, UserX, X } from 'lucide-react';
import type { PeerAccess, Theme } from '../../types';
import type { DelegationGraphEdge } from '../../../shared/delegationGraph';
import {
	DEFAULT_PEER_ACCESS,
	hasAnyPeerAccess,
	PEER_ACCESS_CONTROLS,
	PEER_GRANT_LABELS,
	PEER_NOTE_PLACEHOLDER,
} from '../../../shared/peerAgents';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useContextMenuPosition } from '../../hooks/ui/useContextMenuPosition';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useFocusOnMount } from '../../hooks/utils/useFocusAfterRender';
import {
	DELEGATION_EDGE_NEEDS_ACCESS,
	type DelegationEdgeDraft,
} from '../../services/delegationGraphEdits';
import { PermissionSquare } from '../shared/AdditionalDirectoriesSection';
import { FormInput } from '../ui/FormInput';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { delegationAccessSentence, delegationEdgeKind } from './edges/DelegationEdge';

/** A point of the window, in CSS pixels from its top left corner. */
export interface DelegationEdgeEditorAnchor {
	x: number;
	y: number;
}

const POPOVER_WIDTH = 320;
const ACCESS_BITS: ReadonlyArray<keyof PeerAccess> = ['read', 'write'];

interface EdgePopoverProps {
	theme: Theme;
	anchor: DelegationEdgeEditorAnchor;
	ariaLabel: string;
	title: ReactNode;
	onClose: () => void;
	testId: string;
	children: ReactNode;
}

/**
 * The floating shell: placed at the anchor, kept inside the window, closed by
 * Escape and by its own X. A click elsewhere does NOT close it: a note typed
 * into it must not be lost to a slipped pointer on a dense canvas.
 */
function EdgePopover({
	theme,
	anchor,
	ariaLabel,
	title,
	onClose,
	testId,
	children,
}: EdgePopoverProps) {
	const { colors } = theme;
	const popoverRef = useRef<HTMLDivElement>(null);
	const { left, top, maxHeight, ready } = useContextMenuPosition(popoverRef, anchor.x, anchor.y);
	useModalLayer(MODAL_PRIORITIES.DELEGATION_GRAPH_EDGE_EDITOR, ariaLabel, onClose);

	return (
		<div
			ref={popoverRef}
			role="dialog"
			aria-label={ariaLabel}
			data-testid={testId}
			className="fixed z-[10000] rounded-lg shadow-xl border text-xs select-text"
			style={{
				left,
				top,
				width: POPOVER_WIDTH,
				maxHeight,
				overflowY: 'auto',
				opacity: ready ? 1 : 0,
				backgroundColor: colors.bgSidebar,
				borderColor: colors.border,
				color: colors.textMain,
			}}
		>
			<div
				className="flex items-center justify-between gap-2 px-3 py-2 border-b"
				style={{ borderColor: colors.border }}
			>
				<span className="flex items-center gap-1.5 min-w-0 font-medium">{title}</span>
				<button
					type="button"
					onClick={onClose}
					className="p-0.5 rounded hover:bg-white/10 shrink-0"
					style={{ color: colors.textDim }}
					title="Close"
					aria-label="Close"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>
			<div className="px-3 py-2 space-y-2">{children}</div>
		</div>
	);
}

export interface DelegationEdgeEditorProps {
	theme: Theme;
	/** Where the edge was dropped, or where it was clicked. */
	anchor: DelegationEdgeEditorAnchor;
	/** The agent the edge starts from: the one whose Peers the edit is written to. */
	sourceName: string;
	targetName: string;
	/** The edge already drawn in this direction. The editor then changes it. */
	existing?: DelegationGraphEdge;
	/** The edge in the opposite direction, which this editor never touches. */
	reverse?: DelegationGraphEdge;
	/**
	 * Write the edge. Returns why it was refused, or `null` once it is written.
	 * The caller closes the editor on `null`. A draft with NEITHER bit is handed
	 * over only for an edge that exists: it asks for the exclusion row.
	 */
	onConfirm: (draft: DelegationEdgeDraft) => string | null;
	/**
	 * Take the edge away. Offered only beside `existing`. Returns why it was
	 * refused, or `null` once it is done, as `onConfirm` does.
	 */
	onDelete?: () => string | null;
	onClose: () => void;
}

export function DelegationEdgeEditor({
	theme,
	anchor,
	sourceName,
	targetName,
	existing,
	reverse,
	onConfirm,
	onDelete,
	onClose,
}: DelegationEdgeEditorProps) {
	const { colors } = theme;
	const [access, setAccess] = useState<PeerAccess>(() =>
		existing ? { read: existing.read, write: existing.write } : { ...DEFAULT_PEER_ACCESS }
	);
	const [description, setDescription] = useState(existing?.description ?? '');
	const [error, setError] = useState<string | null>(null);

	const noteRef = useRef<HTMLInputElement>(null);
	useFocusOnMount(noteRef);

	const hasAccess = hasAnyPeerAccess(access);
	// A new edge needs a bit. An edge that exists may be saved with neither:
	// that is the exclusion, and the line under the squares says so.
	const canConfirm = hasAccess || existing !== undefined;
	const confirm = useCallback(() => {
		if (!canConfirm) return;
		setError(onConfirm({ ...access, description }));
	}, [canConfirm, access, description, onConfirm]);
	const remove = useCallback(() => {
		if (onDelete) setError(onDelete());
	}, [onDelete]);

	// An edge a grant derived has no row behind it, so its delete action
	// excludes the peer, and is named for that.
	const isDerived = existing !== undefined && existing.source !== 'explicit';
	const existingKind = existing ? delegationEdgeKind(existing) : null;
	const reverseKind = reverse ? delegationEdgeKind(reverse) : null;

	return (
		<EdgePopover
			theme={theme}
			anchor={anchor}
			ariaLabel={`Edge from ${sourceName} to ${targetName}`}
			title={
				<>
					<span className="truncate">{sourceName}</span>
					<ArrowRight className="w-3.5 h-3.5 shrink-0" style={{ color: colors.textDim }} />
					<span className="truncate">{targetName}</span>
				</>
			}
			onClose={onClose}
			testId="delegation-edge-editor"
		>
			{existing && existingKind && (
				<p data-testid="delegation-edge-editor-existing" style={{ color: colors.textDim }}>
					{existing.source === 'explicit'
						? `This edge exists: ${delegationAccessSentence(existingKind, sourceName, targetName)}. Saving changes it.`
						: `${delegationAccessSentence(existingKind, sourceName, targetName)} through the "${PEER_GRANT_LABELS[existing.source]}" grant of ${sourceName}. Saving writes a row for ${targetName} in the Peers of ${sourceName}, and that row overrides the grant for this one agent.`}
				</p>
			)}

			{ACCESS_BITS.map((bit) => {
				const control = PEER_ACCESS_CONTROLS[bit];
				return (
					<div key={bit} className="flex gap-2">
						<PermissionSquare
							theme={theme}
							label={control.square}
							title={control.title}
							active={access[bit]}
							onToggle={() => setAccess((current) => ({ ...current, [bit]: !current[bit] }))}
						/>
						<span className="min-w-0">
							<span className="block font-medium">{control.word}</span>
							<span className="block" style={{ color: colors.textDim }}>
								{control.effect}
							</span>
						</span>
					</div>
				);
			})}

			<FormInput
				ref={noteRef}
				theme={theme}
				value={description}
				onChange={setDescription}
				onSubmit={confirm}
				submitEnabled={canConfirm}
				placeholder={PEER_NOTE_PLACEHOLDER}
				heightClass="p-2"
			/>

			{!hasAccess &&
				(existing ? (
					<p data-testid="delegation-edge-editor-excludes" style={{ color: colors.warning }}>
						With neither, {targetName} is excluded. Saving keeps a row with no access for{' '}
						{targetName} in the Peers of {sourceName}, and that row overrides every group and
						worktree grant. It is not a delete.
						{!isDerived && onDelete && ' To remove the row, use Delete edge.'}
					</p>
				) : (
					<p data-testid="delegation-edge-editor-needs-access" style={{ color: colors.warning }}>
						{DELEGATION_EDGE_NEEDS_ACCESS} An edge with neither is not a relationship.
					</p>
				))}

			{reverse && reverseKind && (
				<p data-testid="delegation-edge-editor-reverse" style={{ color: colors.textDim }}>
					{delegationAccessSentence(reverseKind, targetName, sourceName, { already: true })}. This
					edge is the other half of that pair, and nothing is changed for {targetName}.
				</p>
			)}

			{error && (
				<p data-testid="delegation-edge-editor-error" role="alert" style={{ color: colors.error }}>
					{error}
				</p>
			)}

			<div className="flex flex-wrap items-center justify-end gap-2 pt-1">
				{existing && onDelete && (
					<HeaderActionButton
						theme={theme}
						variant="ghost"
						onClick={remove}
						icon={
							isDerived ? (
								<UserX style={{ color: colors.error }} />
							) : (
								<Trash2 style={{ color: colors.error }} />
							)
						}
						title={
							existing.source === 'explicit'
								? `Removes the row for ${targetName} from the Peers of ${sourceName}. A group or worktree grant that covers ${targetName} then applies again`
								: `The "${PEER_GRANT_LABELS[existing.source]}" grant of ${sourceName} made this edge, so there is no row to delete. This writes a row with no access for ${targetName}, which excludes it from the grant`
						}
						className="mr-auto"
						testId="delegation-edge-editor-delete"
					>
						{isDerived ? 'Exclude peer' : 'Delete edge'}
					</HeaderActionButton>
				)}
				<HeaderActionButton
					theme={theme}
					variant="ghost"
					onClick={onClose}
					testId="delegation-edge-editor-cancel"
				>
					Cancel
				</HeaderActionButton>
				<HeaderActionButton
					theme={theme}
					onClick={confirm}
					disabled={!canConfirm}
					title={`Written to the Peers of ${sourceName}. Nothing is written to ${targetName}`}
					testId="delegation-edge-editor-confirm"
				>
					{!existing ? 'Add edge' : hasAccess ? 'Save edge' : 'Save as excluded'}
				</HeaderActionButton>
			</div>
		</EdgePopover>
	);
}

export interface DelegationEdgeRefusalProps {
	theme: Theme;
	/** Where the edge was dropped. */
	anchor: DelegationEdgeEditorAnchor;
	/** Why the drop made no edge. */
	message: string;
	onClose: () => void;
}

/** A drop the graph will not turn into an edge, said where it was dropped. */
export function DelegationEdgeRefusal({
	theme,
	anchor,
	message,
	onClose,
}: DelegationEdgeRefusalProps) {
	return (
		<EdgePopover
			theme={theme}
			anchor={anchor}
			ariaLabel="No edge was drawn"
			title="No edge was drawn"
			onClose={onClose}
			testId="delegation-edge-refusal"
		>
			<p role="alert" style={{ color: theme.colors.warning }}>
				{message}
			</p>
		</EdgePopover>
	);
}
