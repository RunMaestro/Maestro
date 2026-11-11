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

export type FederationBadgeMode =
	| { kind: 'ssh'; remoteName?: string; hostReady: boolean; canFederate: boolean }
	| { kind: 'federated'; peerName: string };

/** The hover card's lines, exported so tests and docs read the same words. */
export function federationBadgeCopy(mode: FederationBadgeMode): {
	label: string;
	title: string;
	lines: string[];
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
	const next = !mode.canFederate
		? 'Federation is off for this remote, so it stays an SSH agent.'
		: mode.hostReady
			? 'This remote runs a Maestro host: right-click > Move to Host to federate this agent.'
			: 'Right-click > Make Federated to install a Maestro host on the remote and move this agent onto it.';
	return {
		label: 'SSH',
		title: `SSH agent${where}`,
		lines: [
			'This Maestro starts every turn over SSH, so the work stops when this machine sleeps or disconnects.',
			"A federated agent runs on the remote's own Maestro host instead and keeps working with this machine off.",
			next,
		],
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
	const color = mode.kind === 'federated' ? theme.colors.accent : theme.colors.warning;
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
