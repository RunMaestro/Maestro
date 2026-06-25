import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
	X,
	Music,
	ShieldAlert,
	Send,
	Ban,
	Plus,
	Trash2,
	Pencil,
	RefreshCw,
	AlertTriangle,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	PianolaRule,
	PianolaRuleScope,
	PianolaSignalKind,
	PianolaActionKind,
	PianolaRisk,
} from '../../../shared/pianola/types';
import type { PianolaDecisionRecord } from '../../../shared/pianola/storage';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { generateId } from '../../utils/ids';
import { notifyToast } from '../../stores/notificationStore';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { RuleEditor } from './RuleEditor';

/** A 'PianolaDisabled' rejection is the expected feature-off path, not a bug. */
function isExpectedError(error: unknown): boolean {
	return error instanceof Error && error.message.includes('PianolaDisabled');
}

export interface PianolaModalProps {
	theme: Theme;
	onClose: () => void;
}

type PianolaTab = 'decisions' | 'rules';
type DecisionFilter = 'all' | 'escalate' | 'auto_answer';

const ACTION_META: Record<PianolaActionKind, { label: string; color: string; Icon: typeof Send }> =
	{
		auto_answer: { label: 'Auto-answered', color: '#22c55e', Icon: Send },
		escalate: { label: 'Escalated', color: '#f59e0b', Icon: ShieldAlert },
		ignore: { label: 'Ignored', color: '#94a3b8', Icon: Ban },
	};

const RISK_COLOR: Record<PianolaRisk, string> = {
	low: '#22c55e',
	medium: '#f59e0b',
	high: '#ef4444',
};

/** One-line, human-readable summary of a rule's match conditions. */
export function describeRuleMatch(rule: PianolaRule): string {
	const parts: string[] = [];
	if (rule.match.maxRisk) parts.push(`risk <= ${rule.match.maxRisk}`);
	if (rule.match.kinds && rule.match.kinds.length > 0)
		parts.push(`kind: ${rule.match.kinds.join(', ')}`);
	if (rule.match.topicIncludes && rule.match.topicIncludes.length > 0)
		parts.push(`topic ~ ${rule.match.topicIncludes.join(' / ')}`);
	return parts.length > 0 ? parts.join('  -  ') : 'any prompt';
}

function scopeLabel(rule: PianolaRule): string {
	if (rule.scope === 'global') return 'global';
	if (rule.scope === 'project') return `project: ${rule.scopeId ?? '(unset)'}`;
	return `tab: ${rule.scopeId ?? '(unset)'}`;
}

/**
 * Pianola dashboard. Two tabs: the decision audit log (what Pianola did and what
 * it escalated) and the editable auto-answer rules. Reads and writes the same
 * files the CLI watcher uses, via the gated `window.maestro.pianola` bridge.
 */
