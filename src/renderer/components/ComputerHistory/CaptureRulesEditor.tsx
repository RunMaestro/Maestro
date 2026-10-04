/**
 * Computer History - which apps and domains are recorded.
 *
 * Shared by the viewer's Capture tab and the Settings tile, so the two cannot
 * disagree about what a switch means. One switch per app answers the only
 * question a user has ("is this app recorded?"), whatever the mode:
 *
 *   exclude mode: recorded unless an `ignore` rule matches the app
 *   include mode: recorded only when a `record` rule matches (and no ignore)
 *
 * Flipping a switch writes the rule that makes the answer true, through the
 * same service verbs `maestro-cli computer-history rules ...` uses. Both
 * lists survive a mode switch, so trying include mode costs nothing.
 *
 * The app list comes from `knownApps()`: everything recorded in the last 30
 * days plus apps seen this session (an app kept off disk by a rule is still
 * seen, which is exactly the app an include list needs to name).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Globe, Lock, Plus, Trash2 } from 'lucide-react';
import type { Theme } from '../../types';
import { SegmentedControl } from '../ui/SegmentedControl';
import { FilterInput } from '../ui/FilterInput';
import { ToggleSwitch } from '../ui/ToggleSwitch';
import { MiniBadge } from '../ui/MiniBadge';
import { GhostIconButton } from '../ui/GhostIconButton';
import { notifyToast } from '../../stores/notificationStore';
import { formatDurationCompact } from '../../../shared/duration';
import { appRuleMatches } from '../../../shared/computer-history/rules';
import type { AppActivity } from '../../../shared/computer-history/reader';
import type {
	AppCaptureMode,
	CaptureRule,
	CaptureRuleAction,
	ComputerHistoryConfig,
} from '../../../shared/computer-history/types';

interface CaptureRulesEditorProps {
	theme: Theme;
	/** Fires after every successful change with the saved config. */
	onConfigChange?: (config: ComputerHistoryConfig) => void;
	/** Cap the app list's height (px) when embedded in a scrolling pane. */
	listMaxHeight?: number;
}

const MODE_OPTIONS = [
	{
		value: 'exclude' as const,
		label: 'All apps except...',
		title: 'Record every app except the ones you switch off',
	},
	{
		value: 'include' as const,
		label: 'Only these apps',
		title: 'Record nothing but the apps you switch on',
	},
];

/** One row of the app list: a known app, or a rule naming an app not seen lately. */
interface AppRow {
	id: string;
	name: string;
	activity: AppActivity | null;
	ignoreRules: CaptureRule[];
	recordRules: CaptureRule[];
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Whether `row` is recorded under `mode`. */
export function isAppRecorded(
	mode: AppCaptureMode,
	row: { ignoreRules: readonly unknown[]; recordRules: readonly unknown[] }
): boolean {
	if (row.ignoreRules.length > 0) return false;
	return mode === 'exclude' || row.recordRules.length > 0;
}

/** Build the rows: known apps with their matching rules, plus orphan rules. */
export function buildAppRows(
	apps: readonly AppActivity[],
	rules: readonly CaptureRule[]
): AppRow[] {
	const appRules = rules.filter((r) => r.match === 'app');
	const claimed = new Set<string>();
	const rows: AppRow[] = apps.map((app) => {
		const matching = appRules.filter((r) => appRuleMatches(r.value, app));
		for (const r of matching) claimed.add(r.id);
		return {
			id: app.id,
			name: app.name,
			activity: app,
			ignoreRules: matching.filter((r) => r.action === 'ignore'),
			recordRules: matching.filter((r) => r.action === 'record'),
		};
	});
	// Rules naming an app that has not shown up lately still need a row: it
	// is the only place to see or remove them.
	const orphans = new Map<string, AppRow>();
	for (const r of appRules) {
		if (claimed.has(r.id)) continue;
		const row = orphans.get(r.value) ?? {
			id: r.value,
			name: r.value,
			activity: null,
			ignoreRules: [],
			recordRules: [],
		};
		(r.action === 'ignore' ? row.ignoreRules : row.recordRules).push(r);
		orphans.set(r.value, row);
	}
	return [...rows, ...orphans.values()];
}

export function CaptureRulesEditor({
	theme,
	onConfigChange,
	listMaxHeight = 320,
}: CaptureRulesEditorProps) {
	const api = window.maestro?.computerHistory;
	const [config, setConfig] = useState<ComputerHistoryConfig | null>(null);
	const [apps, setApps] = useState<AppActivity[]>([]);
	const [builtInCount, setBuiltInCount] = useState(0);
	const [filter, setFilter] = useState('');
	const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
	const [manualApp, setManualApp] = useState('');
	const [domainDraft, setDomainDraft] = useState('');
	const [domainError, setDomainError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		if (!api) return;
		const [cfg, known, rules] = await Promise.all([
			api.getConfig(),
			api.knownApps(),
			api.listRules(),
		]);
		setConfig(cfg);
		setApps(known);
		setBuiltInCount(rules.builtIn.length);
		return cfg;
	}, [api]);

