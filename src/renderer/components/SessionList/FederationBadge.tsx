/**
 * FederationBadge - the Left Bar's mark of HOW an agent on another machine runs, with a hover
 * card that explains the difference.
 *
 * - `ssh`: an SSH agent. This Maestro starts each turn over SSH, so the work stops when this
 *   machine sleeps or loses the connection.
 * - `federated`: an agent owned by the Maestro host on the remote (a mirrored peer row). Turns, the
 *   queue, Auto Run, and Cue keep running there while this machine is off.
 *
 * Federation is opportunistic, so the card on an SSH agent also says what the next step is: Move
 * to Host when its remote already runs a host, Make Federated when it does not. A local agent gets
 * no badge, and an agent that moved already shows `LiftedPointerChip` instead.
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
	| { kind: 'federated'; peerName: string };

/** The hover card's lines, exported so tests and docs read the same words. */
export function federationBadgeCopy(mode: FederationBadgeMode): {
	label: string;
	title: string;
	lines: string[];
	/** Automatic Federation could not move the agent: the reason and what to do. */
	blocked?: { reason?: string; fix?: string };
} {
	if (mode.kind === 'federated') {
		return {
			label: 'Federated',
			title: `Federated agent on ${mode.peerName}`,
			lines: [
				`The Maestro host on ${mode.peerName} owns this agent and runs its turns, queue, Auto Run, and Cue.`,
				'The work keeps going while this machine sleeps or is off. This window is a live view of it.',
			],
		};
	}
	const where = mode.remoteName ? ` on ${mode.remoteName}` : '';
	const auto = mode.auto;
	const manualNext = !mode.canFederate
		? 'Federation does not reach this remote right now: it is disabled, Federation is off for it, or Maestro has not checked it yet.'
		: mode.hostReady
			? 'This remote runs a Maestro host: right-click > Move to Host to federate this agent.'
			: 'Right-click > Make Federated to install a Maestro host on the remote and move this agent onto it.';
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
			'This Maestro starts every turn over SSH, so the work stops when this machine sleeps or disconnects.',
			"A federated agent runs on the remote's own Maestro host instead and keeps working with this machine off.",
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
		mode.kind === 'federated'
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
