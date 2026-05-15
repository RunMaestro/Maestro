/**
 * ClaudeInteractiveModeSection — Settings → General controls for Claude headless
 * mode (maestro-p). Surfaces three things:
 *   1. Global `claudeCode.headlessMode` pin (Interactive / API / Auto) — same
 *      ToggleButtonGroup the Default Thinking Mode block uses.
 *   2. `claudeCode.autoFallbackToApiOnLimit` toggle for the auto-fallback.
 *   3. Read-only display of current per-account Max-plan usage snapshots, with
 *      a "Refresh now" button that re-samples on main then mirrors the result
 *      into the renderer store.
 *
 * The two settings persist via `window.maestro.settings.set` using dot-notation
 * keys so they land on the nested `claudeCode` block on disk without touching
 * the on-disk schema introduced in phase 2.
 */

import { memo, useCallback } from 'react';
import { Cloud, RefreshCw, Shuffle } from 'lucide-react';
import type { Theme } from '../../types';
import { ToggleButtonGroup } from '../ToggleButtonGroup';
import { SettingCheckbox } from '../SettingCheckbox';
import type { ClaudeHeadlessMode } from '../../stores/settingsStore';
import { useClaudeUsageStore, type ClaudeUsageSnapshot } from '../../stores/claudeUsageStore';
import { deriveAccountShortName } from '../SessionList/ClaudeModeBadge';
import { formatRelativeTime } from '../../../shared/formatters';

export interface ClaudeInteractiveModeSectionProps {
	theme: Theme;
	headlessMode: ClaudeHeadlessMode;
	onHeadlessModeChange: (value: ClaudeHeadlessMode) => void;
	autoFallbackToApiOnLimit: boolean;
	onAutoFallbackToApiOnLimitChange: (value: boolean) => void;
}

const HEADLESS_MODE_OPTIONS: { value: ClaudeHeadlessMode; label: string }[] = [
	{ value: 'interactive', label: 'Interactive' },
	{ value: 'api', label: 'API' },
	{ value: 'auto', label: 'Auto' },
];

function helpTextForMode(mode: ClaudeHeadlessMode): string {
	if (mode === 'interactive') {
		return 'Always drive Claude via maestro-p — uses your Claude Max plan quota every turn, never bills the API.';
	}
	if (mode === 'api') {
		return 'Always run `claude --print` — bills per token, preserves your Max plan quota for direct TUI use.';
	}
	return 'Try interactive first and transparently fall back to API when the Max plan quota is exhausted.';
}

interface SnapshotRowProps {
	configDirKey: string;
	snapshot: ClaudeUsageSnapshot;
	theme: Theme;
}

const SnapshotRow = memo(function SnapshotRow({ configDirKey, snapshot, theme }: SnapshotRowProps) {
	const shortName = deriveAccountShortName(configDirKey);
	return (
		<div
			className="flex items-center justify-between text-xs gap-3"
			data-testid={`claude-mode-snapshot-row-${shortName}`}
		>
			<div className="flex-1 min-w-0">
				<div className="font-medium truncate" style={{ color: theme.colors.textMain }}>
					{shortName}
				</div>
				<div
					className="opacity-60 truncate"
					style={{ color: theme.colors.textDim }}
					title={configDirKey}
				>
					{configDirKey}
				</div>
			</div>
			<div className="flex items-center gap-3" style={{ color: theme.colors.textDim }}>
				<span title={`Resets ${snapshot.session.resetsAt}`}>
					session {Math.round(snapshot.session.percent)}% ·{' '}
					{formatRelativeTime(snapshot.session.resetsAt)}
				</span>
				<span title={`Resets ${snapshot.weekAllModels.resetsAt}`}>
					week {Math.round(snapshot.weekAllModels.percent)}%
				</span>
			</div>
		</div>
	);
});

