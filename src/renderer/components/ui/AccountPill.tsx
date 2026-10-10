/**
 * AccountPill - names the account a login or check acts on.
 *
 * The provider re-auth dialog and the GitHub login both act on one account out
 * of possibly several (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, or several gh logins
 * on one host), and the wrong one costs a whole round trip to discover. So the
 * account is stated outright, in the same accent pill on every surface.
 */

import { UserRound } from 'lucide-react';
import type { Theme } from '../../types';

export interface AccountPillProps {
	theme: Theme;
	label: string;
	/** Full text for the tooltip, when the label is a shortened form. */
	title?: string;
	testId?: string;
}

export function AccountPill({ theme, label, title, testId }: AccountPillProps) {
	return (
		<span
			className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium select-text min-w-0"
			style={{
				borderColor: theme.colors.accent,
				color: theme.colors.accent,
				backgroundColor: `${theme.colors.accent}20`,
			}}
			title={title ?? label}
			data-testid={testId}
		>
			<UserRound className="w-3.5 h-3.5 shrink-0" />
			<span className="truncate">{label}</span>
		</span>
	);
}

/** `pedramamini @ github.com` for a gh account. */
export function ghAccountLabel(account: { host: string; login: string }): string {
	return `${account.login} @ ${account.host}`;
}
