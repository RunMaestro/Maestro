import React, { useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import type { Theme } from '../../types';
import type { PianolaAgentGroupSelection } from '../../../shared/pianola/pianola-scope';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';
import type { PianolaSupervisorState } from './usePianolaSupervisor';

/** Whole-agent and native-group selections use the existing supervisor registry. */
export function PianolaScopeControls({
	theme,
	supervisor,
	requestedAgent,
	autoWatchControl = false,
}: {
	theme: Theme;
	supervisor: PianolaSupervisorState;
	autoWatchControl?: boolean;
	requestedAgent?: { agentId: string; agentName: string } | null;
}): React.ReactElement {
	const sessions = useSessionStore((s) => s.sessions);
	const groups = useSessionStore((s) => s.groups);
	const sessionNames = useMemo(
		() => new Map(sessions.map((session) => [session.id, session.name])),
		[sessions]
	);
	const groupNames = useMemo(
		() => new Map(groups.map((group) => [group.id, group.name])),
		[groups]
	);
	const [editing, setEditing] = useState<PianolaSupervisedTarget | null>(null);
	const [creating, setCreating] = useState(false);
	const [saving, setSaving] = useState(false);
	const [manager, setManager] = useState('');
	const [selection, setSelection] = useState<PianolaAgentGroupSelection>({
		label: '',
		mode: 'agents-and-groups',
		agentIds: [],
		groupIds: [],
		excludedAgentIds: [],
	});
	useEffect(() => {
		if (!requestedAgent) return;
		setEditing(null);
		setCreating(true);
		setManager('');
		setSelection({
			label: requestedAgent.agentName,
			mode: 'agents-and-groups',
			agentIds: [requestedAgent.agentId],
			groupIds: [],
			excludedAgentIds: [],
		});
	}, [requestedAgent]);
	const scopes = supervisor.targets.filter(
		(target) =>
			target.kind === 'watch-scope' &&
			(!autoWatchControl ||
				(target.selection?.mode === 'agents-and-groups' && target.selection.futureLocalAgents))
	);
	const futureScopes = scopes.filter(
		(target) => target.selection?.mode === 'agents-and-groups' && target.selection.futureLocalAgents
	);
	const futureScope = futureScopes.length === 1 ? futureScopes[0] : undefined;
	const start = (target?: PianolaSupervisedTarget): void => {
		setEditing(target ?? null);
		setCreating(!target);
		setManager(target?.managerAgentId ?? '');
		setSelection(
			target?.selection?.mode === 'agents-and-groups'
				? { ...target.selection }
				: {
						label: target?.selection?.label ?? (autoWatchControl ? 'Future local agents' : ''),
						...(autoWatchControl ? { futureLocalAgents: true } : {}),
						mode: 'agents-and-groups',
						agentIds: [],
						groupIds: [],
						excludedAgentIds: [],
					}
		);
	};
	const toggle = (field: 'agentIds' | 'groupIds' | 'excludedAgentIds', id: string): void => {
		setSelection((old) => ({
			...old,
			[field]: old[field].includes(id)
				? old[field].filter((item) => item !== id)
				: [...old[field], id],
		}));
	};
	return (
		<section className="mb-5" style={{ color: theme.colors.textMain }}>
			{autoWatchControl && (
				<label className="flex items-center gap-2 text-xs mb-2">
					<input
						type="checkbox"
						checked={!!futureScope?.enabled}
						disabled={saving || futureScopes.length > 1}
						onChange={() => {
							if (futureScope) void supervisor.setEnabled(futureScope.id, !futureScope.enabled);
							else start();
						}}
					/>{' '}
					Automatically watch future local agents (all chats and worktree children)
				</label>
			)}
			{autoWatchControl && futureScopes.length > 1 && (
				<p className="text-xs">
					Multiple future-agent selections: use each selection's Pause/Resume controls and chosen
					manager below.
				</p>
			)}
			{autoWatchControl && futureScopes.length === 0 && supervisor.autoWatchNewAgents && (
				<p className="text-xs">
					NeedsConfiguration: select the actual manager and save a standing future-agent policy.
					{supervisor.autoWatchNewAgents
						? ' Legacy Auto-Watch is enabled without a manager policy.'
						: ''}
				</p>
			)}
			<div className="flex items-center justify-between mb-2">
				<h3 className="text-xs font-bold uppercase">Agent and group selections</h3>
				<button type="button" disabled={saving} onClick={() => start()} className="text-xs">
					+ Add selection
				</button>
			</div>
			{scopes.length === 0 && (
				<p className="text-sm" style={{ color: theme.colors.textDim }}>
					No selections registered.
				</p>
			)}
			{scopes.map((scope) => {
				const health = supervisor.health.find((item) => item.id === scope.id);
				const state = health?.state ?? 'Unknown';
				const evidence = supervisor.checkpoints.find((item) => item.scopeId === scope.id);
				return (
					<div
						key={scope.id}
						className="rounded px-3 py-2 mb-1"
						style={{ backgroundColor: theme.colors.bgSidebar }}
					>
						<div className="flex gap-2 items-center">
							<span className="font-medium flex-1">{scope.selection?.label ?? scope.id}</span>
							<span className="text-xs">Registry: {scope.enabled ? 'Enabled' : 'Paused'}</span>
							<span className="text-xs">Worker: {state}</span>
							<button type="button" disabled={saving} onClick={() => start(scope)}>
								Edit
							</button>
							<button
								type="button"
								disabled={saving}
								onClick={() => void supervisor.setEnabled(scope.id, !scope.enabled)}
							>
								{scope.enabled ? 'Pause' : 'Resume'}
							</button>
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							{scope.selection?.mode === 'agents-and-groups'
								? `Selected: ${scope.selection.agentIds.length} agents, ${scope.selection.groupIds.length} groups${scope.selection.futureLocalAgents ? ', future local agents' : ''}; ${scope.selection.excludedAgentIds.length} exclusions`
								: 'Legacy selection requires reconfiguration'}{' '}
							· Manager: {sessionNames.get(scope.managerAgentId ?? '') ?? scope.managerAgentId}.
							Worker health does not establish individual chat coverage.
							{health?.lastError ? ` ${health.lastError}` : ''}
						</div>
						{scope.selection?.mode === 'agents-and-groups' && (
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								<div>
									Agents:{' '}
									{scope.selection.agentIds.map((id) => sessionNames.get(id) ?? id).join(', ') ||
										'none'}
								</div>
								<div>
									Groups:{' '}
									{scope.selection.groupIds.map((id) => groupNames.get(id) ?? id).join(', ') ||
										'none'}
								</div>
								<div>
									Excluded:{' '}
									{scope.selection.excludedAgentIds
										.map((id) => sessionNames.get(id) ?? id)
										.join(', ') || 'none'}
								</div>
							</div>
						)}
						{evidence?.error && (
							<div className="text-xs">Checkpoint unavailable: {evidence.error}</div>
						)}
						{!evidence?.coverage && (
							<div className="text-xs">
								Coverage unknown: current census unavailable. Operator: refresh or inspect the
								supervisor.
							</div>
						)}
						{evidence?.coverage && (
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								Coverage: {evidence.coverage.status} (
								{evidence.coverage.fresh ? 'fresh' : 'not fresh'}). {evidence.coverage.reason} ·{' '}
								{evidence.coverage.nextActor}: {evidence.coverage.nextAction} · Last census:{' '}
								{evidence.coverage.censusAt !== null
									? new Date(evidence.coverage.censusAt).toLocaleString()
									: 'not yet recorded'}
								.
								{Array.from(new Set(evidence.coverage.tabs.map((tab) => tab.agentId))).map(
									(agentId) => {
										const tabs = evidence.coverage!.tabs.filter((tab) => tab.agentId === agentId);
										return (
											<div key={agentId}>
												<strong>{sessionNames.get(agentId) ?? agentId}</strong>
												{tabs.map((tab) => (
													<div key={tab.tabId}>
														Chat {tab.tabId}: {tab.status} · {tab.reason}
														{tab.error ? ` · ${tab.error}` : ''} · {tab.nextActor}: {tab.nextAction}
													</div>
												))}
											</div>
										);
									}
								)}
							</div>
						)}
					</div>
				);
			})}
			{(creating || editing) && (
				<fieldset
					disabled={saving}
					className="rounded p-3 mt-2 flex flex-col gap-2"
					style={{ backgroundColor: theme.colors.bgSidebar }}
				>
					<label>
						Label{' '}
						<input
							className="ml-2 text-black"
							value={selection.label}
							onChange={(event) => setSelection({ ...selection, label: event.target.value })}
						/>
					</label>
					<label>
						Manager{' '}
						<select
							className="ml-2 text-black"
							value={manager}
							onChange={(event) => setManager(event.target.value)}
						>
							<option value="">Select manager</option>
							{sessions.map((session) => (
								<option key={session.id} value={session.id}>
									{session.name}
								</option>
							))}
						</select>
					</label>
					<label>
						<input
							type="checkbox"
							checked={selection.futureLocalAgents === true}
							onChange={(event) => {
								const { futureAgentBaselineIds: _baseline, ...rest } = selection;
								setSelection(
									event.target.checked
										? { ...rest, futureLocalAgents: true }
										: { ...rest, futureLocalAgents: undefined }
								);
							}}
						/>{' '}
						Include future new local agents, all their chats and worktree children
					</label>
					<div className="text-xs font-bold">Groups</div>
					{groups.map((group) => (
						<label key={group.id}>
							<input
								type="checkbox"
								checked={selection.groupIds.includes(group.id)}
								onChange={() => toggle('groupIds', group.id)}
							/>{' '}
							{group.name}
						</label>
					))}
					<div className="text-xs font-bold">Whole agents</div>
					{sessions
						.filter((session) => session.id !== manager && !session.isPianola)
						.map((session) => (
							<label key={session.id}>
								<input
									type="checkbox"
									aria-label={`Select ${session.name}`}
									checked={selection.agentIds.includes(session.id)}
									onChange={() => toggle('agentIds', session.id)}
								/>{' '}
								{session.name}{' '}
								<input
									className="ml-3"
									type="checkbox"
									aria-label={`Exclude ${session.name}`}
									checked={selection.excludedAgentIds.includes(session.id)}
									onChange={() => toggle('excludedAgentIds', session.id)}
								/>{' '}
								Exclude
							</label>
						))}
					<div className="flex gap-3">
						<button
							type="button"
							disabled={
								!manager ||
								!selection.label.trim() ||
								!(
									selection.agentIds.length ||
									selection.groupIds.length ||
									selection.futureLocalAgents
								)
							}
							onClick={async () => {
								setSaving(true);
								try {
									const saved = await supervisor.saveScope({
										...editing,
										kind: 'watch-scope',
										enabled: editing?.enabled ?? false,
										managerAgentId: manager,
										selection,
									});
									if (saved) {
										setCreating(false);
										setEditing(null);
									}
								} finally {
									setSaving(false);
								}
							}}
						>
							Save
						</button>
						<button
							type="button"
							onClick={() => {
								setCreating(false);
								setEditing(null);
							}}
						>
							Cancel
						</button>
					</div>
				</fieldset>
			)}
		</section>
	);
}
