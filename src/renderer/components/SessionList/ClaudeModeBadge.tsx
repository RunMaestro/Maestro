/**
 * ClaudeModeBadge - per-session visual indicator of the resolved Claude
 * headless mode (interactive vs api) and why it landed there (auto vs user
 * pin vs limit-hit fallback).
 *
 * Display rules (Phase 3 task 2):
 *   - mode=interactive, reason=auto    → green TUI icon
 *     tooltip: "Interactive (using Max plan quota for {account-short-name})"
 *   - mode=interactive, reason=user    → green TUI + lock
 *     tooltip: "Interactive (manually pinned)"
 *   - mode=api, reason=auto            → blue cloud icon
 *     tooltip: "API mode (billed per token)"
 *   - mode=api, reason=user            → blue cloud + lock
 *     tooltip: "API mode (manually pinned)"
 *   - mode=api, reason=limit           → orange warning icon
 *     tooltip: "Auto-fell back to API (Max plan quota hit, resets at {time})"
 *
 * The account short name is derived from the configDirKey (basename of
 * `CLAUDE_CONFIG_DIR`, e.g. `.claude-gmail` → `gmail`, default `.claude` →
 * `default`). The reset time uses `formatRelativeTime()` from the shared
 * formatters module — per the playbook, no new formatter is introduced.
 *
 * Clicking the badge cycles the per-session Claude headless mode the same
 * way the existing overlay-menu item does (auto → force-interactive →
 * force-api → auto), via `useClaudeInteractiveMode`.
 */

import { memo, useCallback, useMemo, type CSSProperties } from 'react';
import { Terminal, Cloud, Lock, AlertTriangle } from 'lucide-react';
import { formatRelativeTime } from '../../../shared/formatters';
import { useClaudeUsageSnapshot } from '../../stores/claudeUsageStore';
import { useClaudeInteractiveMode } from '../../hooks/agent/useClaudeInteractiveMode';
import { useSessionStore } from '../../stores/sessionStore';
import type { Theme } from '../../types';

export interface ClaudeModeBadgeProps {
	sessionId: string;
	theme: Theme;
	/** When true, suppress the click-to-cycle behavior (e.g. read-only badge spots). */
	readOnly?: boolean;
	/** Optional className for layout containers (e.g. sizing the badge in a row). */
	className?: string;
	/** Optional style override (e.g. when embedding in a flex header). */
	style?: CSSProperties;
}

/**
 * Derive the short account name from a `configDirKey`. The key is a
 * `path.resolve()`-canonical absolute path like `/Users/me/.claude-gmail`;
 * we strip the leading `.claude-` (or fall back to `default` when the
 * directory is the unmodified `.claude` home).
 */
function accountShortName(configDirKey: string | undefined): string {
	if (!configDirKey) return 'default';
	const base = configDirKey.split('/').filter(Boolean).pop() ?? '';
	if (!base || base === '.claude') return 'default';
	if (base.startsWith('.claude-')) return base.slice('.claude-'.length) || 'default';
	if (base.startsWith('.claude')) return base.slice('.claude'.length) || 'default';
	return base;
}

interface BadgeDisplay {
	icon: typeof Terminal;
	color: string;
	showLock: boolean;
	tooltip: string;
}

export const ClaudeModeBadge = memo(function ClaudeModeBadge({
	sessionId,
	theme,
	readOnly = false,
	className,
	style,
}: ClaudeModeBadgeProps) {
	const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId));
	const interactive = session?.claudeInteractive;
	const isClaudeCode = session?.toolType === 'claude-code';
	const snapshot = useClaudeUsageSnapshot(interactive?.lastUsageSnapshotKey ?? null);
	const { cycle } = useClaudeInteractiveMode(sessionId);

	const onClick = useCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			e.stopPropagation();
			if (readOnly) return;
			void cycle();
		},
		[cycle, readOnly]
	);

	const display = useMemo<BadgeDisplay | null>(() => {
		if (!isClaudeCode || !interactive) return null;
		const account = accountShortName(interactive.lastUsageSnapshotKey);

		if (interactive.mode === 'interactive') {
			if (interactive.modeReason === 'user') {
				return {
					icon: Terminal,
					color: theme.colors.success,
					showLock: true,
					tooltip: 'Interactive (manually pinned)',
				};
			}
			return {
				icon: Terminal,
				color: theme.colors.success,
				showLock: false,
				tooltip: `Interactive (using Max plan quota for ${account})`,
			};
		}

		// mode === 'api'
		if (interactive.modeReason === 'limit') {
			const resetsAt = snapshot?.session.resetsAt;
			const resetSuffix = resetsAt ? `, resets ${formatRelativeTime(resetsAt)}` : '';
			return {
				icon: AlertTriangle,
				color: theme.colors.warning,
				showLock: false,
				tooltip: `Auto-fell back to API (Max plan quota hit${resetSuffix})`,
			};
		}
		if (interactive.modeReason === 'user') {
			return {
				icon: Cloud,
				color: theme.colors.accent,
				showLock: true,
				tooltip: 'API mode (manually pinned)',
			};
		}
		return {
			icon: Cloud,
			color: theme.colors.accent,
			showLock: false,
			tooltip: 'API mode (billed per token)',
		};
	}, [interactive, isClaudeCode, snapshot, theme]);

	if (!display) return null;

	const Icon = display.icon;
	return (
		<button
			type="button"
			data-testid={`claude-mode-badge-${sessionId}`}
			data-claude-mode={interactive?.mode}
			data-claude-mode-reason={interactive?.modeReason}
			onClick={onClick}
			disabled={readOnly}
			aria-label={display.tooltip}
			title={display.tooltip}
			className={`relative inline-flex items-center justify-center rounded p-0.5 ${
				readOnly ? 'cursor-default' : 'hover:bg-white/10 cursor-pointer'
			} ${className ?? ''}`}
			style={style}
		>
			<Icon className="w-3.5 h-3.5" style={{ color: display.color }} />
			{display.showLock && (
				<Lock
					className="absolute -bottom-0.5 -right-0.5 w-2 h-2"
					style={{ color: display.color, backgroundColor: theme.colors.bgSidebar }}
				/>
			)}
		</button>
	);
});
