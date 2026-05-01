/**
 * DispatchCardDetail — right-side detail panel for a selected Kanban card.
 *
 * Shows full metadata, tags, dependencies, claim info, and quick-action
 * buttons (release claim, assign to agent).
 */

import React, { memo, useCallback, useState } from 'react';
import {
	BookOpen,
	CheckCircle2,
	Clock,
	GitBranch,
	Layers,
	Lock,
	Tag,
	User,
	X,
	Zap,
} from 'lucide-react';
import type { Theme, WorkItem } from '../../types';
import type { AgentDispatchFleetEntry } from '../../../shared/agent-dispatch-types';
import {
	extractDeliveryPlannerLineage,
	extractLivingWikiReference,
} from '../../../shared/agent-dispatch-lineage';
import { agentDispatchService } from '../../services/agentDispatch';
import { notifyToast } from '../../stores/notificationStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DispatchCardDetailProps {
	item: WorkItem;
	theme: Theme;
	fleet: AgentDispatchFleetEntry[];
	onClose: () => void;
	/** Called after a successful claim/release to refresh the board */
	onRefresh: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Field({
	label,
	children,
	theme,
}: {
	label: string;
	children: React.ReactNode;
	theme: Theme;
}) {
	return (
		<div>
			<dt
				className="text-[10px] uppercase font-bold mb-0.5"
				style={{ color: theme.colors.textDim }}
			>
				{label}
			</dt>
			<dd className="text-xs" style={{ color: theme.colors.textMain }}>
				{children}
			</dd>
		</div>
	);
}

