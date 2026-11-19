import {
	describePlaybookUpdate,
	type PlaybookUpdateStatus,
} from '../../../../shared/playbookUpdates';
import { MiniBadge } from '../../ui/MiniBadge';
import type { Theme } from '../../../types';

/**
 * The pill beside an installed playbook: "Update available" when the
 * Exchange has a newer version, "Edited" when only the source copy changed,
 * nothing when it is up to date. Shared with the Auto Run playbook dropdown.
 */
export function PlaybookUpdatePill({
	theme,
	status,
	title,
	testId,
}: {
	theme: Theme;
	status: PlaybookUpdateStatus | undefined;
	/** Replaces the default tooltip (what changed), e.g. why the update is unavailable. */
	title?: string;
	testId?: string;
}) {
	if (!status || status.state === 'up-to-date') return null;
	return (
		<MiniBadge
			label={status.updateAvailable ? 'Update available' : 'Edited'}
			theme={theme}
			color={status.updateAvailable ? theme.colors.accent : theme.colors.warning}
			title={title ?? describePlaybookUpdate(status)}
			testId={testId}
		/>
	);
}
