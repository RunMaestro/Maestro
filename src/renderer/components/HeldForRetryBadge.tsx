import type { Theme } from '../types';
import { MiniBadge } from './ui/MiniBadge';

/**
 * Tags the queued copy of a turn that failed on a provider wall (see
 * `useIsHeldRetryItem`). Agent Resilience parks that turn at the head of its
 * tab's queue for the outage, so the same text shows in the transcript AND in
 * the queue and reads like a double send. It is not: the retry takes this copy
 * out of the queue as it resends it. Shared by both queue surfaces so they say
 * the same thing.
 */
export function HeldForRetryBadge({ theme }: { theme: Theme }) {
	return (
		<MiniBadge
			label="Awaiting retry"
			theme={theme}
			color={theme.colors.warning}
			title="The message that failed. The auto-retry sends it once, from here - it is not a second copy."
			testId="held-for-retry-badge"
		/>
	);
}
