import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Music, RefreshCw } from 'lucide-react';
import type { Theme } from '../../types';
import type { PianolaRule } from '../../../shared/pianola/types';
import type {
	PianolaDecisionRecord,
	PianolaSuggestionsFile,
} from '../../../shared/pianola/storage';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { notifyToast } from '../../stores/notificationStore';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { RuleEditor } from './RuleEditor';
import { DecisionsView } from './DecisionsView';
import { RulesView } from './RulesView';
import { SuggestionsView } from './SuggestionsView';
import type { PianolaTab, DecisionFilter } from './shared';

// Shared helpers live in ./shared (one source for the views and RuleEditor); the
// dashboard's public surface keeps exposing them so the barrel, tests, and the
// editor can import them from this module.
export {
	describeRuleMatch,
	newBlankRule,
	RULE_SCOPES,
	RULE_ACTIONS,
	RULE_RISKS,
	RULE_KINDS,
} from './shared';

/** A 'PianolaDisabled' rejection is the expected feature-off path, not a bug. */
function isExpectedError(error: unknown): boolean {
	return error instanceof Error && error.message.includes('PianolaDisabled');
}

export interface PianolaModalProps {
	theme: Theme;
	onClose: () => void;
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
	const [suggestions, setSuggestions] = useState<PianolaSuggestionsFile | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const [rulesResult, loadedDecisions, loadedSuggestions] = await Promise.all([
				window.maestro.pianola.getRules(),
				window.maestro.pianola.getDecisions(500),
				window.maestro.pianola.getSuggestions(),
			]);
			setRules(rulesResult.rules);
			setRulesMalformed(rulesResult.malformed);
			setDecisions(loadedDecisions);
			setSuggestions(loadedSuggestions);
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

	const handleApproveRule = useCallback(async (rule: PianolaRule) => {
		try {
			const res = await window.maestro.pianola.applySuggestion({ rule });
			setRules(res.rules);
			setSuggestions((prev) =>
				prev ? { ...prev, proposals: prev.proposals.filter((p) => p.id !== rule.id) } : prev
			);
			notifyToast({ color: 'green', title: 'Pianola', message: 'Rule added from suggestion.' });
		} catch (error) {
			logger.error('[Pianola] Failed to apply suggestion', undefined, error);
			if (!isExpectedError(error)) void captureException(error, { tags: { feature: 'pianola' } });
			notifyToast({ color: 'red', title: 'Pianola', message: 'Could not apply suggestion.' });
		}
	}, []);

	const handleApplyProfile = useCallback(async (text: string) => {
		try {
			await window.maestro.pianola.applySuggestion({ profile: { text } });
			setSuggestions((prev) => (prev ? { ...prev, previousProfile: text } : prev));
			notifyToast({
				color: 'green',
				title: 'Pianola',
				message: 'Profile updated from suggestion.',
			});
		} catch (error) {
			logger.error('[Pianola] Failed to apply profile', undefined, error);
			if (!isExpectedError(error)) void captureException(error, { tags: { feature: 'pianola' } });
			notifyToast({ color: 'red', title: 'Pianola', message: 'Could not apply profile.' });
		}
	}, []);

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
							[
								'suggestions',
								`Suggestions${suggestions?.proposals.length ? ` (${suggestions.proposals.length})` : ''}`,
							],
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
					{tab === 'decisions' && (
						<DecisionsView
							theme={theme}
							decisions={filteredDecisions}
							filter={filter}
							onFilterChange={setFilter}
							loading={loading}
						/>
					)}
					{tab === 'rules' && (
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
					{tab === 'suggestions' && (
						<SuggestionsView
							theme={theme}
							suggestions={suggestions}
							loading={loading}
							onApproveRule={handleApproveRule}
							onApplyProfile={handleApplyProfile}
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
