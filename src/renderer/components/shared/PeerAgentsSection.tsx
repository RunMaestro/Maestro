/**
 * PeerAgentsSection - manage the other agents an agent may reach on its own,
 * without the user typing an `@mention`.
 *
 * Shared by the create (NewInstanceModal), edit (EditAgentModal), and Wizard
 * surfaces so all three produce the same three session fields: `peerAgents`,
 * `groupPeerAccess` and `worktreePeerAccess`. It reads no store: the fleet and
 * the id of the agent being edited come in as props, so a surface that edits a
 * seed and not a live agent (Group Settings) can mount it too.
 *
 * R and W are two different mechanisms here, not two strengths of one:
 *
 *   - R = may CONSULT the peer: ask a question and get the answer back
 *     (`maestro-cli ask`). The peer's open tab is never touched.
 *   - W = may DELEGATE to the peer: the work lands in the peer's live tab
 *     (`maestro-cli dispatch ... --notify-on-complete <me>`).
 *
 * There are three sources, drawn broadest first:
 *
 *   1. The group grant: every other agent in this agent's own group.
 *   2. The worktree grant: the worktree parent, the sibling worktrees and this
 *      agent's own worktree children.
 *   3. Explicit rows: one named agent each.
 *
 * An explicit row OVERRIDES what the two grants gave that agent. It does not
 * add to them. So, unlike an Additional Directory, a row with NEITHER square
 * lit is not inert: it is an exclusion, and it removes that agent from a group
 * or worktree grant that would otherwise cover it. Nothing here may drop such a
 * row. A grant is different: a checked box with neither square lit grants
 * nothing, and the row says so.
 *
 * A grant that is off is ABSENT (`undefined`), never `{ read: false, write:
 * false }`. Absent is what the data model uses for "off".
 *
 * The precedence itself lives in `resolvePeerRoster` (`src/shared/peerAgents.ts`).
 * This component only edits the three stored sources.
 */

import React, { useCallback, useMemo } from 'react';
import { GitBranch, Plus, Trash2, Users } from 'lucide-react';

import {
	DEFAULT_PEER_ACCESS,
	hasAnyPeerAccess,
	PEER_ACCESS_CONTROLS,
	PEER_GRANT_LABELS,
	PEER_NOTE_PLACEHOLDER,
} from '../../../shared/peerAgents';
import { FormFieldLabel } from '../ui/FormFieldLabel';
import { FormInput } from '../ui/FormInput';
import { GhostIconButton } from '../ui/GhostIconButton';
import { PermissionSquare } from './AdditionalDirectoriesSection';
import { ThemedSelect, type ThemedSelectOption } from './ThemedSelect';
import type { PeerAccess, PeerAgent, Theme } from '../../types';

/** What the section needs to know about one agent of the fleet. */
export interface PeerAgentOption {
	id: string;
	name: string;
	groupId?: string;
}

export interface PeerAgentsSectionProps {
	theme: Theme;
	/** Explicit rows. */
	peers: PeerAgent[];
	onChange: (peers: PeerAgent[]) => void;
	/** Absent = checkbox off. */
	groupAccess?: PeerAccess;
	onGroupAccessChange: (access: PeerAccess | undefined) => void;
	worktreeAccess?: PeerAccess;
	onWorktreeAccessChange: (access: PeerAccess | undefined) => void;
	/** Live fleet for the picker and for the "N agents in this group" hint. */
	availableAgents: PeerAgentOption[];
	/** The agent being edited; excluded from the picker. Absent on create. */
	selfSessionId?: string;
	/** Drives whether the group checkbox is enabled and what its hint says. */
	groupId?: string;
	groupName?: string;
}

const NO_ACCESS: PeerAccess = { read: false, write: false };

interface PeerGrantRowProps {
	theme: Theme;
	icon: React.ReactNode;
	label: string;
	/** What the grant covers, under the label. */
	hint: string;
	/** Absent = checkbox off. */
	access?: PeerAccess;
	onChange: (access: PeerAccess | undefined) => void;
	consultTitle: string;
	delegateTitle: string;
	disabled?: boolean;
}

/**
 * One derived grant: a checkbox with its own R and W squares. The squares stay
 * on screen while the box is off, and a click on one turns the grant on with
 * that access, so a grant is one click and not two.
 */
