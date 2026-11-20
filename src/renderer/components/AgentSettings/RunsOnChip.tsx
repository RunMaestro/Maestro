/**
 * RunsOnChip - "Runs on <remote | Local>", drawn in the title bar of the agent
 * and group settings modals so the SSH state stays visible on every tab
 * without a visit to the SSH tab.
 *
 * Given `choice`, the chip is the choice itself: a dropdown of Local and each
 * remote (New Agent). It writes the same SSH config the SSH tab does.
 */

import type { ReactNode } from 'react';
import type { Theme } from '../../types';
import { SshRemotePill } from '../ui/SshRemotePill';
import { ThemedSelect } from '../shared/ThemedSelect';
import { localExecutionLabel } from '../shared/SshRemoteSelector';

/** One remote the dropdown offers. */
export interface RunsOnRemoteOption {
	id: string;
	name: string;
	/** Drawn at the right of the option, e.g. how many agents the host can hand over. */
	rightContent?: ReactNode;
}

export interface RunsOnChoice {
	remotes: RunsOnRemoteOption[];
	/** The chosen remote id; null is local. */
	value: string | null;
	onChange: (remoteId: string | null) => void;
}

export interface RunsOnChipProps {
	theme: Theme;
	/** SSH remote name when the agent runs remote; omitted means local. */
	sshRemoteHost?: string;
	/** The form's id prefix; the chip's test id is `${idPrefix}-runs-on`. */
	idPrefix: string;
	/** Makes the chip a dropdown. Without remotes there is nothing to choose, so it stays a label. */
	choice?: RunsOnChoice;
}

/** The dropdown's value for local: a remote id is never empty. */
const LOCAL_VALUE = '';

export function RunsOnChip({ theme, sshRemoteHost, idPrefix, choice }: RunsOnChipProps) {
	const selectable = !!choice && choice.remotes.length > 0;
	return (
		<div
			className="flex items-center gap-2 text-xs shrink-0"
			style={{ color: theme.colors.textDim }}
			data-testid={`${idPrefix}-runs-on`}
		>
			<span>Runs on</span>
			{selectable ? (
				<ThemedSelect
					id={`${idPrefix}-runs-on-select`}
					theme={theme}
					value={choice.value ?? LOCAL_VALUE}
					onChange={(value) => choice.onChange(value === LOCAL_VALUE ? null : value)}
					aria-label="Runs on"
					style={{ minWidth: 140, maxWidth: 240 }}
					options={[
						{ value: LOCAL_VALUE, label: localExecutionLabel() },
						...choice.remotes.map((remote) => ({
							value: remote.id,
							label: remote.name,
							rightContent: remote.rightContent,
						})),
					]}
				/>
			) : sshRemoteHost ? (
				<SshRemotePill remoteName={sshRemoteHost} size="sm" />
			) : (
				<span style={{ color: theme.colors.textMain }}>{localExecutionLabel()}</span>
			)}
		</div>
	);
}