export function PianolaModal({ theme, onClose }: PianolaModalProps) {
	useModalLayer(MODAL_PRIORITIES.PIANOLA_MODAL, 'Pianola', onClose);

	const [tab, setTab] = useState<PianolaTab>('decisions');
	const [rules, setRules] = useState<PianolaRule[]>([]);
	const [decisions, setDecisions] = useState<PianolaDecisionRecord[]>([]);
	const [filter, setFilter] = useState<DecisionFilter>('all');
	const [loading, setLoading] = useState(true);
	const [editing, setEditing] = useState<PianolaRule | null>(null);
	const [creating, setCreating] = useState(false);
	// True when the rules file exists but is unparseable. We then block writes so
	// a corrupt hand-edited file is not silently overwritten with an empty list.
	const [rulesMalformed, setRulesMalformed] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const [rulesResult, loadedDecisions] = await Promise.all([
				window.maestro.pianola.getRules(),
				window.maestro.pianola.getDecisions(500),
			]);
			setRules(rulesResult.rules);
			setRulesMalformed(rulesResult.malformed);
			setDecisions(loadedDecisions);
			if (rulesResult.malformed) {
				notifyToast({
					color: 'orange',
					title: 'Pianola',
					message: 'The rules file could not be parsed. Fix it on disk; editing is disabled.',
					dismissible: true,
				});
			}
		} catch (error) {
			logger.error('[Pianola] Failed to load', undefined, error);
			if (!isExpectedError(error)) void captureException(error, { tags: { feature: 'pianola' } });
			notifyToast({
				color: 'red',
				title: 'Pianola',
				message: 'Could not load rules and decisions.',
			});
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const persistRules = useCallback(
		async (next: PianolaRule[]) => {
			// Refuse to write over a file we could not read, to avoid clobbering it.
			if (rulesMalformed) {
				notifyToast({
					color: 'orange',
					title: 'Pianola',
					message: 'Rules file is malformed. Fix it on disk before editing here.',
				});
				return false;
			}
			try {
				const saved = await window.maestro.pianola.saveRules(next);
				setRules(saved);
				return true;
			} catch (error) {
				logger.error('[Pianola] Failed to save rules', undefined, error);
				if (!isExpectedError(error)) void captureException(error, { tags: { feature: 'pianola' } });
				notifyToast({ color: 'red', title: 'Pianola', message: 'Could not save rules.' });
				void load();
				return false;
			}
		},
		[load, rulesMalformed]
	);

	const handleToggleRule = useCallback(
		(id: string) => {
			const next = rules.map((r) =>
				r.id === id ? { ...r, enabled: !r.enabled, updatedAt: Date.now() } : r
			);
			void persistRules(next);
		},
		[rules, persistRules]
	);

	const handleDeleteRule = useCallback(
		(id: string) => {
			void persistRules(rules.filter((r) => r.id !== id));
		},
		[rules, persistRules]
	);

	const handleSaveRule = useCallback(
		async (rule: PianolaRule) => {
			const exists = rules.some((r) => r.id === rule.id);
			const next = exists ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule];
			const ok = await persistRules(next);
			if (ok) {
				setEditing(null);
				setCreating(false);
			}
		},
		[rules, persistRules]
	);

	const sortedRules = useMemo(
		() => [...rules].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt),
		[rules]
	);

	const filteredDecisions = useMemo(() => {
		const view =
			filter === 'all' ? decisions : decisions.filter((d) => d.decision.action === filter);
		// Most recent first for reading.
		return [...view].reverse();
	}, [decisions, filter]);

	const escalationCount = useMemo(
		() => decisions.filter((d) => d.decision.action === 'escalate').length,
		[decisions]
	);

	return createPortal(
		<div
			className="fixed inset-0 flex items-center justify-center select-none"
			style={{ zIndex: MODAL_PRIORITIES.PIANOLA_MODAL }}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="absolute inset-0 bg-black/50" />

			<div
				className="relative rounded-xl shadow-2xl flex flex-col"
				style={{
					width: '92vw',
					maxWidth: 980,
					height: '86vh',
					maxHeight: 920,
					backgroundColor: theme.colors.bgMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				{/* Header */}
				<div
					className="shrink-0 flex items-center justify-between px-5 py-4 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<Music className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h2 className="text-base font-bold" style={{ color: theme.colors.textMain }}>
							Pianola
						</h2>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							autonomous manager
						</span>
					</div>
					<div className="flex items-center gap-1">
						<button
							onClick={() => void load()}
							className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							aria-label="Refresh"
							title="Refresh"
						>
							<RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
						</button>
						<button
							onClick={onClose}
							className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							aria-label="Close"
							title="Close"
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				</div>

				{/* Tabs */}
				<div
					className="shrink-0 flex items-center gap-1 px-4 pt-3 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					{(
						[
							['decisions', `Decisions${escalationCount ? ` (${escalationCount} escalated)` : ''}`],
							['rules', `Rules (${rules.length})`],
						] as const
					).map(([id, label]) => (
						<button
							key={id}
							onClick={() => setTab(id)}
							className="px-3 py-2 text-sm font-medium rounded-t-md transition-colors"
							style={{
								color: tab === id ? theme.colors.textMain : theme.colors.textDim,
								borderBottom: `2px solid ${tab === id ? theme.colors.accent : 'transparent'}`,
							}}
						>
							{label}
						</button>
					))}
				</div>

				{/* Body */}
				<div className="flex-1 overflow-y-auto scrollbar-thin">
					{tab === 'decisions' ? (
						<DecisionsView
							theme={theme}
							decisions={filteredDecisions}
							filter={filter}
							onFilterChange={setFilter}
							loading={loading}
						/>
					) : (
						<RulesView
							theme={theme}
							rules={sortedRules}
							loading={loading}
							malformed={rulesMalformed}
							onAdd={() => setCreating(true)}
							onEdit={setEditing}
							onToggle={handleToggleRule}
							onDelete={handleDeleteRule}
						/>
					)}
				</div>

				{/* Footer: how the autonomous runtime is started. Pianola watches and
				    answers agents from the CLI watcher; this dashboard configures the
				    rules it uses and shows what it did. */}
				<div
					className="shrink-0 px-5 py-2.5 border-t text-[11px] select-text"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					Pianola watches an agent and acts on these rules when you run{' '}
					<code
						className="px-1 rounded"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
					>
						maestro pianola watch &lt;tab-id&gt;
					</code>
					. Every decision it makes, here or from the CLI, is recorded above.
				</div>
			</div>

			{/* Rule editor (create or edit) */}
			{(creating || editing) && (
				<RuleEditor
					key={editing?.id ?? 'new'}
					theme={theme}
					rule={editing}
					onCancel={() => {
						setEditing(null);
						setCreating(false);
					}}
					onSave={handleSaveRule}
				/>
			)}
		</div>,
		document.body
	);
}

