import React, { useMemo } from 'react';
import { Users } from 'lucide-react';
import type { Group, Theme, ToolType } from '../../types';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import {
	groupDefaultsPublishProvider,
	publishableChangesFor,
	summarizeGroupDefaultsDiff,
	type GroupDefaultsDiff,
} from '../../../shared/groupAgentDefaults';
import { ConfirmModal } from '../ConfirmModal';

/** How many agent names a line lists before it counts the rest. */
const MAX_LISTED_NAMES = 8;

/** One direct member of the group: what the dialog needs to name and count it. */
export interface PublishDialogMember {
	id: string;
	name: string;
	toolType: ToolType;
}

export interface PublishDefaultsDialogProps {
	theme: Theme;
	group: Pick<Group, 'name' | 'emoji'>;
	/** What this save changed in the group's defaults. */
	diff: GroupDefaultsDiff;
	/** The group's direct members. Child groups are not reached, so not listed. */
	members: PublishDialogMember[];
	/** Save the profile and write the change to the members. */
	onPublish: () => void;
	/** Save the profile and leave every member as it is. */
	onNewAgentsOnly: () => void;
	/** Abandon the save. The form under the dialog keeps what was typed. */
	onCancel: () => void;
}

function listNames(names: string[]): string {
	if (names.length <= MAX_LISTED_NAMES) return names.join(', ');
	return `${names.slice(0, MAX_LISTED_NAMES).join(', ')}, and ${names.length - MAX_LISTED_NAMES} more`;
}

function agentCount(count: number): string {
	return `${count} agent${count === 1 ? '' : 's'}`;
}

/** Field names in bold, joined the way a sentence lists them. */
function Labels({ labels, theme }: { labels: string[]; theme: Theme }) {
	return (
		<>
			{labels.map((label, index) => (
				<React.Fragment key={label}>
					{index > 0 &&
						(index === labels.length - 1 ? `${labels.length > 2 ? ',' : ''} and ` : ', ')}
					<strong style={{ color: theme.colors.textMain }}>{label}</strong>
				</React.Fragment>
			))}
		</>
	);
}

/**
 * Asks where a Group Settings save goes: to the agents already in the group,
 * or to new agents only. Shown only when there is something to decide, so the
 * save of a group with no agents, or of a change no agent can receive, never
 * raises it.
 *
 * Three outcomes and no fourth. Cancel and Escape abandon the save. "New
 * agents only" has the focus, because the other button is a bulk write over
 * settings the user tuned by hand.
 */
export function PublishDefaultsDialog({
	theme,
	group,
	diff,
	members,
	onPublish,
	onNewAgentsOnly,
	onCancel,
}: PublishDefaultsDialogProps) {
	const summary = useMemo(() => summarizeGroupDefaultsDiff(diff), [diff]);
	const reached = useMemo(
		() => members.filter((member) => publishableChangesFor(member.toolType, diff).length > 0),
		[members, diff]
	);
	const provider = groupDefaultsPublishProvider(diff);
	const onProvider = members.filter((member) => member.toolType === provider);
	// Said only when it changes who gets what: some member is on another provider.
	const showProviderNote =
		!!provider && summary.providerBound.length > 0 && onProvider.length < members.length;

	const publishLabel =
		reached.length === members.length
			? `Publish to ${members.length === 1 ? '1 agent' : `all ${members.length} agents`}`
			: `Publish to ${reached.length} of ${agentCount(members.length)}`;
	const dim = { color: theme.colors.textDim };

	return (
		<ConfirmModal
			theme={theme}
			title="Publish to existing agents?"
			message={
				<>
					You changed <Labels labels={summary.changed} theme={theme} />.
				</>
			}
			destructive={false}
			headerIcon={<Users className="w-4 h-4" style={{ color: theme.colors.warning }} />}
			icon={<Users className="w-5 h-5" style={{ color: theme.colors.warning }} />}
			confirmLabel={publishLabel}
			onConfirm={onPublish}
			onClose={onCancel}
			alternative={{ label: 'New agents only', onSelect: onNewAgentsOnly }}
			width={520}
			testId="group-settings-publish-dialog"
		>
			<p className="text-sm" style={dim} data-testid="group-settings-publish-members">
				{group.emoji} {group.name} has{' '}
				<strong style={{ color: theme.colors.textMain }}>{agentCount(members.length)}</strong>:{' '}
				{listNames(members.map((member) => member.name))}.
			</p>
			{showProviderNote && (
				<p className="text-sm" style={dim} data-testid="group-settings-publish-provider-note">
					<Labels labels={summary.providerBound} theme={theme} />{' '}
					{summary.providerBound.length === 1 ? 'is a' : 'are'} {getAgentDisplayName(provider)}{' '}
					{summary.providerBound.length === 1 ? 'setting' : 'settings'}.{' '}
					{onProvider.length > 0
						? `Published only to ${listNames(onProvider.map((member) => member.name))}.`
						: `No agent in this group runs ${getAgentDisplayName(provider)}, so not published.`}
				</p>
			)}
			{summary.unpublished.length > 0 && (
				<p className="text-sm" style={dim} data-testid="group-settings-publish-unpublished">
					Not published (new agents only): <Labels labels={summary.unpublished} theme={theme} />.
				</p>
			)}
			{summary.replaced.length > 0 && (
				<p className="text-sm" style={dim} data-testid="group-settings-publish-replaced">
					<Labels labels={summary.replaced} theme={theme} />{' '}
					{summary.replaced.length === 1 ? 'replaces' : 'replace'} each agent's own list. A list is
					not merged.
				</p>
			)}
			<p className="text-xs" style={dim}>
				A turn that is running finishes on its current settings. A publish can be undone from its
				notification.
			</p>
		</ConfirmModal>
	);
}