function formatDate(iso?: string): string {
	if (!iso) return '—';
	return new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	}).format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const DispatchCardDetail = memo(function DispatchCardDetail({
	item,
	theme,
	fleet,
	onClose,
	onRefresh,
}: DispatchCardDetailProps) {
	const [assigning, setAssigning] = useState(false);
	const [releasing, setReleasing] = useState(false);
	const [selectedAgentId, setSelectedAgentId] = useState<string>('');

	const lineage = extractDeliveryPlannerLineage(item);
	const wikiRef = extractLivingWikiReference(item);

	const readyAgents = fleet.filter((a) => a.readiness === 'ready' || a.readiness === 'idle');

	const handleRelease = useCallback(async () => {
		if (!item.claim) return;
		setReleasing(true);
		try {
			await agentDispatchService.releaseClaim({ workItemId: item.id });
			notifyToast({ color: 'green', title: 'Claim released', message: item.title });
			onRefresh();
		} catch (err) {
			notifyToast({
				color: 'red',
				title: 'Release failed',
				message: err instanceof Error ? err.message : String(err),
				dismissible: true,
			});
		} finally {
			setReleasing(false);
		}
	}, [item, onRefresh]);

	const handleAssign = useCallback(async () => {
		const agent = fleet.find((a) => a.agentId === selectedAgentId);
		if (!agent) return;
		setAssigning(true);
		try {
			await agentDispatchService.assignManually({
				workItemId: item.id,
				agent,
				userInitiated: true,
			});
			notifyToast({
				color: 'green',
				title: 'Assigned',
				message: `${item.title} → ${agent.displayName}`,
			});
			onRefresh();
		} catch (err) {
			notifyToast({
				color: 'red',
				title: 'Assignment failed',
				message: err instanceof Error ? err.message : String(err),
				dismissible: true,
			});
		} finally {
			setAssigning(false);
		}
	}, [item, fleet, selectedAgentId, onRefresh]);

	return (
		<div
			className="flex flex-col h-full border-l"
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgSidebar,
				minWidth: 280,
				maxWidth: 360,
			}}
		>
			{/* Header */}
			<div
				className="flex items-start justify-between gap-2 px-4 py-3 border-b"
				style={{ borderColor: theme.colors.border }}
			>
				<h3 className="text-sm font-bold leading-snug" style={{ color: theme.colors.textMain }}>
					{item.title}
				</h3>
				<button
					onClick={onClose}
					className="shrink-0 p-1 rounded hover:opacity-70 transition-opacity"
					style={{ color: theme.colors.textDim }}
					aria-label="Close detail"
				>
					<X className="w-4 h-4" />
				</button>
			</div>

			{/* Scrollable body */}
			<div className="flex-1 overflow-y-auto px-4 py-3 scrollbar-thin">
				<dl className="space-y-3">
					<Field label="Status" theme={theme}>
						<span
							className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold"
							style={{
								backgroundColor: `${theme.colors.accent}15`,
								color: theme.colors.accent,
							}}
						>
							{item.status}
						</span>
					</Field>

					<Field label="Type" theme={theme}>
						{item.type}
					</Field>

					{item.description && (
						<Field label="Description" theme={theme}>
							<p className="whitespace-pre-wrap leading-relaxed">{item.description}</p>
						</Field>
					)}

					<Field label="Updated" theme={theme}>
						<span className="flex items-center gap-1">
							<Clock className="w-3 h-3" />
							{formatDate(item.updatedAt)}
						</span>
					</Field>

					{item.dueAt && (
						<Field label="Due" theme={theme}>
							{formatDate(item.dueAt)}
						</Field>
					)}

					{item.github?.issueNumber && (
						<Field label="GitHub" theme={theme}>
							<span className="flex items-center gap-1">
								<GitBranch className="w-3 h-3" />#{item.github.issueNumber}
							</span>
						</Field>
					)}

					{item.owner && (
						<Field label="Owner" theme={theme}>
							<span className="flex items-center gap-1">
								<User className="w-3 h-3" />
								{item.owner.name ?? item.owner.id}
							</span>
						</Field>
					)}

					{item.claim?.status === 'active' && (
						<Field label="Claim holder" theme={theme}>
							<span
								className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold"
								style={{
									backgroundColor: `${theme.colors.warning}15`,
									color: theme.colors.warning,
								}}
							>
								<Lock className="w-3 h-3" />
								{item.claim.owner?.name ?? item.claim.owner?.id ?? '—'}
							</span>
						</Field>
					)}

					{item.tags.length > 0 && (
						<Field label="Tags" theme={theme}>
							<div className="flex flex-wrap gap-1 mt-0.5">
								{item.tags.map((t) => (
									<span
										key={t}
										className="inline-flex items-center gap-0.5 text-[10px] rounded px-1.5 py-0.5"
										style={{
											backgroundColor: `${theme.colors.accent}15`,
											color: theme.colors.accentText,
										}}
									>
										<Tag className="w-2.5 h-2.5" />
										{t}
									</span>
								))}
							</div>
						</Field>
					)}

					{item.capabilities && item.capabilities.length > 0 && (
						<Field label="Capabilities" theme={theme}>
							<div className="flex flex-wrap gap-1 mt-0.5">
								{item.capabilities.map((c) => (
									<span
										key={c}
										className="text-[10px] rounded px-1.5 py-0.5"
										style={{
											backgroundColor: `${theme.colors.success}15`,
											color: theme.colors.success,
										}}
									>
										{c}
									</span>
								))}
							</div>
						</Field>
					)}

					{(item.dependencies ?? []).length > 0 && (
						<Field label="Dependencies" theme={theme}>
							<ul className="space-y-1 mt-0.5">
								{(item.dependencies ?? []).map((dep) => (
									<li key={dep.id} className="flex items-center gap-1 text-[10px]">
										<CheckCircle2
											className="w-3 h-3 shrink-0"
											style={{
												color:
													dep.status === 'resolved' ? theme.colors.success : theme.colors.textDim,
											}}
										/>
										<span style={{ color: theme.colors.textDim }}>
											{dep.type} → {dep.toWorkItemId.slice(0, 8)}…
										</span>
									</li>
								))}
							</ul>
						</Field>
					)}

					{/* Delivery Planner lineage */}
					{lineage.kind && (
						<Field label="Planner lineage" theme={theme}>
							<div className="flex flex-wrap gap-1 mt-0.5">
								<span
									className="inline-flex items-center gap-0.5 text-[10px] rounded px-1.5 py-0.5 font-bold"
									style={{
										backgroundColor: `${theme.colors.accent}15`,
										color: theme.colors.accent,
									}}
								>
									<Layers className="w-2.5 h-2.5" />
									{lineage.kind}
								</span>
								{lineage.prdWorkItemId && (
									<span
										className="text-[10px] rounded px-1.5 py-0.5 font-mono"
										style={{
											backgroundColor: `${theme.colors.accent}10`,
											color: theme.colors.textDim,
										}}
										title={`PRD: ${lineage.prdWorkItemId}`}
									>
										PRD {lineage.prdWorkItemId.slice(0, 8)}…
									</span>
								)}
								{lineage.epicWorkItemId && (
									<span
										className="text-[10px] rounded px-1.5 py-0.5 font-mono"
										style={{
											backgroundColor: `${theme.colors.accent}10`,
											color: theme.colors.textDim,
										}}
										title={`Epic: ${lineage.epicWorkItemId}`}
									>
										Epic {lineage.epicWorkItemId.slice(0, 8)}…
									</span>
								)}
							</div>
						</Field>
					)}

					{/* Living Wiki context */}
					{wikiRef.kind && (
						<Field label="Living Wiki" theme={theme}>
							<div className="flex flex-wrap gap-1 mt-0.5">
								{wikiRef.kind === 'living-wiki-doc' && (
									<>
										<span
											className="inline-flex items-center gap-0.5 text-[10px] rounded px-1.5 py-0.5"
											style={{
												backgroundColor: `${theme.colors.success}15`,
												color: theme.colors.success,
											}}
										>
											<BookOpen className="w-2.5 h-2.5" />
											doc
										</span>
										{wikiRef.docSlug && (
											<span
												className="text-[10px] rounded px-1.5 py-0.5 font-mono"
												style={{
													backgroundColor: `${theme.colors.success}10`,
													color: theme.colors.textDim,
												}}
											>
												{wikiRef.docSlug}
											</span>
										)}
										{wikiRef.docArea && (
											<span
												className="text-[10px] rounded px-1.5 py-0.5"
												style={{
													backgroundColor: `${theme.colors.success}10`,
													color: theme.colors.textDim,
												}}
											>
												{wikiRef.docArea}
											</span>
										)}
									</>
								)}
								{wikiRef.kind === 'living-wiki-doc-gap' && (
									<>
										<span
											className="inline-flex items-center gap-0.5 text-[10px] rounded px-1.5 py-0.5"
											style={{
												backgroundColor: `${theme.colors.warning}15`,
												color: theme.colors.warning,
											}}
										>
											<BookOpen className="w-2.5 h-2.5" />
											doc gap
										</span>
										{wikiRef.sourceGitPath && (
											<span
												className="text-[10px] rounded px-1.5 py-0.5 font-mono break-all"
												style={{
													backgroundColor: `${theme.colors.warning}10`,
													color: theme.colors.textDim,
												}}
												title={wikiRef.sourceGitPath}
											>
												{wikiRef.sourceGitPath.length > 32
													? `…${wikiRef.sourceGitPath.slice(-30)}`
													: wikiRef.sourceGitPath}
											</span>
										)}
									</>
								)}
							</div>
						</Field>
					)}

					<Field label="Project" theme={theme}>
						<span className="font-mono text-[10px]">{item.projectPath || item.gitPath}</span>
					</Field>
				</dl>
			</div>

			{/* Action footer */}
			<div className="px-4 py-3 border-t space-y-2" style={{ borderColor: theme.colors.border }}>
				{/* Release claim */}
				{item.claim?.status === 'active' && (
					<button
						onClick={() => void handleRelease()}
						disabled={releasing}
						className="w-full rounded px-3 py-1.5 text-xs font-bold border transition-colors hover:opacity-80 disabled:opacity-50"
						style={{
							borderColor: theme.colors.warning,
							color: theme.colors.warning,
							backgroundColor: `${theme.colors.warning}10`,
						}}
					>
						{releasing ? 'Releasing…' : 'Release claim'}
					</button>
				)}

				{/* Manual assign */}
				{readyAgents.length > 0 && (
					<div className="flex gap-2">
						<select
							value={selectedAgentId}
							onChange={(e) => setSelectedAgentId(e.target.value)}
							className="flex-1 rounded border text-xs px-2 py-1.5 outline-none"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textMain,
							}}
						>
							<option value="">Select agent…</option>
							{readyAgents.map((a) => (
								<option key={a.agentId} value={a.agentId}>
									{a.displayName}
								</option>
							))}
						</select>
						<button
							onClick={() => void handleAssign()}
							disabled={!selectedAgentId || assigning}
							className="shrink-0 flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-bold border transition-colors hover:opacity-80 disabled:opacity-50"
							style={{
								borderColor: theme.colors.accent,
								color: theme.colors.accent,
								backgroundColor: `${theme.colors.accent}15`,
							}}
						>
							<Zap className="w-3 h-3" />
							{assigning ? 'Assigning…' : 'Assign'}
						</button>
					</div>
				)}
			</div>
		</div>
	);
});