function PeerGrantRow({
	theme,
	icon,
	label,
	hint,
	access,
	onChange,
	consultTitle,
	delegateTitle,
	disabled = false,
}: PeerGrantRowProps): React.ReactElement {
	const checked = access !== undefined;
	const current = access ?? NO_ACCESS;

	return (
		// A disabled fieldset disables the checkbox and both squares natively, so
		// PermissionSquare needs no `disabled` prop of its own.
		<fieldset disabled={disabled} className={`min-w-0${disabled ? ' opacity-50' : ''}`}>
			<div className="flex gap-2">
				<label
					className={`flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5 rounded transition-colors ${
						disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-white/5'
					}`}
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<input
						type="checkbox"
						checked={checked}
						onChange={(e) => onChange(e.target.checked ? { ...DEFAULT_PEER_ACCESS } : undefined)}
						className="accent-current"
						style={{ accentColor: theme.colors.accent }}
					/>
					<span className="flex-shrink-0" style={{ color: theme.colors.textDim }}>
						{icon}
					</span>
					<span className="flex min-w-0 flex-col">
						<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
							{label}
						</span>
						<span className="text-2xs" style={{ color: theme.colors.textDim }}>
							{hint}
						</span>
					</span>
				</label>
				<PermissionSquare
					theme={theme}
					label="R"
					title={consultTitle}
					active={current.read}
					onToggle={() => onChange({ ...current, read: !current.read })}
				/>
				<PermissionSquare
					theme={theme}
					label="W"
					title={delegateTitle}
					active={current.write}
					onToggle={() => onChange({ ...current, write: !current.write })}
				/>
				{/* As wide as the delete button of an explicit row, so the R and W
				    columns of the grants and the rows line up. */}
				<span className="w-8 shrink-0" aria-hidden="true" />
			</div>
			{checked && !hasAnyPeerAccess(current) && (
				<p className="mt-1 text-xs" style={{ color: theme.colors.warning }}>
					No access selected - this grants nothing. Light R, W or both.
				</p>
			)}
		</fieldset>
	);
}

/** "5 other agents in Backend", for the group checkbox. */
function groupCountHint(count: number, groupName: string | undefined): string {
	const where = groupName?.trim() ? `in ${groupName.trim()}` : 'in this group';
	if (count === 0) return `No other agents ${where} yet. Agents that join it are covered.`;
	return `${count} other ${count === 1 ? 'agent' : 'agents'} ${where}`;
}

