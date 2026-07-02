/**
 * RenderedMentionChip - the transcript (rendered-mode) wrapper around the pure
 * {@link MentionChip} primitive. `MarkdownLink` renders this when a link node
 * carries `data-mention-kind` (emitted by `remarkMentionChips`).
 *
 * It resolves the per-chip display data (extension tint for files, participant
 * color + jump target for agents) and wires the interactive click:
 *   - file  -> reuse the caller's `onFileClick` (opens a preview tab)
 *   - agent -> `maestro://` jump to the resolved agent
 *
 * Keeping resolution here (not in `MentionChip`) preserves the primitive as a
 * pure, state-free component and confines the store access to actual chips.
 */

import type { Theme } from '../../../types';
import { useSettingsStore } from '../../../stores/settingsStore';
import { MentionChip } from '../../MentionChip';
import {
	resolveAgentMention,
	resolveFileMentionIconColor,
} from '../../../utils/mentionChipResolve';
import { openMaestroLink } from '../../../utils/openMaestroLink';
import { buildSessionDeepLink } from '../../../../shared/deep-link-urls';

export interface RenderedMentionChipProps {
	kind: 'file' | 'agent';
	theme: Theme;
	/** File chips: relative path + extension. */
	filePath?: string;
	extension?: string;
	/** Agent chips: raw `@name` name (without the `@`). */
	agentName?: string;
	/** File-open handler from the surrounding markdown surface. */
	onFileClick?: (path: string) => void;
}

export function RenderedMentionChip({
	kind,
	theme,
	filePath,
	extension,
	agentName,
	onFileClick,
}: RenderedMentionChipProps) {
	const colorBlindMode = useSettingsStore((state) => state.colorBlindMode);

	if (kind === 'file') {
		const path = filePath ?? '';
		return (
			<MentionChip
				kind="file"
				theme={theme}
				label={path}
				iconColor={resolveFileMentionIconColor(extension ?? '', theme, colorBlindMode)}
				onClick={onFileClick ? () => onFileClick(path) : undefined}
			/>
		);
	}

	const agent = resolveAgentMention(agentName ?? '', theme);
	return (
		<MentionChip
			kind="agent"
			theme={theme}
			label={agent.label}
			tooltip={agent.label}
			iconColor={agent.color}
			onClick={
				agent.sessionId
					? () => openMaestroLink(buildSessionDeepLink(agent.sessionId as string))
					: undefined
			}
		/>
	);
}