interface DecisionsViewProps {
	theme: Theme;
	decisions: PianolaDecisionRecord[];
	filter: DecisionFilter;
	onFilterChange: (f: DecisionFilter) => void;
	loading: boolean;
}

function DecisionsView({ theme, decisions, filter, onFilterChange, loading }: DecisionsViewProps) {
	return (
		<div className="p-4 space-y-3">
			<div className="flex items-center gap-1">
				{(
					[
						['all', 'All'],
						['escalate', 'Escalations'],
						['auto_answer', 'Auto-answered'],
					] as const
				).map(([id, label]) => (
					<button
						key={id}
						onClick={() => onFilterChange(id)}
						className="px-2.5 py-1 text-xs rounded-md transition-colors"
						style={{
							backgroundColor: filter === id ? theme.colors.accent + '22' : 'transparent',
							color: filter === id ? theme.colors.accent : theme.colors.textDim,
							border: `1px solid ${filter === id ? theme.colors.accent + '55' : theme.colors.border}`,
						}}
					>
						{label}
					</button>
				))}
			</div>

			{decisions.length === 0 ? (
				<div className="text-sm text-center py-12" style={{ color: theme.colors.textDim }}>
					{loading ? 'Loading...' : 'No decisions recorded yet.'}
				</div>
			) : (
				<div className="space-y-2 select-text">
					{decisions.map((d) => {
						const meta = ACTION_META[d.decision.action];
						return (
							<div
								key={d.id}
								className="rounded-lg border p-3"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
								}}
							>
								<div className="flex items-center justify-between gap-3">
									<div className="flex items-center gap-2 min-w-0">
										<meta.Icon className="w-4 h-4 shrink-0" style={{ color: meta.color }} />
										<span className="text-sm font-medium" style={{ color: meta.color }}>
											{meta.label}
										</span>
										<span
											className="text-xs px-1.5 py-0.5 rounded shrink-0"
											style={{
												backgroundColor: RISK_COLOR[d.classification.risk] + '22',
												color: RISK_COLOR[d.classification.risk],
											}}
										>
											{d.classification.kind} / {d.classification.risk}
										</span>
										{d.dryRun && (
											<span
												className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
												style={{
													backgroundColor: theme.colors.border,
													color: theme.colors.textDim,
												}}
											>
												dry-run
											</span>
										)}
									</div>
									<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
										{new Date(d.timestamp).toLocaleString()}
									</span>
								</div>

								{d.classification.topic && (
									<div className="mt-1.5 text-sm" style={{ color: theme.colors.textMain }}>
										{d.classification.topic}
									</div>
								)}

								<div className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
									{d.decision.reason}
									{d.decision.action === 'auto_answer' && (
										<>
											{' '}
											&rarr; replied:{' '}
											<span style={{ color: theme.colors.textMain }}>
												&ldquo;{d.decision.answer}&rdquo;
											</span>
										</>
									)}
								</div>

								<div
									className="mt-1.5 flex items-center gap-3 text-[11px]"
									style={{ color: theme.colors.textDim }}
								>
									<span>agent: {d.agentId}</span>
									<span>tab: {d.tabId}</span>
									{d.decision.action === 'auto_answer' && (
										<span style={{ color: d.dispatched ? '#22c55e' : '#ef4444' }}>
											{d.dispatched ? 'sent' : 'not sent'}
										</span>
									)}
								</div>

								{d.error && (
									<div
										className="mt-1.5 flex items-center gap-1.5 text-xs"
										style={{ color: '#ef4444' }}
									>
										<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
										{d.error}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

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

function RulesView({
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

/** Factory for a blank rule, used when creating. */
export function newBlankRule(): PianolaRule {
	const now = Date.now();
	return {
		id: generateId(),
		enabled: true,
		scope: 'global',
		match: { maxRisk: 'low', kinds: ['question'] },
		action: 'auto_answer',
		answer: '',
		priority: 100,
		createdAt: now,
		updatedAt: now,
	};
}

// Re-export the option constants so RuleEditor and tests share one source.
export const RULE_SCOPES: readonly PianolaRuleScope[] = ['global', 'project', 'tab'];
export const RULE_ACTIONS: readonly PianolaActionKind[] = ['auto_answer', 'escalate', 'ignore'];
export const RULE_RISKS: readonly PianolaRisk[] = ['low', 'medium', 'high'];
export const RULE_KINDS: readonly PianolaSignalKind[] = ['question', 'blocked'];
