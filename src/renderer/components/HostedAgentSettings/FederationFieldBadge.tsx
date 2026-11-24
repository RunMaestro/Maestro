/**
 * FederationFieldBadge - on a hosted agent's settings, where each field's value lives.
 *
 * A hosted agent's settings belong to its host (`lift-settings-sync.ts`). When Edit Agent shows
 * one (its lifted pointer), every field carries a badge read from the Federation tables, never
 * from a list in a component:
 *
 * - `shared`: "From host". The value is the host's; a change goes to every conductor.
 * - `personal`: "Yours only". Never sent to the host.
 * - `machine`: "This machine". Never sent.
 * - not synced yet (`HOSTED_SETTINGS_NOT_YET_SYNCED`): "Not synced yet", the reason as tooltip.
 *
 * A shared field with an edit the host has not taken adds "Pending" with the host's name; one in
 * conflict adds "Conflict", which opens the Federation Settings Conflicts modal.
 *
 * The badges read a context the editor provides only for a hosted agent. An ordinary local agent
 * has no context, so every badge renders nothing and the form is unchanged: a feature not in use
 * leaves no trace. `maestro-cli show agent --json` reports the same facts (`federation` block).
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Session, Theme } from '../../types';
import { MiniBadge } from '../ui/MiniBadge';
import { useHostedAgentSettingsStore } from '../../stores/hostedAgentSettingsStore';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useSessionStore } from '../../stores/sessionStore';
import {
	hostedFieldState,
	liftPeerIdMapFor,
	type HostedFieldState,
} from '../../services/liftedAgentSettingsSync';
import {
	describeFederationField,
	FEDERATION_SCOPE_LABELS,
	hostPeerId,
	type FederationFieldId,
	type FederationFieldScope,
	type LiftPeerIdMap,
} from '../../../shared/maestro-lib/agents/lift-settings-sync';
import { readLiftedTo } from '../../../shared/maestro-lib/agents/lift-pointer';
import type { AgentRecord, GroupRecord } from '../../../shared/maestro-lib/store/records';

/** The hosted agent an editor shows, and how this machine holds it. */
export interface FederationFieldsTarget {
	peerId: string;
	agentId: string;
	/** `pointer`: a lifted local agent (local ids). `mirror`: the host's record (host ids). */
	mode: 'pointer' | 'mirror';
}

export interface FederationFieldsValue extends FederationFieldsTarget {
	theme: Theme;
	/** The peer's display name, for "Pending on <host>". */
	hostName: string;
	state: HostedFieldState;
	peerIds: LiftPeerIdMap;
	hostAgents: readonly AgentRecord[];
	hostGroups: readonly GroupRecord[];
}

const FederationFieldsContext = createContext<FederationFieldsValue | null>(null);

/** The badges' facts for one hosted agent, kept live from the stores the settings sync writes. */
export function useFederationFieldsValue(
	target: FederationFieldsTarget | null,
	theme: Theme
): FederationFieldsValue | null {
	const peerId = target?.peerId;
	const agentId = target?.agentId;
	const mode = target?.mode;
	const pending = useHostedAgentSettingsStore((s) => s.pending);
	const conflicts = useHostedAgentSettingsStore((s) => s.conflicts);
	const resolutions = useHostedAgentSettingsStore((s) => s.resolutions);
	const sessions = useSessionStore((s) => s.sessions);
	const peer = usePeerMirrorStore((s) => (peerId ? s.peers[peerId] : undefined));
	return useMemo(() => {
		if (!peerId || !agentId || !mode) return null;
		// `pending`, `conflicts`, `resolutions` and `sessions` are what the reads below depend on.
		void pending;
		void conflicts;
		void resolutions;
		void sessions;
		return {
			peerId,
			agentId,
			mode,
			theme,
			hostName: peer?.name ?? peerId,
			state: hostedFieldState(peerId, agentId),
			peerIds: liftPeerIdMapFor(peerId),
			hostAgents: peer?.agents ?? [],
			hostGroups: peer?.groups ?? [],
		};
	}, [peerId, agentId, mode, theme, peer, pending, conflicts, resolutions, sessions]);
}