export const ClaudeInteractiveModeSection = memo(function ClaudeInteractiveModeSection({
	theme,
	headlessMode,
	onHeadlessModeChange,
	autoFallbackToApiOnLimit,
	onAutoFallbackToApiOnLimitChange,
}: ClaudeInteractiveModeSectionProps) {
	const snapshots = useClaudeUsageStore((s) => s.snapshots);
	const refreshing = useClaudeUsageStore((s) => s.refreshing);

	const handleRefresh = useCallback(async () => {
		if (refreshing) return;
		try {
			await window.maestro.agents.refreshClaudeUsageSnapshots();
		} catch {
			// Main-side errors surface in main logs; the store keeps the last good
			// map rather than blowing up the settings panel.
		}
		await useClaudeUsageStore.getState().refresh();
	}, [refreshing]);

	const snapshotEntries = Object.entries(snapshots).sort(([a], [b]) =>
		deriveAccountShortName(a).localeCompare(deriveAccountShortName(b))
	);

	return (
		<div className="space-y-4">
			{/* Headless mode toggle */}
			<div data-setting-id="claudeCode.headlessMode">
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<Shuffle className="w-3 h-3" />
					Claude Headless Mode
				</div>
				<div
					className="p-3 rounded border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div className="font-medium mb-1" style={{ color: theme.colors.textMain }}>
						How to run Claude Code spawns
					</div>
					<div
						className="text-sm opacity-60 mb-3"
						style={{ color: theme.colors.textDim }}
						data-testid="claude-headless-mode-help"
					>
						{helpTextForMode(headlessMode)}
					</div>
					<ToggleButtonGroup
						options={HEADLESS_MODE_OPTIONS}
						value={headlessMode}
						onChange={onHeadlessModeChange}
						theme={theme}
					/>
				</div>
			</div>

			{/* Auto-fallback toggle — disabled UI hint when headlessMode != 'auto' isn't
			    enforced because the setting is still meaningful (it'll apply the next time
			    the user flips to auto). */}
			<div data-setting-id="claudeCode.autoFallbackToApiOnLimit">
				<SettingCheckbox
					icon={Cloud}
					sectionLabel="Auto-Fallback to API"
					title="Auto-fall back to API when Claude limits hit"
					description="When `auto` mode is active and the Max plan quota is exhausted, transparently switch the next turn to API mode."
					checked={autoFallbackToApiOnLimit}
					onChange={onAutoFallbackToApiOnLimitChange}
					theme={theme}
				/>
			</div>

			{/* Per-account usage snapshots */}
			<div>
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center justify-between gap-2">
					<span className="flex items-center gap-2">
						<RefreshCw className="w-3 h-3" />
						Max Plan Usage Snapshots
					</span>
					<button
						type="button"
						onClick={handleRefresh}
						disabled={refreshing}
						className="flex items-center gap-1.5 px-2 py-1 rounded text-xs normal-case transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						style={{
							color: theme.colors.textMain,
							backgroundColor: `${theme.colors.accent}15`,
						}}
						data-testid="claude-mode-refresh"
						aria-label="Refresh Claude usage snapshots"
					>
						<RefreshCw
							className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`}
							aria-hidden="true"
						/>
						{refreshing ? 'Refreshing…' : 'Refresh now'}
					</button>
				</div>
				<div
					className="p-3 rounded border space-y-2"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
					data-testid="claude-mode-snapshots"
				>
					{snapshotEntries.length === 0 ? (
						<div
							className="text-xs"
							style={{ color: theme.colors.textDim }}
							data-testid="claude-mode-snapshots-empty"
						>
							No Claude Max plan snapshots yet. Auto-mode samples on first spawn.
						</div>
					) : (
						snapshotEntries.map(([configDirKey, snapshot]) => (
							<SnapshotRow
								key={configDirKey}
								configDirKey={configDirKey}
								snapshot={snapshot}
								theme={theme}
							/>
						))
					)}
				</div>
			</div>
		</div>
	);
});

export default ClaudeInteractiveModeSection;
