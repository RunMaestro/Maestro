import { memo } from 'react';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import type { ProviderAuthSnapshot } from '../../../shared/providerAuth';
import type { Theme } from '../../types';

interface AuthIndicatorProps {
	/** The snapshot of the credential this agent presents, or null when unknown. */
	snapshot: ProviderAuthSnapshot | null;
	theme: Theme;
	/** Opens the recovery flow for this identity. See the TODO in SessionList. */
	onClick?: (identityKey: string) => void;
}

/**
 * What the row should show for a snapshot, or null when the credential is fine.
 *
 * Two states earn a mark, and they are NOT the same problem:
 *
 * - `logged-out` - an OAuth login expired. A sign-in repairs it.
 * - `unsupported` **from a live failure** - an API key, gateway token, or cloud
 *   credential was rejected. Nothing a sign-in can fix; the key itself is wrong.
 *
 * `unsupported` from a probe means "there is nothing here to probe" (Factory
 * Droid has no status subcommand), which is the normal state of a perfectly
 * healthy agent. Badging those rows would put a permanent warning on an agent
 * that has nothing wrong with it, so the source is what separates the two.
 */
export function describeAuthIndicator(
	snapshot: ProviderAuthSnapshot | null
): { tooltip: string; canSignIn: boolean } | null {
	if (!snapshot) return null;

	const { identity, status, source } = snapshot;
	// The account, not the agent: fifteen rows can carry this mark and the thing
	// that is broken is the one login they share.
	const account = `${getAgentDisplayName(identity.provider)} (${identity.label})`;

	if (status === 'logged-out') {
		return { tooltip: `${account} needs re-authentication`, canSignIn: true };
	}
	if (status === 'unsupported' && source !== 'probe') {
		return { tooltip: `${account} rejected its credential`, canSignIn: false };
	}
	return null;
}

/**
 * Auth indicator rendered next to the agent's status dot in the Left Bar.
 *
 * Deliberately not a sixth status-dot color. The dot answers "what is this agent
 * doing" (ready / thinking / error / connecting); this answers "this agent will
 * not run until you deal with an account", which no dot state covers - and red
 * already means "no connection", which is a different problem with a different
 * fix. The treatment is a key glyph in the theme accent: accent is the codebase's
 * interactive color, so it reads as "click me" rather than "something died".
 *
 * Renders null when the credential is fine, so callers mount it unconditionally
 * (same contract as CueIndicator / WizardIndicator).
 */
export const AuthIndicator = memo(function AuthIndicator({
	snapshot,
	theme,
	onClick,
}: AuthIndicatorProps) {
	const described = describeAuthIndicator(snapshot);
	if (!described || !snapshot) return null;

	const { tooltip, canSignIn } = described;
	const Icon = canSignIn ? KeyRound : ShieldAlert;
	const identityKey = snapshot.identity.key;

	return (
		<button
			type="button"
			onClick={(e) => {
				// The row itself selects the agent; the mark is about the account.
				e.stopPropagation();
				onClick?.(identityKey);
			}}
			className="shrink-0 flex items-center p-0.5 rounded hover:bg-white/10 transition-colors"
			style={{ backgroundColor: theme.colors.accent + '20' }}
			title={tooltip}
			aria-label={tooltip}
			data-auth-indicator={canSignIn ? 'logged-out' : 'rejected'}
		>
			<Icon className="w-2.5 h-2.5" style={{ color: theme.colors.accent }} />
		</button>
	);
});