/** The target for an agent Edit Agent opened on: its host agent when the agent was lifted. */
export function federationTargetOfSession(
	session: Pick<Session, 'liftedTo'> | null | undefined
): FederationFieldsTarget | null {
	const pointer = readLiftedTo(session?.liftedTo);
	return pointer ? { peerId: pointer.peer, agentId: pointer.agentId, mode: 'pointer' } : null;
}

export function FederationFieldsProvider({
	value,
	children,
}: {
	value: FederationFieldsValue | null;
	children: ReactNode;
}) {
	return (
		<FederationFieldsContext.Provider value={value}>{children}</FederationFieldsContext.Provider>
	);
}

/** The hosted agent the surrounding editor shows, or null for an ordinary local agent. */
export function useFederationFields(): FederationFieldsValue | null {
	return useContext(FederationFieldsContext);
}

function scopeColor(theme: Theme, scope: FederationFieldScope): string {
	if (scope === 'shared') return theme.colors.accent;
	if (scope === 'not-synced') return theme.colors.warning;
	return theme.colors.textDim;
}

export interface FederationFieldBadgeProps {
	/** One field, or the fields one control writes (its scope is the first one's). */
	field: FederationFieldId | readonly FederationFieldId[];
	className?: string;
}

/** The badges of one field: its scope, then Pending or Conflict. Nothing for a local agent. */
export function FederationFieldBadge({ field, className = '' }: FederationFieldBadgeProps) {
	const ctx = useFederationFields();
	if (!ctx) return null;
	const fields = typeof field === 'string' ? [field] : field;
	if (fields.length === 0) return null;
	const statuses = fields.map((id) => describeFederationField(id, ctx.state));
	const { scope, why } = statuses[0];
	const pending = statuses.some((status) => status.pending);
	const conflict = statuses.some((status) => status.conflict);
	const { theme } = ctx;
	return (
		<span
			className={`inline-flex items-center gap-1 align-middle normal-case ${className}`}
			data-testid={`federation-badge-${fields[0]}`}
		>
			<MiniBadge
				theme={theme}
				label={FEDERATION_SCOPE_LABELS[scope]}
				color={scopeColor(theme, scope)}
				title={why}
				testId={`federation-scope-${fields[0]}`}
			/>
			{conflict ? (
				<button
					type="button"
					className="inline-flex"
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						useHostedAgentSettingsStore.getState().setConflictsOpen(true);
					}}
					title={`Changed here and on ${ctx.hostName}. Click to choose which to keep.`}
					aria-label={`Resolve the conflict with ${ctx.hostName}`}
					data-testid={`federation-conflict-${fields[0]}`}
				>
					<MiniBadge theme={theme} label="Conflict" color={theme.colors.error} />
				</button>
			) : (
				pending && (
					<MiniBadge
						theme={theme}
						label={`Pending on ${ctx.hostName}`}
						color={theme.colors.warning}
						title={`Saved here; sent to ${ctx.hostName} when it takes the change.`}
						testId={`federation-pending-${fields[0]}`}
					/>
				)
			)}
		</span>
	);
}

/**
 * A field the editor draws as a slot: its badges on a line above it. Renders only the field for
 * a local agent.
 */
export function FederatedSetting({
	field,
	children,
}: {
	field: FederationFieldId | readonly FederationFieldId[];
	children: ReactNode;
}) {
	const ctx = useFederationFields();
	if (!ctx) return <>{children}</>;
	return (
		<div>
			<div className="flex justify-end mb-1">
				<FederationFieldBadge field={field} />
			</div>
			{children}
		</div>
	);
}

/**
 * Why the host cannot honor one explicit peer row of the editor's agent, or undefined when it can
 * (or the agent is not hosted). A row names a local agent on a pointer and a host agent on a
 * mirror; either way the host must hold the agent.
 */
export function unhonoredPeerRowNotice(
	ctx: FederationFieldsValue | null,
	sessionId: string
): string | undefined {
	if (!ctx || !sessionId) return undefined;
	if (hostPeerId(sessionId, ctx.peerIds)) return undefined;
	return `Not honored by ${ctx.hostName}: this agent is not on the host, so the host's turns cannot reach it. The row stays on this machine.`;
}
