/**
 * Right Bar "Rules" tab - the project-scoped TTSR surface.
 *
 * Rules live in each project's `.maestro/rules/`, so this panel is implicitly
 * scoped to the agent the user is looking at: its `cwd` is the project root
 * every call names. That is the whole reason this lives in the Right Bar rather
 * than in Settings, which is global and cannot express "in this repo".
 *
 * Authoring is delegated to the agent. Rule files are markdown and the agent
 * already has file-writing tools, so "New Rule" sends it a brief describing the
 * schema plus what the user asked for; the agent writes the file, the rule-file
 * watcher notices, and this list refreshes. No form to outgrow, and the user can
 * follow up conversationally ("narrower", "it fires too often").
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileText, Plus, Power, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { TTSR_RULES_DIR } from '../../../shared/maestro-paths';
import { buildRuleAuthoringPrompt, isTtsrRuleApiAvailable, ttsrService } from '../../services/ttsr';
import { notifyToast } from '../../stores/notificationStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { logger } from '../../utils/logger';
import type {
	Theme,
	TtsrContextMode,
	TtsrProjectSettings,
	TtsrRule,
	TtsrRuleListEntry,
	TtsrRuleListResult,
} from '../../types';

interface TtsrRulesPanelProps {
	theme: Theme;
	/** Project root of the active agent. Null when no agent is selected. */
	projectRoot: string | null;
	/** Send a prompt to the active agent's AI tab (the authoring hand-off). */
	onSendToAgent?: (prompt: string) => void;
	/** Open a project-relative file in the editor. */
	onOpenFile?: (relativePath: string) => void;
}

const EMPTY: TtsrRuleListResult = {
	rules: [],
	settings: { enabled: true, disabledRules: [] },
	warnings: [],
	errors: [],
	configExists: false,
};

/** Coalescing window for `ttsr:rulesChanged`; one save can fire several events. */
const RULES_CHANGED_DEBOUNCE_MS = 300;

/** How long a delete stays armed before it disarms itself again. */
const DELETE_ARMED_MS = 4000;

/** Short, readable summary of what a rule watches. */
function scopeLabel(rule: TtsrRule): string {
	return rule.scope.join(', ');
}

