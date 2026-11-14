/**
 * GroupSeedBanner - the line above the New Agent tabs that says the form was
 * pre-filled from a group's defaults.
 *
 * A form that opens with values the user did not type has to say where they
 * came from. The banner names the group (a button that opens its Group
 * Settings), and everything about the seed the form itself cannot show:
 *
 *   - the group's SSH remote no longer exists, so the agent runs locally;
 *   - defaults the form has no control for, which are set as the agent is
 *     created;
 *   - defaults that were left out, each with its reason.
 */

import type { GroupDefaultsSkip } from '../../../shared/groupAgentDefaults';
import type { Group, Theme } from '../../types';

export interface GroupSeedBannerProps {
	theme: Theme;
	/** The group whose defaults filled the form. */
	group: Pick<Group, 'name' | 'emoji'>;
	/** The defaults named an SSH remote that was deleted since: the form runs locally. */
	sshRemoteMissing: boolean;
	/** Names of the defaults that are set when the agent is created, not in the form. */
	appliedOnCreate: string[];
	/** Defaults that were not used, each with its reason. */
	skipped: GroupDefaultsSkip[];
	/** Open Group Settings for this group. The host closes the create form first. */
	onOpenGroupSettings: () => void;
	className?: string;
}

export function GroupSeedBanner({
	theme,
	group,
	sshRemoteMissing,
	appliedOnCreate,
	skipped,
	onOpenGroupSettings,
	className = '',
}: GroupSeedBannerProps) {
	return (
		<div
			className={`p-3 rounded border text-xs space-y-1 select-text shrink-0 ${className}`}
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgActivity,
				color: theme.colors.textDim,
			}}
			role="note"
			data-testid="new-agent-group-seed-banner"
		>
			<p>
				Pre-filled from{' '}
				<button
					type="button"
					onClick={onOpenGroupSettings}
					className="font-bold underline hover:opacity-80"
					style={{ color: theme.colors.accent }}
					title="Open Group Settings for this group. This form closes, and what you typed here is lost."
				>
					{`${group.emoji} ${group.name}`.trim()}
				</button>{' '}
				group settings. Edit anything before creating.
				{sshRemoteMissing && (
					<span style={{ color: theme.colors.warning }} data-testid="new-agent-group-seed-ssh-note">
						{' '}
						SSH remote no longer exists, running locally.
					</span>
				)}
			</p>
			{appliedOnCreate.length > 0 && (
				<p data-testid="new-agent-group-seed-extras">
					Also set when the agent is created: {appliedOnCreate.join(', ')}. Change them afterwards
					in Edit Agent.
				</p>
			)}
			{skipped.map((skip) => (
				<p
					key={skip.label}
					style={{ color: theme.colors.warning }}
					data-testid="new-agent-group-seed-skipped"
				>
					Not pre-filled: {skip.label}. {skip.reason}
				</p>
			))}
		</div>
	);
}
