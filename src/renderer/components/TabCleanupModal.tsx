/**
 * TabCleanupModal - "Tab Cleanup Suggestions".
 *
 * Asks the Tab cleanup Local Models assignment which tabs, across every agent,
 * could be closed, snoozed, or brought back from snooze, and lists what came
 * back. It is a list of SUGGESTIONS: every row starts unticked, and nothing
 * happens to any tab until the user ticks it and presses Apply. Losing a tab
 * is the worst thing this app can do to someone, so no row is ever pre-ticked
 * on a model's say-so.
 *
 * The rows are checked against the live tabs, not the list main read: a tab
 * that started a turn, was starred, or gained a draft since then is drawn
 * disabled with the reason, and one that is gone is not drawn at all. Applying
 * goes through `applyTabCleanupSuggestions`, which checks again.
 *
 * Reached from the command palette, the hamburger menu, a bindable shortcut,
 * and `maestro-cli open tab-cleanup`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { EmptyStatePlaceholder, MiniBadge, Modal, Spinner } from './ui';
import { MODAL_BUTTON_BASE_CLASS, MODAL_BUTTON_SECONDARY_CLASS } from './ui/Modal';
import { useSessionStore } from '../stores/sessionStore';
import { getModalActions } from '../stores/modalStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { notifyToast } from '../stores/notificationStore';
import {
	applyTabCleanupSuggestions,
	describeTabCleanupOutcome,
	resolveTabCleanupLiveState,
	tabCleanupSuggestionKey,
} from '../services/tabCleanup';
import {
	describeTabCleanupCoverage,
	describeTabCleanupProtection,
	formatTabCleanupAge,
	type TabCleanupAction,
	type TabCleanupResult,
} from '../../shared/tabCleanup';
import { taskAssignmentPanel } from '../../shared/local-models/settings-location';
import { SNOOZE_PRESETS, formatSnoozeTarget, parseSnoozeInput } from '../../shared/snooze';

export interface TabCleanupModalProps {
	theme: Theme;
	onClose: () => void;
}

const ACTION_LABELS: Record<TabCleanupAction, string> = {
	close: 'Close',
	snooze: 'Snooze',
	wake: 'Wake',
};

/** The preset a batch snooze starts on, when it is still in the future. */
const DEFAULT_SNOOZE_PRESET_ID = 'tomorrow';

function actionColor(action: TabCleanupAction, theme: Theme): string {
	switch (action) {
		case 'close':
			return theme.colors.error;
		case 'snooze':
			return theme.colors.warning;
		case 'wake':
			return theme.colors.success;
	}
}