export function TtsrRulesPanel({
	theme,
	projectRoot,
	onSendToAgent,
	onOpenFile,
}: TtsrRulesPanelProps) {
	const [data, setData] = useState<TtsrRuleListResult>(EMPTY);
	const [loading, setLoading] = useState(false);
	const [request, setRequest] = useState('');
	// Two-step confirm for delete: the trash icon sits in a hover cluster next to
	// Edit, so a single click is far too easy to fire by accident. Holds the path
	// of the rule currently armed.
	const [armedDelete, setArmedDelete] = useState<string | null>(null);
	const disarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// The global (all-projects) disable list. A rule named here cannot fire even
	// though this project says nothing about it, so the panel has to show that.
	const globalDisabled = useSettingsStore((state) => state.ttsrDisabledRules);
	const setGlobalDisabled = useSettingsStore((state) => state.setTtsrDisabledRules);

	useEffect(() => {
		return () => {
			if (disarmTimerRef.current) clearTimeout(disarmTimerRef.current);
		};
	}, []);

	const refresh = useCallback(async () => {
		if (!projectRoot || !isTtsrRuleApiAvailable()) return;
		setLoading(true);
		try {
			setData(await ttsrService.listRules(projectRoot));
		} catch (error) {
			logger.error('[TTSR] Failed to list rules', undefined, error);
			notifyToast({ color: 'red', title: 'TTSR', message: 'Could not read this project’s rules.' });
		} finally {
			setLoading(false);
		}
	}, [projectRoot]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Live re-list. Authoring is delegated to the agent, so the moment a rule
	// exists is the moment the agent writes the file - not a click in here. Main
	// pushes `ttsr:rulesChanged` when it drops the project's rule cache; without
	// this subscription the authoring loop ends on a stale list.
	useEffect(() => {
		if (!projectRoot || !isTtsrRuleApiAvailable()) return;
		// The watcher can fire several times for one save (frontmatter, body,
		// editor temp files), so coalesce rather than re-reading the directory
		// once per event.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const off = ttsrService.onRulesChanged((payload) => {
			// No projectRoot means every project was invalidated.
			if (payload.projectRoot && payload.projectRoot !== projectRoot) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => void refresh(), RULES_CHANGED_DEBOUNCE_MS);
		});
		return () => {
			if (timer) clearTimeout(timer);
			off();
		};
	}, [projectRoot, refresh]);

	const patchSettings = useCallback(
		async (patch: Partial<TtsrProjectSettings>) => {
			if (!projectRoot) return;
			try {
				await ttsrService.writeProjectSettings(projectRoot, patch);
				await refresh();
			} catch (error) {
				logger.error('[TTSR] Failed to write project settings', undefined, error);
				notifyToast({ color: 'red', title: 'TTSR', message: 'Could not save project settings.' });
			}
		},
		[projectRoot, refresh]
	);

	/**
	 * Flip one rule on or off.
	 *
	 * Disabling is a statement about this repo, so it goes in the committed
	 * `.maestro/ttsr.yaml`. Enabling has to undo whichever list is holding the
	 * rule down: the project file, the machine-wide `ttsrDisabledRules` setting,
	 * or both. Missing the second one would leave the toggle looking stuck.
	 */
	const toggleRule = useCallback(
		async (rule: TtsrRuleListEntry, projectDisabled: string[]) => {
			const globallyOff = globalDisabled.includes(rule.name);
			if (!rule.disabled && !globallyOff) {
				await patchSettings({ disabledRules: [...projectDisabled, rule.name] });
				return;
			}
			if (globallyOff) {
				setGlobalDisabled(globalDisabled.filter((name) => name !== rule.name));
			}
			if (rule.disabled) {
				await patchSettings({ disabledRules: projectDisabled.filter((n) => n !== rule.name) });
			}
		},
		[globalDisabled, patchSettings, setGlobalDisabled]
	);

	const authorRule = useCallback(
		async (instruction: string) => {
			if (!onSendToAgent) return;
			const prompt = await buildRuleAuthoringPrompt(instruction);
			onSendToAgent(prompt);
			setRequest('');
		},
		[onSendToAgent]
	);

	/** First click arms, second deletes. Deleting a rule file is not undoable. */
	const removeRule = useCallback(
		async (rule: TtsrRule) => {
			if (!projectRoot) return;
			if (disarmTimerRef.current) clearTimeout(disarmTimerRef.current);
			if (armedDelete !== rule.path) {
				setArmedDelete(rule.path);
				disarmTimerRef.current = setTimeout(() => setArmedDelete(null), DELETE_ARMED_MS);
				return;
			}
			setArmedDelete(null);
			try {
				await ttsrService.deleteRule(projectRoot, rule.path);
				await refresh();
			} catch (error) {
				logger.error('[TTSR] Failed to delete rule', undefined, error);
				notifyToast({ color: 'red', title: 'TTSR', message: `Could not delete ${rule.name}.` });
			}
		},
		[armedDelete, projectRoot, refresh]
	);

	if (!projectRoot) {
		return (
			<div className="p-4 text-xs" style={{ color: theme.colors.textDim }}>
				Select an agent to see its project’s rules.
			</div>
		);
	}

	if (!isTtsrRuleApiAvailable()) {
		return (
			<div className="p-4 text-xs" style={{ color: theme.colors.textDim }}>
				Rule management is not available in this build.
			</div>
		);
	}

	const { rules, settings, warnings, errors } = data;

	return (
		<div className="flex flex-col h-full overflow-y-auto select-none">
			{/* Per-project settings. These write .maestro/ttsr.yaml, which is
			    committed with the repo - so they are the team's choice, not the
			    user's machine-wide one. */}
			<div className="px-3 py-3 border-b space-y-2" style={{ borderColor: theme.colors.border }}>
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={settings.enabled}
						onChange={(e) => void patchSettings({ enabled: e.target.checked })}
					/>
					<span className="text-xs" style={{ color: theme.colors.textMain }}>
						Rules active in this project
					</span>
				</label>

				<div className="flex items-center gap-2">
					<span className="text-[10px] shrink-0" style={{ color: theme.colors.textDim }}>
						On interrupt
					</span>
					<select
						value={settings.contextMode ?? ''}
						onChange={(e) =>
							void patchSettings({
								// Empty means "say nothing here", which hands the choice back
								// to the global Settings default rather than pinning it.
								contextMode: e.target.value ? (e.target.value as TtsrContextMode) : undefined,
							})
						}
						className="flex-1 px-2 py-1 rounded text-[11px] outline-none border"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						<option value="">Use global default</option>
						<option value="keep">Keep partial output</option>
						<option value="discard">Discard partial output</option>
					</select>
				</div>
			</div>

			{/* Authoring hand-off */}
			{onSendToAgent && (
				<div className="px-3 py-3 border-b space-y-2" style={{ borderColor: theme.colors.border }}>
					<div className="flex items-center gap-1.5">
						<Sparkles className="w-3 h-3" style={{ color: theme.colors.accent }} />
						<span
							className="text-[10px] font-bold uppercase"
							style={{ color: theme.colors.textDim }}
						>
							Ask the agent for a rule
						</span>
					</div>
					<textarea
						value={request}
						onChange={(e) => setRequest(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && request.trim()) {
								e.preventDefault();
								void authorRule(request);
							}
						}}
						rows={2}
						placeholder="stop you from force-pushing to main"
						className="w-full px-2 py-1.5 rounded text-[11px] outline-none border resize-none select-text"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
					<button
						type="button"
						onClick={() => void authorRule(request)}
						disabled={!request.trim()}
						className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11px] font-medium transition-colors disabled:opacity-50"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
					>
						<Plus className="w-3 h-3" /> Write this rule
					</button>
				</div>
			)}

			{/* Load problems. A rule that parsed but can never fire is otherwise
			    completely silent, so these are shown rather than logged away. */}
			{(errors.length > 0 || warnings.length > 0) && (
				<div className="px-3 py-2 border-b space-y-1" style={{ borderColor: theme.colors.border }}>
					{[...errors, ...warnings].map((message) => (
						<div key={message} className="flex items-start gap-1.5">
							<AlertTriangle
								className="w-3 h-3 mt-0.5 shrink-0"
								style={{
									color: errors.includes(message) ? theme.colors.error : theme.colors.warning,
								}}
							/>
							<span
								className="text-[10px] leading-snug select-text"
								style={{ color: theme.colors.textDim }}
							>
								{message}
							</span>
						</div>
					))}
				</div>
			)}

			{/* Rule list */}
			<div className="flex-1">
				<div className="flex items-center justify-between px-3 py-2">
					<span className="text-[10px] font-bold uppercase" style={{ color: theme.colors.textDim }}>
						{rules.length} rule{rules.length === 1 ? '' : 's'}
					</span>
					<button
						type="button"
						onClick={() => void refresh()}
						className="p-1 rounded hover:bg-white/10 transition-colors"
						title="Reload rules from disk"
						style={{ color: theme.colors.textDim }}
					>
						<RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
					</button>
				</div>

				{rules.length === 0 ? (
					<div
						className="px-3 pb-3 text-[11px] leading-relaxed"
						style={{ color: theme.colors.textDim }}
					>
						No rules in this project yet. Rules live in <code>{TTSR_RULES_DIR}/</code> and are
						committed with the repo, so they apply to everyone working in it.
					</div>
				) : (
					rules.map((rule) => {
						// Either list can hold a rule down, and both read as "off" here.
						const off = rule.disabled || globalDisabled.includes(rule.name);
						const armed = armedDelete === rule.path;
						return (
							<div
								key={rule.path}
								className="px-3 py-2 border-b group"
								style={{ borderColor: theme.colors.border, opacity: off ? 0.5 : 1 }}
							>
								<div className="flex items-start justify-between gap-2">
									<div className="min-w-0 flex-1">
										<div
											className="text-xs font-medium truncate select-text"
											style={{ color: theme.colors.textMain }}
										>
											{rule.name}
										</div>
										<div
											className="text-[10px] leading-snug mt-0.5 select-text"
											style={{ color: theme.colors.textDim }}
										>
											{rule.description}
										</div>
										<div
											className="text-[10px] mt-1 font-mono"
											style={{ color: theme.colors.textDim }}
										>
											{scopeLabel(rule)} · {rule.interruptMode}
											{off ? ' · disabled' : ''}
										</div>
									</div>
									<div className="flex items-center gap-0.5">
										<div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
											{onOpenFile && (
												<button
													type="button"
													onClick={() => onOpenFile(rule.path)}
													className="p-1 rounded hover:bg-white/10"
													title="Open rule file"
													style={{ color: theme.colors.textDim }}
												>
													<FileText className="w-3 h-3" />
												</button>
											)}
											{onSendToAgent && (
												<button
													type="button"
													onClick={() =>
														void authorRule(
															`Edit the existing rule at \`${rule.path}\`. Read it first, then change it as follows: `
														)
													}
													className="p-1 rounded hover:bg-white/10"
													title="Ask the agent to edit this rule"
													style={{ color: theme.colors.textDim }}
												>
													<Sparkles className="w-3 h-3" />
												</button>
											)}
											<button
												type="button"
												onClick={() => void removeRule(rule)}
												className="p-1 rounded hover:bg-white/10"
												title={
													armed
														? `Click again to delete ${rule.name} - this removes the file`
														: 'Delete rule'
												}
												aria-label={armed ? `Confirm delete ${rule.name}` : `Delete ${rule.name}`}
												style={{ color: armed ? theme.colors.warning : theme.colors.error }}
											>
												<Trash2 className="w-3 h-3" />
											</button>
										</div>
										{/* Always visible, unlike the cluster above: a rule whose switch
										    only appears on hover is one a user cannot find. */}
										<button
											type="button"
											onClick={() => void toggleRule(rule, settings.disabledRules)}
											className="p-1 rounded hover:bg-white/10"
											title={
												off ? 'Rule is off - click to enable' : 'Rule is on - click to disable'
											}
											aria-label={`${off ? 'Enable' : 'Disable'} ${rule.name}`}
											aria-pressed={!off}
											style={{ color: off ? theme.colors.textDim : theme.colors.success }}
										>
											<Power className="w-3 h-3" />
										</button>
									</div>
								</div>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}
