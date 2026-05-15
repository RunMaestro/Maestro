/**
 * ClaudeModeBadge — tab badge surfacing the current Claude headless-mode
 * decision (Interactive / API / auto-fallback to API) for a Claude Code tab.
 *
 * Displays one of five states sourced from `session.claudeInteractive` plus
 * the renderer-mirrored usage snapshot for the account that was consulted on
 * the last spawn (`lastUsageSnapshotKey`):
 *
 *   - mode='interactive' + reason='auto' → green Terminal
 *   - mode='interactive' + reason='user' → green Terminal + Lock overlay
 *   - mode='api'         + reason='auto' → blue Cloud
 *   - mode='api'         + reason='user' → blue Cloud + Lock overlay
 *   - mode='api'         + reason='limit'→ orange AlertTriangle (with reset countdown)
 *
 * Clicking the badge advances the three-state cycle through the same hook the
 * AI tab overlay menu uses (`useClaudeInteractiveMode`), so the badge and the
 * menu stay in sync without duplicating logic. `readOnly` suppresses the click
 * affordance entirely so read-only mode can't accidentally mutate state.
 */

import { memo, useCallback, type MouseEvent } from 'react';
import { AlertTriangle, Cloud, Lock, Terminal } from 'lucide-react';

import { useClaudeInteractiveMode } from '../../hooks/agent/useClaudeInteractiveMode';
import { useClaudeUsageSnapshot } from '../../stores/claudeUsageStore';
import { useSessionStore, selectSessionById } from '../../stores/sessionStore';
import { formatRelativeTime } from '../../../shared/formatters';

/**
 * Derive a short, human-readable account name from a canonical
 * `CLAUDE_CONFIG_DIR` path. Examples:
 *   `/Users/me/.claude-gmail` → `gmail`
 *   `/Users/me/.claude`       → `default`
 *   `/opt/claude-work`        → `claude-work` (verbatim basename)
 *
 * Exported for the Usage Dashboard / Settings panel which surface the same name.
 */
export function deriveAccountShortName(configDirKey: string | undefined): string {
	if (!configDirKey) return 'default';
	const trimmed = configDirKey.replace(/\/+$/, '');
	const basename = trimmed.slice(trimmed.lastIndexOf('/') + 1);
	if (!basename || basename === '.claude') return 'default';
	if (basename.startsWith('.claude-')) return basename.slice('.claude-'.length);
	if (basename.startsWith('.claude')) return basename.slice('.claude'.length) || 'default';
	return basename;
}

interface ClaudeModeBadgeProps {
	sessionId: string;
	/** When true, the badge renders but does not respond to clicks. */
	readOnly?: boolean;
	/** Optional extra classes (e.g., spacing tweaks per render site). */
	className?: string;
}

export const ClaudeModeBadge = memo(function ClaudeModeBadge({
	sessionId,
	readOnly,
	className,
}: ClaudeModeBadgeProps) {
	const { isClaudeCode, cycle } = useClaudeInteractiveMode(sessionId);

	// Read the session's mode block directly so this component renders even
	// when nothing else on the session changed (selector inside the hook is
	// scoped to the cycle position, not the raw mode/reason pair).
	const session = useSessionStore(selectSessionById(sessionId));

	const block = session?.claudeInteractive;
	const snapshot = useClaudeUsageSnapshot(block?.lastUsageSnapshotKey);

	const handleClick = useCallback(
		(e: MouseEvent<HTMLButtonElement>) => {
			e.stopPropagation();
			if (readOnly) return;
			void cycle();
		},
		[cycle, readOnly]
	);

	if (!isClaudeCode || !block) return null;

	const accountName = deriveAccountShortName(block.lastUsageSnapshotKey);
	const baseClasses = `shrink-0 inline-flex items-center justify-center relative ${
		className ?? ''
	}`;

	let icon;
	let tooltip;

	if (block.mode === 'interactive' && block.modeReason === 'user') {
		icon = (
			<>
				<Terminal className="w-3 h-3 text-emerald-500" aria-hidden="true" />
				<Lock
					className="w-2 h-2 absolute -bottom-0.5 -right-0.5 text-emerald-500"
					aria-hidden="true"
				/>
			</>
		);
		tooltip = 'Interactive (manually pinned)';
	} else if (block.mode === 'interactive') {
		icon = <Terminal className="w-3 h-3 text-emerald-500" aria-hidden="true" />;
		tooltip = `Interactive (using Max plan quota for ${accountName})`;
	} else if (block.modeReason === 'limit') {
		icon = <AlertTriangle className="w-3 h-3 text-orange-500" aria-hidden="true" />;
		const resetsAt = snapshot?.session.resetsAt;
		tooltip = resetsAt
			? `Auto-fell back to API (Max plan quota hit, resets ${formatRelativeTime(resetsAt)})`
			: 'Auto-fell back to API (Max plan quota hit)';
	} else if (block.modeReason === 'user') {
		icon = (
			<>
				<Cloud className="w-3 h-3 text-blue-500" aria-hidden="true" />
				<Lock
					className="w-2 h-2 absolute -bottom-0.5 -right-0.5 text-blue-500"
					aria-hidden="true"
				/>
			</>
		);
		tooltip = 'API mode (manually pinned)';
	} else {
		icon = <Cloud className="w-3 h-3 text-blue-500" aria-hidden="true" />;
		tooltip = 'API mode (billed per token)';
	}

	const interactive = !readOnly;
	const buttonClasses = `${baseClasses} ${
		interactive ? 'cursor-pointer hover:opacity-80' : 'cursor-default'
	}`;

	return (
		<button
			type="button"
			className={buttonClasses}
			title={tooltip}
			aria-label={tooltip}
			onClick={handleClick}
			disabled={readOnly}
			data-testid="claude-mode-badge"
		>
			{icon}
		</button>
	);
});
