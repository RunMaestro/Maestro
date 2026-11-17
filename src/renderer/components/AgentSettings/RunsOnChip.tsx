/**
 * RunsOnChip - "Runs on <remote | Local>", drawn in the title bar of the agent
 * and group settings modals so the SSH state stays visible on every tab
 * without a visit to the SSH tab.
 */

import type { Theme } from '../../types';
import { SshRemotePill } from '../ui/SshRemotePill';

export interface RunsOnChipProps {
	theme: Theme;
	/** SSH remote name when the agent runs remote; omitted means local. */
	sshRemoteHost?: string;
	/** The form's id prefix; the chip's test id is `${idPrefix}-runs-on`. */
	idPrefix: string;
}

export function RunsOnChip({ theme, sshRemoteHost, idPrefix }: RunsOnChipProps) {
	return (
		<div
			className="flex items-center gap-2 text-xs shrink-0"
			style={{ color: theme.colors.textDim }}
			data-testid={`${idPrefix}-runs-on`}
		>
			<span>Runs on</span>
			{sshRemoteHost ? (
				<SshRemotePill remoteName={sshRemoteHost} size="sm" />
			) : (
				<span style={{ color: theme.colors.textMain }}>Local</span>
			)}
		</div>
	);
}
