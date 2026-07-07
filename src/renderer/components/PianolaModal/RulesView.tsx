import { Plus, Trash2, Pencil, AlertTriangle } from 'lucide-react';
import type { Theme } from '../../types';
import type { PianolaRule } from '../../../shared/pianola/types';
import { ACTION_META, describeRuleMatch, scopeLabel } from './shared';

interface RulesViewProps {
	theme: Theme;
	rules: PianolaRule[];
	loading: boolean;
	/** True when the on-disk rules file is corrupt; editing is disabled to avoid clobbering it. */
	malformed: boolean;
	onAdd: () => void;
	onEdit: (rule: PianolaRule) => void;
	onToggle: (id: string) => void;
	onDelete: (id: string) => void;
}

export function RulesView({
	theme,
	rules,
	loading,
	malformed,
	onAdd,
	onEdit,
	onToggle,
	onDelete,
}: RulesViewProps) {
	return (
		<div className="p-4 space-y-3">
			{malformed && (
				<div
					className="flex items-start gap-2 rounded-md border p-3 text-xs select-text"
					style={{ borderColor: '#f59e0b55', backgroundColor: '#f59e0b15', color: '#f59e0b' }}
				>
					<AlertTriangle className="w-4 h-4 shrink-0" />
					<span>
						The rules file on disk is malformed and could not be parsed. Editing is disabled here so
						it is not overwritten. Fix or remove the file, then refresh.
					</span>
				</div>
			)}
			<div className="flex items-center justify-between">
				<p className="text-xs max-w-xl" style={{ color: theme.colors.textDim }}>
					Rules let Pianola auto-answer low-risk prompts. High-risk prompts always escalate to you,
					no matter the rules. An auto-answer rule needs a narrowing condition (max risk, kind, or
					topic) and reply text.
				</p>
				<button
					onClick={onAdd}
					disabled={malformed}
					className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md shrink-0 transition-colors"
					style={{
						backgroundColor: malformed ? theme.colors.border : theme.colors.accent,
						color: malformed ? theme.colors.textDim : theme.colors.bgMain,
						cursor: malformed ? 'not-allowed' : 'pointer',
					}}
				>
					<Plus className="w-4 h-4" />
					Add rule
				</button>
			</div>

			{rules.length === 0 ? (
				<div className="text-sm text-center py-12" style={{ color: theme.colors.textDim }}>
					{loading ? 'Loading...' : 'No rules yet. Without rules, Pianola escalates everything.'}
				</div>
			) : (
				<div className="space-y-2">
					{rules.map((rule) => {
						const meta = ACTION_META[rule.action];
						return (
							<div
								key={rule.id}
								className="rounded-lg border p-3 flex items-start gap-3"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									opacity: rule.enabled ? 1 : 0.55,
								}}
							>
								{/* Enable toggle */}
								<button
									onClick={() => onToggle(rule.id)}
									className="mt-0.5 shrink-0 rounded-full transition-colors"
									style={{
										width: 36,
										height: 20,
										backgroundColor: rule.enabled ? theme.colors.accent : theme.colors.border,
										position: 'relative',
									}}
									aria-label={rule.enabled ? 'Disable rule' : 'Enable rule'}
									title={rule.enabled ? 'Enabled' : 'Disabled'}
								>
									<span
										className="block rounded-full transition-transform"
										style={{
											width: 16,
											height: 16,
											backgroundColor: '#fff',
											position: 'absolute',
											top: 2,
											left: 2,
											transform: rule.enabled ? 'translateX(16px)' : 'translateX(0)',
										}}
									/>
								</button>

								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<meta.Icon className="w-4 h-4 shrink-0" style={{ color: meta.color }} />
										<span className="text-sm font-medium" style={{ color: meta.color }}>
											{meta.label}
										</span>
										<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
											{scopeLabel(rule)}
										</span>
										<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
											priority {rule.priority}
										</span>
									</div>
									<div
										className="mt-1 text-xs select-text"
										style={{ color: theme.colors.textMain }}
									>
										when {describeRuleMatch(rule)}
									</div>
									{rule.action === 'auto_answer' && rule.answer && (
										<div
											className="mt-0.5 text-xs select-text"
											style={{ color: theme.colors.textDim }}
										>
											reply: &ldquo;{rule.answer}&rdquo;
										</div>
									)}
									{rule.description && (
										<div
											className="mt-0.5 text-[11px] select-text"
											style={{ color: theme.colors.textDim }}
										>
											{rule.description}
										</div>
									)}
								</div>

								<div className="flex items-center gap-1 shrink-0">
									<button
										onClick={() => onEdit(rule)}
										className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textDim }}
										aria-label="Edit rule"
										title="Edit"
									>
										<Pencil className="w-4 h-4" />
									</button>
									<button
										onClick={() => onDelete(rule.id)}
										className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
										style={{ color: '#ef4444' }}
										aria-label="Delete rule"
										title="Delete"
									>
										<Trash2 className="w-4 h-4" />
									</button>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