export function TabCleanupModal({ theme, onClose }: TabCleanupModalProps) {
	const sessions = useSessionStore((state) => state.sessions);

	const [result, setResult] = useState<TabCleanupResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
	const [appliedKeys, setAppliedKeys] = useState<ReadonlySet<string>>(() => new Set());
	const [now, setNow] = useState(() => Date.now());

	// Each request takes the next number; only the newest may write state, and
	// none may after the modal closed.
	const latestRequest = useRef(0);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const ask = useCallback(async () => {
		const request = ++latestRequest.current;
		setLoading(true);
		setChecked(new Set());
		setAppliedKeys(new Set());
		let next: TabCleanupResult;
		try {
			next = await window.maestro.localModels.suggestTabCleanup();
		} catch (error) {
			next = {
				success: false,
				status: 'unavailable',
				error: error instanceof Error ? error.message : String(error),
			};
		}
		if (!mounted.current || request !== latestRequest.current) return;
		setResult(next);
		setNow(Date.now());
		setLoading(false);
	}, []);

	useEffect(() => {
		void ask();
	}, [ask]);

	// Rows, each with what its tab looks like right now. A tab that is gone, or
	// that this modal already acted on, is not a row.
	const rows = useMemo(() => {
		if (!result?.success) return [];
		return result.suggestions
			.map((suggestion) => ({
				suggestion,
				key: tabCleanupSuggestionKey(suggestion),
				live: resolveTabCleanupLiveState(sessions, suggestion),
			}))
			.filter((row) => row.live.status !== 'gone' && !appliedKeys.has(row.key));
	}, [result, sessions, appliedKeys]);

	const selectableKeys = useMemo(
		() => rows.filter((row) => row.live.status === 'ok').map((row) => row.key),
		[rows]
	);
	// A row that became protected after it was ticked no longer counts.
	const selected = useMemo(
		() => rows.filter((row) => row.live.status === 'ok' && checked.has(row.key)),
		[rows, checked]
	);
	const allSelected = selectableKeys.length > 0 && selected.length === selectableKeys.length;

	const toggle = useCallback((key: string) => {
		setChecked((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	const toggleAll = useCallback(() => {
		setChecked(allSelected ? new Set() : new Set(selectableKeys));
	}, [allSelected, selectableKeys]);

	// Presets that resolve to a future moment, as the Snooze Tab dialog offers.
	const snoozePresets = useMemo(
		() => SNOOZE_PRESETS.filter((preset) => parseSnoozeInput(preset.expression, now).ok),
		[now]
	);
	const [snoozePresetId, setSnoozePresetId] = useState(DEFAULT_SNOOZE_PRESET_ID);
	const snoozePreset =
		snoozePresets.find((preset) => preset.id === snoozePresetId) ?? snoozePresets[0] ?? null;
	const snoozeSelected = selected.some((row) => row.suggestion.action === 'snooze');
	const hasSnoozeRow = rows.some((row) => row.suggestion.action === 'snooze');

	const handleApply = useCallback(() => {
		if (selected.length === 0) return;
		// Resolved at the click, so "tomorrow" means tomorrow from now and not
		// from whenever the modal was opened.
		const resolved = snoozePreset ? parseSnoozeInput(snoozePreset.expression, Date.now()) : null;
		const outcome = applyTabCleanupSuggestions(
			selected.map((row) => row.suggestion),
			resolved?.ok ? { snoozeUntil: resolved.at } : {}
		);

		if (outcome.applied.length > 0) {
			notifyCenterFlash({ message: describeTabCleanupOutcome(outcome.applied), color: 'green' });
		}
		if (outcome.skipped.length > 0) {
			notifyToast({
				color: 'yellow',
				title: 'Some tabs were left alone',
				message: `${outcome.skipped.length} ${
					outcome.skipped.length === 1 ? 'suggestion was' : 'suggestions were'
				} skipped because the tab changed since the list was made.`,
			});
		}

		const done = new Set(outcome.applied.map(tabCleanupSuggestionKey));
		const remaining = rows.filter((row) => !done.has(row.key)).length;
		if (remaining === 0) {
			onClose();
			return;
		}
		setAppliedKeys((previous) => new Set([...previous, ...done]));
		setChecked(new Set());
	}, [selected, snoozePreset, rows, onClose]);

	const openAssignments = useCallback(() => {
		onClose();
		getModalActions().openSettings('models', undefined, taskAssignmentPanel('tab-cleanup'));
	}, [onClose]);

	const failure = result && !result.success ? result : null;
	const success = result?.success ? result : null;

	return (
		<Modal
			theme={theme}
			title="Tab Cleanup Suggestions"
			headerIcon={<Sparkles className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.TAB_CLEANUP}
			onClose={onClose}
			width={640}
			resizeKey="modal-tab-cleanup"
			testId="tab-cleanup-modal"
			headerActions={
				<button
					type="button"
					onClick={() => void ask()}
					disabled={loading}
					className="flex items-center gap-1.5 px-2 py-1 rounded text-xs hover:bg-white/10 transition-colors disabled:opacity-50"
					style={{ color: theme.colors.textDim }}
					title="Ask the model again"
				>
					<RefreshCw className="w-3.5 h-3.5" />
					Refresh
				</button>
			}
			footer={
				<div className="flex items-center gap-3 w-full">
					{hasSnoozeRow && snoozePreset && (
						<label
							className="flex items-center gap-1.5 text-xs"
							style={{ color: theme.colors.textDim }}
						>
							Snooze until
							<select
								value={snoozePreset.id}
								onChange={(e) => setSnoozePresetId(e.target.value)}
								disabled={!snoozeSelected}
								className="rounded px-1.5 py-1 text-xs border outline-none disabled:opacity-50"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								data-testid="tab-cleanup-snooze-until"
							>
								{snoozePresets.map((preset) => (
									<option key={preset.id} value={preset.id}>
										{preset.label}
									</option>
								))}
							</select>
						</label>
					)}
					<div className="flex-1" />
					<button
						type="button"
						onClick={onClose}
						className={MODAL_BUTTON_SECONDARY_CLASS}
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleApply}
						disabled={selected.length === 0}
						className={`${MODAL_BUTTON_BASE_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`}
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						data-testid="tab-cleanup-apply"
					>
						{selected.length > 0 ? `Apply ${selected.length}` : 'Apply'}
					</button>
				</div>
			}
		>
			{/* Click-driven list: suppress drag-select, opt the prose back in per row. */}
			<div className="select-none">
				{loading ? (
					<div
						className="flex flex-col items-center gap-3 py-10 text-center"
						style={{ color: theme.colors.textDim }}
						data-testid="tab-cleanup-loading"
					>
						<Spinner size={20} color={theme.colors.accent} />
						<div className="text-sm">Reviewing your tabs...</div>
					</div>
				) : failure ? (
					<EmptyStatePlaceholder
						theme={theme}
						icon={<Sparkles className="w-8 h-8" />}
						title={
							failure.status === 'off'
								? 'Tab cleanup suggestions is off'
								: 'No suggestions this time'
						}
						description={failure.error}
						action={
							failure.status === 'off' || failure.status === 'unavailable' ? (
								<button
									type="button"
									onClick={openAssignments}
									className={MODAL_BUTTON_SECONDARY_CLASS}
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									Open Models Settings
								</button>
							) : undefined
						}
						verticalPadding="py-8"
					/>
				) : rows.length === 0 ? (
					<EmptyStatePlaceholder
						theme={theme}
						icon={<Sparkles className="w-8 h-8" />}
						title="Nothing to clean up"
						description={
							success && success.considered === 0
								? 'There are no idle tabs to review.'
								: 'The model found no tab worth closing, snoozing, or waking.'
						}
						verticalPadding="py-8"
					/>
				) : (
					<>
						<label
							className="flex items-center gap-2 px-3 pb-2 text-xs cursor-pointer"
							style={{ color: theme.colors.textDim }}
						>
							<input
								type="checkbox"
								className="rounded"
								checked={allSelected}
								disabled={selectableKeys.length === 0}
								onChange={toggleAll}
								data-testid="tab-cleanup-select-all"
							/>
							Select all
						</label>
						<div className="flex flex-col gap-1.5">
							{rows.map(({ suggestion, key, live }) => {
								const protection = live.status === 'protected' ? live.protection : null;
								return (
									<label
										key={key}
										className={`flex items-start gap-3 rounded px-3 py-2.5 ${
											protection ? 'opacity-60' : 'cursor-pointer'
										}`}
										style={{
											backgroundColor: theme.colors.bgActivity,
											border: `1px solid ${theme.colors.border}`,
										}}
										data-testid="tab-cleanup-row"
									>
										<input
											type="checkbox"
											className="rounded mt-0.5"
											checked={!protection && checked.has(key)}
											disabled={protection !== null}
											onChange={() => toggle(key)}
											aria-label={`${ACTION_LABELS[suggestion.action]} ${suggestion.label}`}
										/>
										<div className="flex-1 min-w-0 select-text">
											<div className="flex items-center gap-1.5 min-w-0">
												<MiniBadge
													label={ACTION_LABELS[suggestion.action]}
													theme={theme}
													color={actionColor(suggestion.action, theme)}
												/>
												<div
													className="text-sm truncate"
													style={{ color: theme.colors.textMain }}
													title={suggestion.label}
												>
													{suggestion.label}
												</div>
											</div>
											<div
												className="flex items-center gap-1.5 text-xs mt-0.5"
												style={{ color: theme.colors.textDim }}
											>
												<span className="truncate">{suggestion.agentName}</span>
												<span>·</span>
												<span className="whitespace-nowrap">
													{suggestion.kind === 'snoozed' && suggestion.wakeAt !== undefined
														? `snoozed until ${formatSnoozeTarget(suggestion.wakeAt, now)}`
														: `last active ${formatTabCleanupAge(suggestion.lastActivityAt, now)}`}
												</span>
												{suggestion.tabType === 'ai' && (
													<>
														<span>·</span>
														<span className="whitespace-nowrap">
															{suggestion.messageCount}{' '}
															{suggestion.messageCount === 1 ? 'message' : 'messages'}
														</span>
													</>
												)}
											</div>
											{suggestion.reason && (
												<div className="text-xs mt-1.5" style={{ color: theme.colors.textMain }}>
													{suggestion.reason}
												</div>
											)}
											{protection && (
												<div className="text-xs mt-1.5" style={{ color: theme.colors.warning }}>
													{describeTabCleanupProtection(protection)} It will be left alone.
												</div>
											)}
										</div>
									</label>
								);
							})}
						</div>
					</>
				)}

				{!loading && success && (
					<div
						className="text-xs mt-3"
						style={{ color: theme.colors.textDim }}
						data-testid="tab-cleanup-coverage"
					>
						{describeTabCleanupCoverage(success)}
						{success.producedBy ? `. Suggested by ${success.producedBy}.` : '.'} Closed tabs can be
						brought back with Reopen Closed Tab.
					</div>
				)}
			</div>
		</Modal>
	);
}