	useEffect(() => {
		void reload().catch(() => {
			// Not available (web bridge or service down): the editor stays empty.
		});
	}, [reload]);

	/** Run a write, then reload and report. Failures toast; nothing throws. */
	const mutate = useCallback(
		async (key: string, action: () => Promise<unknown>, failureTitle: string) => {
			if (!api) return;
			setBusyIds((prev) => new Set(prev).add(key));
			try {
				await action();
			} catch (err) {
				notifyToast({ color: 'red', title: failureTitle, message: errorText(err) });
			} finally {
				setBusyIds((prev) => {
					const next = new Set(prev);
					next.delete(key);
					return next;
				});
				try {
					const cfg = await reload();
					if (cfg) onConfigChange?.(cfg);
				} catch {
					// Reload failure leaves the last good view on screen.
				}
			}
		},
		[api, reload, onConfigChange]
	);

	const mode: AppCaptureMode = config?.appMode ?? 'exclude';
	const rows = useMemo(() => buildAppRows(apps, config?.rules ?? []), [apps, config]);
	const visibleRows = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return rows;
		return rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
	}, [rows, filter]);
	const recordedCount = rows.filter((r) => isAppRecorded(mode, r)).length;
	const includeListEmpty = mode === 'include' && !config?.rules.some((r) => r.action === 'record');

	if (!api) return null;
	if (!config) {
		return <p className="text-xs opacity-70">Loading capture rules...</p>;
	}

	const setMode = (next: AppCaptureMode) =>
		void mutate('mode', () => api.setConfig({ appMode: next }), 'Could not change the app mode');

	const toggleApp = (row: AppRow, record: boolean) => {
		const removeAll = (rules: CaptureRule[]) => Promise.all(rules.map((r) => api.removeRule(r.id)));
		void mutate(
			row.id,
			async () => {
				if (record) {
					// Turning an app on always clears its ignore rules; include mode
					// also needs it on the record-only list.
					await removeAll(row.ignoreRules);
					if (mode === 'include' && row.recordRules.length === 0) {
						await api.addRule('app', row.id, 'record');
					}
				} else if (mode === 'include') {
					await removeAll(row.recordRules);
				} else {
					await api.addRule('app', row.id, 'ignore');
				}
			},
			`Could not change ${row.name}`
		);
	};

	const addManualApp = () => {
		const value = manualApp.trim();
		if (!value) return;
		const action: CaptureRuleAction = mode === 'include' ? 'record' : 'ignore';
		void mutate(
			`manual:${value}`,
			async () => {
				const added = await api.addRule('app', value, action);
				if (added.matches.length === 0) {
					notifyToast({
						color: 'yellow',
						title: 'Computer History',
						message: `"${added.rule.value}" matches no app seen recently. Rules match an app id or its exact name.`,
					});
				}
				setManualApp('');
			},
			'Could not add the app'
		);
	};

	const addDomain = () => {
		setDomainError(null);
		const value = domainDraft.trim();
		if (!value) return;
		void (async () => {
			try {
				await api.addRule('domain', value, 'ignore');
				setDomainDraft('');
				const cfg = await reload();
				if (cfg) onConfigChange?.(cfg);
			} catch (err) {
				setDomainError(errorText(err));
			}
		})();
	};

	const domainRules = config.rules.filter((r) => r.match === 'domain');
	const inputStyle = {
		borderColor: theme.colors.border,
		backgroundColor: theme.colors.bgActivity,
		color: theme.colors.textMain,
	};

	return (
		<div className="space-y-4" data-testid="computer-history-capture-editor">
			<div className="space-y-2">
				<SegmentedControl
					theme={theme}
					value={mode}
					onChange={setMode}
					options={MODE_OPTIONS}
					ariaLabel="Which apps are recorded"
					testId="computer-history-app-mode"
				/>
				<p className="text-xs opacity-70">
					{mode === 'exclude'
						? 'Every app is recorded unless you switch it off below.'
						: 'Only the apps you switch on below are recorded. Everything else is never read.'}{' '}
					Password managers, private browser windows, password fields, and Maestro itself are always
					excluded ({builtInCount} built-in app ids).
				</p>
				{includeListEmpty && (
					<div
						className="flex items-start gap-1.5 text-xs"
						style={{ color: theme.colors.warning }}
						data-testid="computer-history-include-empty"
					>
						<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
						<span>Nothing is being recorded. Switch on at least one app.</span>
					</div>
				)}
			</div>

			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<FilterInput
						theme={theme}
						value={filter}
						onChange={setFilter}
						placeholder="Filter apps"
						resultLabel={`${recordedCount} of ${rows.length} recorded`}
						className="flex-1"
					/>
				</div>
				<ul
					className="rounded border divide-y overflow-y-auto"
					style={{
						borderColor: theme.colors.border,
						maxHeight: listMaxHeight,
					}}
					data-testid="computer-history-app-list"
				>
					{visibleRows.length === 0 && (
						<li className="px-3 py-3 text-xs opacity-70">
							{rows.length === 0
								? 'No apps recorded in the last 30 days yet. Use an app for a moment, or add one by id below.'
								: 'No app matches the filter.'}
						</li>
					)}
					{visibleRows.map((row) => {
						const recorded = isAppRecorded(mode, row);
						const blockedByIgnore = mode === 'include' && row.ignoreRules.length > 0;
						return (
							<li
								key={row.id}
								className="flex items-center gap-3 px-3 py-2"
								style={{ borderColor: theme.colors.border }}
								data-testid={`computer-history-app-${row.id}`}
							>
								<div className="flex-1 min-w-0">
									<div
										className="text-sm truncate"
										style={{ color: recorded ? theme.colors.textMain : theme.colors.textDim }}
									>
										{row.name}
									</div>
									<div className="text-xs truncate" style={{ color: theme.colors.textDim }}>
										<span className="font-mono">{row.id}</span>
										{row.activity && row.activity.events > 0
											? ` - ${row.activity.activeMs > 0 ? `${formatDurationCompact(row.activity.activeMs)}, ` : ''}${row.activity.events} events in 30 days`
											: row.activity
												? ' - seen this session'
												: ' - not seen in 30 days'}
									</div>
								</div>
								{blockedByIgnore && (
									<MiniBadge
										theme={theme}
										label="Ignored"
										color={theme.colors.warning}
										title="An ignore rule wins over the record-only list. Switch the app on to clear it."
									/>
								)}
								<ToggleSwitch
									theme={theme}
									size="sm"
									checked={recorded}
									busy={busyIds.has(row.id)}
									onChange={(next) => toggleApp(row, next)}
									ariaLabel={`Record ${row.name}`}
									title={recorded ? `Stop recording ${row.name}` : `Record ${row.name}`}
								/>
							</li>
						);
					})}
				</ul>
				<div className="flex gap-2">
					<input
						type="text"
						value={manualApp}
						onChange={(e) => setManualApp(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') addManualApp();
						}}
						placeholder={
							mode === 'include'
								? 'Record an app by id or name (com.apple.Notes)'
								: 'Exclude an app by id or name (com.apple.MobileSMS)'
						}
						className="flex-1 px-2 py-1 rounded border text-sm outline-none"
						style={inputStyle}
						aria-label="App id or name"
					/>
					<button
						type="button"
						onClick={addManualApp}
						disabled={!manualApp.trim()}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border disabled:opacity-50"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							backgroundColor: theme.colors.bgActivity,
						}}
					>
						<Plus className="w-3.5 h-3.5" />
						{mode === 'include' ? 'Record' : 'Exclude'}
					</button>
				</div>
			</div>

			<div className="space-y-2">
				<div
					className="flex items-center gap-1.5 text-sm font-medium"
					style={{ color: theme.colors.textMain }}
				>
					<Globe className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
					Domains never recorded
				</div>
				<p className="text-xs opacity-70">
					Applies in both modes, to the domain and its subdomains. A browser window on one records
					nothing, not even its title.
				</p>
				{domainRules.length > 0 && (
					<ul className="space-y-1">
						{domainRules.map((rule) => (
							<li key={rule.id} className="flex items-center justify-between text-sm">
								<span
									className="flex items-center gap-1.5"
									style={{ color: theme.colors.textMain }}
								>
									<Lock className="w-3 h-3" style={{ color: theme.colors.textDim }} />
									<code>{rule.value}</code>
								</span>
								<GhostIconButton
									onClick={() =>
										void mutate(
											rule.id,
											() => api.removeRule(rule.id),
											'Could not remove the domain'
										)
									}
									ariaLabel={`Remove domain ${rule.value}`}
									title={`Stop excluding ${rule.value}`}
									color={theme.colors.textDim}
								>
									<Trash2 className="w-3.5 h-3.5" />
								</GhostIconButton>
							</li>
						))}
					</ul>
				)}
				<div className="flex gap-2">
					<input
						type="text"
						value={domainDraft}
						onChange={(e) => setDomainDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') addDomain();
						}}
						placeholder="bank.example.com"
						className="flex-1 px-2 py-1 rounded border text-sm outline-none"
						style={inputStyle}
						aria-label="Domain"
					/>
					<button
						type="button"
						onClick={addDomain}
						disabled={!domainDraft.trim()}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border disabled:opacity-50"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							backgroundColor: theme.colors.bgActivity,
						}}
					>
						<Plus className="w-3.5 h-3.5" />
						Exclude
					</button>
				</div>
				{domainError && (
					<p className="text-xs" style={{ color: theme.colors.warning }}>
						{domainError}
					</p>
				)}
			</div>
		</div>
	);
}