export function PeerAgentsSection({
	theme,
	peers,
	onChange,
	groupAccess,
	onGroupAccessChange,
	worktreeAccess,
	onWorktreeAccessChange,
	availableAgents,
	selfSessionId,
	groupId,
	groupName,
}: PeerAgentsSectionProps): React.ReactElement {
	const updateAt = useCallback(
		(index: number, patch: Partial<PeerAgent>) => {
			onChange(peers.map((peer, i) => (i === index ? { ...peer, ...patch } : peer)));
		},
		[peers, onChange]
	);

	const removeAt = useCallback(
		(index: number) => {
			onChange(peers.filter((_, i) => i !== index));
		},
		[peers, onChange]
	);

	const addPeer = useCallback(() => {
		onChange([...peers, { sessionId: '', ...DEFAULT_PEER_ACCESS, description: '' }]);
	}, [peers, onChange]);

	// Everyone but the agent itself, by name. Consulting yourself is meaningless,
	// and the resolver drops a self row anyway.
	const pickable = useMemo(
		() =>
			availableAgents
				.filter((agent) => agent.id !== selfSessionId)
				.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
		[availableAgents, selfSessionId]
	);

	const pickableIds = useMemo(() => new Set(pickable.map((agent) => agent.id)), [pickable]);
	const claimedIds = useMemo(
		() => new Set(peers.map((peer) => peer.sessionId).filter(Boolean)),
		[peers]
	);
	const hasUnclaimedAgent = pickable.some((agent) => !claimedIds.has(agent.id));

	// One agent, one row: two rows for one agent collapse to the last on save
	// (`normalizePeerAgents`), so a row's picker leaves out the agents the other
	// rows hold. A row keeps its own value even when that agent is gone, so the
	// trigger never shows a bare session id.
	const optionsFor = useCallback(
		(sessionId: string): ThemedSelectOption[] => [
			{ value: '', label: 'Select an agent...' },
			...(sessionId && !pickableIds.has(sessionId)
				? [{ value: sessionId, label: 'Agent no longer exists' }]
				: []),
			...pickable
				.filter((agent) => agent.id === sessionId || !claimedIds.has(agent.id))
				.map((agent) => ({ value: agent.id, label: agent.name })),
		],
		[pickable, pickableIds, claimedIds]
	);

	const groupMemberCount = groupId
		? pickable.filter((agent) => agent.groupId === groupId).length
		: 0;
	// A grant left on an agent that has since left its group stays editable, so
	// the user can still switch it off.
	const groupDisabled = !groupId && groupAccess === undefined;
	const groupHint = groupId
		? groupCountHint(groupMemberCount, groupName)
		: groupAccess
			? 'This agent is not in a group, so this grants nothing until it joins one.'
			: 'This agent is not in a group. Put it in one to use this.';

	return (
		<div>
			<FormFieldLabel theme={theme}>Peer Agents</FormFieldLabel>
			<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
				Agents this one may reach on its own, without an @mention.{' '}
				<span className="font-bold">R</span> lets it consult a peer: it asks a question and gets the
				answer back, and the peer's open tab is not touched. <span className="font-bold">W</span>{' '}
				lets it delegate: the work lands in the peer's live tab. A row for a named agent overrides
				the group and worktree grants, so a row with neither square lit excludes that agent.
			</p>

			<div className="space-y-2">
				<PeerGrantRow
					theme={theme}
					icon={<Users className="w-3 h-3" />}
					label={PEER_GRANT_LABELS.group}
					hint={groupHint}
					access={groupAccess}
					onChange={onGroupAccessChange}
					consultTitle="Consult peers in my group"
					delegateTitle="Delegate to peers in my group"
					disabled={groupDisabled}
				/>
				<PeerGrantRow
					theme={theme}
					icon={<GitBranch className="w-3 h-3" />}
					label={PEER_GRANT_LABELS.worktree}
					hint="The worktree parent, the sibling worktrees and this agent's own worktree children."
					access={worktreeAccess}
					onChange={onWorktreeAccessChange}
					consultTitle="Consult the worktree family"
					delegateTitle="Delegate to the worktree family"
				/>

				{peers.map((peer, index) => {
					const missing = !!peer.sessionId && !pickableIds.has(peer.sessionId);
					const excluded = !!peer.sessionId && !missing && !hasAnyPeerAccess(peer);
					return (
						<div key={index}>
							<div className="flex gap-2">
								<ThemedSelect
									theme={theme}
									value={peer.sessionId}
									options={optionsFor(peer.sessionId)}
									onChange={(sessionId) => updateAt(index, { sessionId })}
									aria-label="Peer agent"
									style={{ flex: 1, minWidth: 0 }}
									className="h-full"
									filterable
									filterPlaceholder="Filter agents..."
								/>
								<PermissionSquare
									theme={theme}
									label={PEER_ACCESS_CONTROLS.read.square}
									title={PEER_ACCESS_CONTROLS.read.title}
									active={peer.read}
									onToggle={() => updateAt(index, { read: !peer.read })}
								/>
								<PermissionSquare
									theme={theme}
									label={PEER_ACCESS_CONTROLS.write.square}
									title={PEER_ACCESS_CONTROLS.write.title}
									active={peer.write}
									onToggle={() => updateAt(index, { write: !peer.write })}
								/>
								<GhostIconButton
									onClick={() => removeAt(index)}
									padding="p-2"
									color={theme.colors.textDim}
									title="Remove peer"
									ariaLabel="Remove peer"
								>
									<Trash2 className="w-4 h-4" />
								</GhostIconButton>
							</div>
							<div className="mt-1">
								<FormInput
									theme={theme}
									value={peer.description ?? ''}
									onChange={(value) => updateAt(index, { description: value })}
									placeholder={PEER_NOTE_PLACEHOLDER}
									heightClass="p-2"
								/>
							</div>
							{missing && (
								<p className="mt-1 text-xs" style={{ color: theme.colors.warning }}>
									This agent no longer exists - the row grants nothing. Remove it or pick another
									agent.
								</p>
							)}
							{excluded && (
								<p className="mt-1 text-xs" style={{ color: theme.colors.warning }}>
									No access selected - this row excludes the agent, even when a group or worktree
									grant covers it.
								</p>
							)}
						</div>
					);
				})}
			</div>

			<button
				type="button"
				onClick={addPeer}
				disabled={!hasUnclaimedAgent}
				title={
					hasUnclaimedAgent
						? undefined
						: pickable.length === 0
							? 'There are no other agents yet'
							: 'Every other agent already has a row'
				}
				className="mt-2 flex items-center gap-1.5 text-xs px-2 py-1.5 rounded border transition-colors hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
			>
				<Plus className="w-3.5 h-3.5" />
				Add Peer
			</button>
		</div>
	);
}
