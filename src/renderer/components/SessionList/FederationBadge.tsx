/**
 * FederationBadge - the Left Bar's mark of HOW an agent on another machine runs, with a hover
 * card that explains the difference.
 *
 * - `ssh`: an SSH agent. This Maestro starts each turn over SSH, so the work stops when this
 *   machine sleeps or loses the connection.
 * - `hosted`: an agent owned by the Maestro host on the remote (a mirrored peer row). Turns, the
 *   queue, Auto Run, and Cue keep running there while this machine is off.
 *
 * Users see "Hosted", not "Federated": the word names what they get (the agent keeps working while
 * this machine sleeps), where "federation" names the mechanism. Federation is opportunistic, so the
 * card on an SSH agent also says what the next step is (Move to Host, which sets a host up first
 * when the remote has none). A local agent gets no badge, and an agent that moved already shows
 * `LiftedPointerChip` instead.
 */

import { memo } from 'react';
import type { Theme } from '../../types';
import { HoverTooltip } from '../ui/HoverTooltip';
import { MiniBadge } from '../ui/MiniBadge';
import type { AutoFederationAgentState } from '../../../shared/federationAuto';

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
	  }
	| { kind: 'hosted'; peerName: string };

/** The hover card's lines, exported so tests and docs read the same words. */
export function federationBadgeCopy(mode: FederationBadgeMode): {
	label: string;
	title: string;
	lines: string[];
	/** Automatic Federation could not move the agent: the reason and what to do. */
	blocked?: { reason?: string; fix?: string };
} {
	if (mode.kind === 'hosted') {
		return {
			label: 'Hosted',
			title: `Hosted on ${mode.peerName}`,
			lines: [
				'Keeps running while this machine sleeps or is off.',
				`The Maestro host on ${mode.peerName} owns this agent and runs its turns, queue, Auto Run, and Cue. This window is a live view of it.`,
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
	};
}

export const FederationBadge = memo(function FederationBadge({
	theme,
	mode,
}: {
	theme: Theme;
	mode: FederationBadgeMode;
}) {
	const copy = federationBadgeCopy(mode);
	const color =
		mode.kind === 'hosted'
			? theme.colors.accent
			: copy.blocked
				? theme.colors.error
				: theme.colors.warning;
	return (
		<HoverTooltip
			theme={theme}
			maxWidth={300}
			label={
				<span className="block text-left" data-testid="federation-badge-card">
					<span className="block font-semibold mb-1">{copy.title}</span>
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
				testId={`federation-badge-${mode.kind}`}
			/>
		</HoverTooltip>
	);
});
