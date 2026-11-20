/**
 * FederationBadge - the Left Bar's mark of HOW an agent on another machine runs, with a hover
 * card that explains the difference.
 *
 * - `ssh`: an SSH agent. This Maestro starts each turn over SSH, so the work stops when this
 *   machine sleeps or loses the connection.
 * - `hosted`: an agent owned by the Maestro host on the remote (a local row that points at it).
 *   Turns, the queue, Auto Run, and Cue keep running there while this machine is off. The badge
 *   also carries the host's connection: accent while connected, warning while (re)connecting, error
 *   while the host is out of reach (the hover card says why).
 *
 * Users see "Hosted", not "Federated": the word names what they get (the agent keeps working while
 * this machine sleeps), where "federation" names the mechanism. Federation is opportunistic, so the
 * card on an SSH agent also says what the next step is (Move to Host, which sets a host up first
 * when the remote has none). A local agent gets no badge.
 *
 * An SSH agent whose remote is down (the main process confirmed it with a probe) keeps the same
 * chip in the same place, in the error color with the label struck through. That is the whole
 * signal: the chip never opens a dialog or raises a toast, so a fleet with many remotes down stays
 * quiet until the user goes to one of those agents.
 */

import { memo } from 'react';
import type { Theme } from '../../types';
import { HoverTooltip } from '../ui/HoverTooltip';
import { MiniBadge } from '../ui/MiniBadge';
import type { AutoFederationAgentState } from '../../../shared/federationAuto';
import type { PeerMirrorConnection } from '../../../shared/maestro-lib/client/peer-mirror';
import { formatTimestamp } from '../../../shared/formatters';

/** An SSH agent's remote that the reachability probe says is down (`SshReachabilityEvent`). */
export interface FederationBadgeUnreachable {
	remoteName: string;
	/** Epoch ms the remote went down. */
	since: number;
	/** Why, from `describeSshUnreachable()`. */
	message?: string;
}

/** What automatic Federation says about an SSH agent (`AutoFederationAgentStatus`). */
export interface FederationBadgeAuto {
	state: AutoFederationAgentState;
	reason?: string;
	fix?: string;
}

export type FederationBadgeMode =
	| {
			kind: 'ssh';
			remoteName?: string;
			hostReady: boolean;
			canFederate: boolean;
			auto?: FederationBadgeAuto;
			unreachable?: FederationBadgeUnreachable;
	  }
	| {
			kind: 'hosted';
			peerName: string;
			/** The host's connection. Absent: the mirror has not loaded this peer yet. */
			connection?: PeerMirrorConnection;
			/** Why the host is out of reach, when it is. */
			error?: string;
	  };

/** How a hosted agent's host connection reads on its badge. */
export type HostedConnectionTone = 'live' | 'pending' | 'down';

export function hostedConnectionTone(connection?: PeerMirrorConnection): HostedConnectionTone {
	if (connection === 'connected') return 'live';
	if (connection === undefined || connection === 'connecting' || connection === 'reconnecting') {
		return 'pending';
	}
	return 'down';
}

/** The hover card's lines, exported so tests and docs read the same words. */
export function federationBadgeCopy(mode: FederationBadgeMode): {
	label: string;
	title: string;
	lines: string[];
	/** Automatic Federation could not move the agent: the reason and what to do. */
	blocked?: { reason?: string; fix?: string };
	/** The remote is down: the line the card shows in the error color. */
	unreachable?: string;
} {
	if (mode.kind === 'hosted') {
		const tone = hostedConnectionTone(mode.connection);
		const status =
			tone === 'live'
				? []
				: tone === 'pending'
					? [`Connecting to ${mode.peerName}.`]
					: [
							`Not connected to ${mode.peerName}. Showing the last known state. Right-click > Reconnect.`,
							...(mode.error ? [mode.error] : []),
						];
		return {
			label: 'Hosted',
			title: `Hosted on ${mode.peerName}`,
			lines: [
				'Keeps running while this machine sleeps or is off.',
				`The Maestro host on ${mode.peerName} owns this agent and runs its turns, queue, Auto Run, and Cue. This window is a live view of it.`,
				...status,
			],
		};
	}
	const where = mode.remoteName ? ` on ${mode.remoteName}` : '';
	const auto = mode.auto;
	const manualNext = !mode.canFederate
		? 'Federation does not reach this remote right now: it is disabled, Federation is off for it, or Maestro has not checked it yet.'
		: mode.hostReady
			? 'This remote runs a Maestro host: right-click > Move to Host to run this agent there.'
			: 'Right-click > Move to Host: Maestro sets up a host on the remote, then runs this agent there.';
	const next =
		auto?.state === 'pending' || auto?.state === 'waiting'
			? `Maestro moves it onto the remote's host automatically. ${auto.reason ?? ''}`.trim()
			: auto?.state === 'blocked'
				? 'Maestro could not move it onto the host automatically:'
				: manualNext;
	return {
		label: 'SSH',
		title: `SSH agent${where}`,
		lines: [
			'Stops when this machine sleeps or disconnects: this Maestro starts every turn over SSH.',
			"A hosted agent runs on the remote's own Maestro host instead and keeps working with this machine off.",
			next,
		],
		...(auto?.state === 'blocked' ? { blocked: { reason: auto.reason, fix: auto.fix } } : {}),
		...(mode.unreachable ? { unreachable: unreachableLine(mode.unreachable) } : {}),
	};
}

function unreachableLine({ remoteName, since, message }: FederationBadgeUnreachable): string {
	const line = `Can't reach "${remoteName}" over SSH since ${formatTimestamp(since)}.`;
	const reason = message?.trim();
	return reason ? `${line} ${reason}` : line;
}

export const FederationBadge = memo(function FederationBadge({
	theme,
	mode,
}: {
	theme: Theme;
	mode: FederationBadgeMode;
}) {
	const copy = federationBadgeCopy(mode);
	const tone = mode.kind === 'hosted' ? hostedConnectionTone(mode.connection) : undefined;
	const color =
		tone !== undefined
			? tone === 'live'
				? theme.colors.accent
				: tone === 'pending'
					? theme.colors.warning
					: theme.colors.error
			: copy.blocked || copy.unreachable
				? theme.colors.error
				: theme.colors.warning;
	return (
		<HoverTooltip
			theme={theme}
			maxWidth={300}
			label={
				<span className="block text-left" data-testid="federation-badge-card">
					<span className="block font-semibold mb-1">{copy.title}</span>
					{copy.unreachable && (
						<span
							className="block mb-1"
							style={{ color: theme.colors.error }}
							data-testid="federation-badge-unreachable"
						>
							{copy.unreachable}
						</span>
					)}
					{copy.lines.map((line) => (
						<span key={line} className="block mt-0.5">
							{line}
						</span>
					))}
					{copy.blocked?.reason && (
						<span className="block mt-1" style={{ color: theme.colors.error }}>
							{copy.blocked.reason}
						</span>
					)}
					{copy.blocked?.fix && (
						<span className="block mt-1 font-semibold" data-testid="federation-badge-fix">
							To fix: {copy.blocked.fix}
						</span>
					)}
				</span>
			}
		>
			<MiniBadge
				label={copy.label}
				theme={theme}
				color={color}
				style={copy.unreachable ? { textDecoration: 'line-through' } : undefined}
				testId={`federation-badge-${mode.kind}`}
			/>
		</HoverTooltip>
	);
});
