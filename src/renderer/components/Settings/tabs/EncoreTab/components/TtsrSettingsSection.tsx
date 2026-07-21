import { ChevronDown, Plus, X } from 'lucide-react';
import { TTSR_RULES_DIR } from '../../../../../../shared/maestro-paths';
import type { TtsrContextMode } from '../../../../../../shared/ttsr-types';
import type { Theme } from '../../../../../types';
import type { TtsrSettingsState } from '../types';

interface TtsrSettingsSectionProps {
	theme: Theme;
	ttsrEnabled: boolean;
	setTtsrEnabled: (value: boolean) => void;
	ttsrContextMode: TtsrContextMode;
	setTtsrContextMode: (value: TtsrContextMode) => void;
	ttsrDisabledRules: string[];
	ttsrState: TtsrSettingsState;
}

/**
 * Time-Traveling Stream Rules config BODY (extension detail pane, Settings
 * tab). Chromeless: the detail-pane header carries the title/state/Encore
 * enable toggle, so this owns only the runtime switch, the interrupt teardown
 * mode, and the globally-disabled rule list.
 */
export function TtsrSettingsSection({
	theme,
	ttsrEnabled,
	setTtsrEnabled,
	ttsrContextMode,
	setTtsrContextMode,
	ttsrDisabledRules,
	ttsrState,
}: TtsrSettingsSectionProps) {
	return (
		<div data-setting-id="encore-ttsr" className="space-y-4">
			<div className="pt-3">
				<label className="flex items-start gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={ttsrEnabled}
						onChange={(event) => setTtsrEnabled(event.target.checked)}
						className="mt-0.5"
					/>
					<span>
						<span className="block text-sm" style={{ color: theme.colors.textMain }}>
							Watch agent output streams
						</span>
						<span className="block text-[10px] mt-0.5" style={{ color: theme.colors.textDim }}>
							Match each project&apos;s <code>{TTSR_RULES_DIR}/*.md</code> rules against live agent
							output. When off, the stream monitor is a complete no-op.
						</span>
					</span>
				</label>
			</div>

			<div>
				<label
					htmlFor="ttsr-context-mode"
					className="block text-[11px] font-medium mb-1"
					style={{ color: theme.colors.textDim }}
				>
					When a rule interrupts a turn
				</label>
				<div className="relative">
					<select
						id="ttsr-context-mode"
						value={ttsrContextMode}
						onChange={(event) => setTtsrContextMode(event.target.value as TtsrContextMode)}
						className="w-full px-3 py-2 pr-10 rounded-lg border outline-none appearance-none cursor-pointer text-sm"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						<option value="keep">Keep partial output (interrupt)</option>
						<option value="discard">Discard partial output (kill)</option>
					</select>
					<ChevronDown
						className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
						style={{ color: theme.colors.textDim }}
					/>
				</div>
				<p className="text-[10px] mt-1 opacity-70" style={{ color: theme.colors.textDim }}>
					&quot;Keep&quot; sends an interrupt so the agent commits what it already wrote before the
					corrective turn. &quot;Discard&quot; kills the process immediately to try to drop the
					partial turn. Discard is best-effort: Maestro cannot edit an external provider&apos;s
					transcript.
				</p>
			</div>

			<div>
				<label
					className="block text-xs font-bold opacity-70 uppercase mb-2"
					style={{ color: theme.colors.textMain }}
				>
					Disabled Rules
				</label>
				<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
					Rules named here are still loaded from every project but are never matched. Use the rule
					name from its frontmatter (or its filename).
				</p>

				{ttsrDisabledRules.map((rule) => (
					<div
						key={rule}
						className="flex items-center gap-2 px-2 py-1.5 rounded text-xs font-mono mb-1"
						style={{
							backgroundColor: theme.colors.bgActivity,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<span className="truncate flex-1" style={{ color: theme.colors.textMain }}>
							{rule}
						</span>
						<button
							type="button"
							onClick={() => ttsrState.removeDisabledRule(rule)}
							className="p-0.5 rounded hover:bg-white/10 transition-colors flex-shrink-0"
							style={{ color: theme.colors.error }}
							title="Re-enable this rule"
						>
							<X className="w-3 h-3" />
						</button>
					</div>
				))}

				<div className="flex items-center gap-2 mt-3">
					<div className="flex-1 relative">
						<input
							type="text"
							value={ttsrState.newDisabledRule}
							onChange={(event) => ttsrState.setNewDisabledRule(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault();
									ttsrState.addDisabledRule();
								}
							}}
							placeholder="no-console-log"
							className="w-full px-3 py-2 rounded text-sm font-mono outline-none"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: ttsrState.disabledRuleError ? theme.colors.error : theme.colors.border,
								border: '1px solid',
								color: theme.colors.textMain,
							}}
						/>
						{ttsrState.disabledRuleError && (
							<p
								className="absolute -bottom-4 left-0 text-[10px]"
								style={{ color: theme.colors.error }}
							>
								{ttsrState.disabledRuleError}
							</p>
						)}
					</div>
					<button
						type="button"
						onClick={ttsrState.addDisabledRule}
						disabled={!ttsrState.newDisabledRule.trim()}
						className="flex items-center gap-1.5 px-3 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
					>
						<Plus className="w-4 h-4" /> Disable
					</button>
				</div>
			</div>
		</div>
	);
}
