import React, { useCallback } from 'react';
import type { Theme } from '../../../types';
import type {
	DispatchRole,
	RoleSlotConfig,
	AnyRoleSlot,
} from '../../../../shared/project-roles-types';
import { DISPATCH_ROLE_LABELS, isLegacySlot } from '../../../../shared/project-roles-types';
import type { WorkItem } from '../../../../shared/work-graph-types';
import type { AgentId } from '../../../../shared/agentIds';
import { useProviderModelOptions } from '../../../hooks/agentCreation/useProviderModelOptions';

// Role icon characters
const ROLE_ICONS: Record<DispatchRole, string> = {
	runner: '▶',
	fixer: '🔧',
	reviewer: '👁',
	merger: '⎇',
};

export interface SlotCardProps {
	role: DispatchRole;
	/**
	 * The stored slot value — may be the new RoleSlotConfig shape OR the
	 * legacy RoleSlotAssignment shape (with `agentId`).  SlotCard renders a
	 * migration banner when it detects the legacy shape.
	 */
	assignment: AnyRoleSlot | undefined;
	busyWorkItem?: WorkItem;
	theme: Theme;
	onAssignmentChange: (role: DispatchRole, assignment: RoleSlotConfig | undefined) => void;
}

export function SlotCard({
	role,
	assignment,
	busyWorkItem,
	theme,
	onAssignmentChange,
}: SlotCardProps) {
	// Detect legacy slot — show migration banner, don't try to render the new dropdowns
	const legacy = isLegacySlot(assignment);
	const config: RoleSlotConfig | undefined = legacy
		? undefined
		: (assignment as RoleSlotConfig | undefined);

	const {
		availableProviders,
		loadingProviders,
		providerError,
		availableModels,
		loadingModels,
		availableEfforts,
		loadingEfforts,
		refreshProviders,
	} = useProviderModelOptions({
		enabled: !legacy,
		// Host is always local from the UI's perspective — actual spawn host is
		// derived from WorkItem.projectPath at dispatch time (#441 final spec).
		host: { kind: 'local' },
		selectedProvider: config?.agentProvider ?? null,
	});

	// enabled defaults to true when absent
	const slotEnabled = config ? config.enabled !== false : true;

	// -----------------------------------------------------------------------
	// Handlers — each emits a fresh RoleSlotConfig
	// -----------------------------------------------------------------------

	const handleProviderChange = useCallback(
		(providerId: string) => {
			if (!providerId) {
				onAssignmentChange(role, undefined);
				return;
			}
			onAssignmentChange(role, {
				agentProvider: providerId as AgentId,
				// reset derived fields when provider changes
				model: undefined,
				effort: undefined,
				enabled: config?.enabled,
			});
		},
		[role, config, onAssignmentChange]
	);

	const handleModelChange = useCallback(
		(model: string) => {
			if (!config) return;
			onAssignmentChange(role, { ...config, model: model || undefined });
		},
		[role, config, onAssignmentChange]
	);

	const handleEffortChange = useCallback(
		(effort: string) => {
			if (!config) return;
			onAssignmentChange(role, {
				...config,
				effort: (effort || undefined) as RoleSlotConfig['effort'],
			});
		},
		[role, config, onAssignmentChange]
	);

	const handleToggleEnabled = useCallback(() => {
		if (!config) return;
		onAssignmentChange(role, {
			...config,
			enabled: config.enabled === false ? true : false,
		});
	}, [role, config, onAssignmentChange]);

	const handleDismissLegacy = useCallback(() => {
		// User acknowledges the migration banner — clears the legacy slot so
		// they can configure fresh ephemeral settings.
		onAssignmentChange(role, undefined);
	}, [role, onAssignmentChange]);

	// -----------------------------------------------------------------------
	// Status badge
	// -----------------------------------------------------------------------
	const githubNumber = busyWorkItem?.github?.issueNumber;
	const githubUrl = busyWorkItem?.github?.url;
	const workItemDisplayId = githubNumber ? `#${githubNumber}` : busyWorkItem?.id;

	type StatusVariant = 'on-available' | 'on-busy' | 'off-draining' | 'off-idle';
	const statusVariant: StatusVariant | null = config
		? slotEnabled
			? busyWorkItem
				? 'on-busy'
				: 'on-available'
			: busyWorkItem
				? 'off-draining'
				: 'off-idle'
		: null;

	const openGithub = useCallback(() => {
		if (githubUrl) {
			void window.maestro.shell.openExternal(githubUrl);
		}
	}, [githubUrl]);

	// -----------------------------------------------------------------------
	// Shared styles
	// -----------------------------------------------------------------------
	const selectStyle: React.CSSProperties = {
		backgroundColor: theme.colors.bgSidebar,
		color: theme.colors.textMain,
		border: `1px solid ${theme.colors.border}`,
		borderRadius: '4px',
		padding: '3px 6px',
		fontSize: '11px',
		outline: 'none',
		width: '100%',
		cursor: 'pointer',
	};

	const statusBadgeColor = (v: StatusVariant) => {
		if (v === 'on-busy' || v === 'off-draining') return theme.colors.warning;
		if (v === 'on-available') return theme.colors.accent;
		return theme.colors.textDim;
	};

	const statusBadgeBg = (v: StatusVariant) => {
		if (v === 'on-busy' || v === 'off-draining') return `${theme.colors.warning}25`;
		if (v === 'on-available') return `${theme.colors.accent}20`;
		return `${theme.colors.textDim}20`;
	};

	return (
		<div
			className="rounded border mb-3 p-3"
			style={{
				borderColor:
					statusVariant === 'on-busy' || statusVariant === 'off-draining'
						? theme.colors.warning
						: theme.colors.border,
				backgroundColor: theme.colors.bgActivity,
			}}
		>
			{/* Header row */}
			<div className="flex items-center justify-between mb-2">
				<div className="flex items-center gap-1.5">
					<span style={{ fontSize: '13px' }}>{ROLE_ICONS[role]}</span>
					<span
						className="text-xs font-bold uppercase tracking-wide"
						style={{ color: theme.colors.textMain }}
					>
						{DISPATCH_ROLE_LABELS[role]}
					</span>
				</div>

				<div className="flex items-center gap-1.5">
					{statusVariant && (
						<span
							className="text-[10px] px-1.5 py-0.5 rounded font-medium"
							style={{
								backgroundColor: statusBadgeBg(statusVariant),
								color: statusBadgeColor(statusVariant),
							}}
						>
							{statusVariant === 'on-available' && 'On (Available)'}
							{statusVariant === 'on-busy' && (
								<>
									{'On (Busy: '}
									{busyWorkItem ? (
										<button
											className="underline bg-transparent border-none p-0 cursor-pointer"
											style={{ color: theme.colors.warning, fontSize: 'inherit' }}
											onClick={openGithub}
											title={busyWorkItem.title}
										>
											{workItemDisplayId}
										</button>
									) : null}
									{')'}
								</>
							)}
							{statusVariant === 'off-draining' && (
								<>
									{'Off (Draining: '}
									{busyWorkItem ? (
										<button
											className="underline bg-transparent border-none p-0 cursor-pointer"
											style={{ color: theme.colors.warning, fontSize: 'inherit' }}
											onClick={openGithub}
											title={busyWorkItem.title}
										>
											{workItemDisplayId}
										</button>
									) : null}
									{')'}
								</>
							)}
							{statusVariant === 'off-idle' && 'Off (Idle)'}
						</span>
					)}

					{config && (
						<button
							onClick={handleToggleEnabled}
							className="text-[10px] px-1.5 py-0.5 rounded font-medium border"
							style={{
								backgroundColor: slotEnabled
									? `${theme.colors.accent}20`
									: `${theme.colors.textDim}15`,
								color: slotEnabled ? theme.colors.accent : theme.colors.textDim,
								borderColor: slotEnabled ? `${theme.colors.accent}50` : `${theme.colors.textDim}40`,
								cursor: 'pointer',
							}}
							title={
								slotEnabled
									? 'Slot is On — click to disable (drain mode)'
									: 'Slot is Off — click to enable'
							}
						>
							{slotEnabled ? 'On' : 'Off'}
						</button>
					)}
				</div>
			</div>

			{/* ----------------------------------------------------------------
			  Legacy migration banner (#441)
			  ---------------------------------------------------------------- */}
			{legacy && (
				<div
					className="mb-2 p-2 rounded text-[10px]"
					style={{
						backgroundColor: `${theme.colors.warning}18`,
						border: `1px solid ${theme.colors.warning}55`,
						color: theme.colors.warning,
					}}
				>
					<p className="font-medium mb-1">Reconfigure: ephemeral mode (#441)</p>
					<p style={{ color: theme.colors.textDim }}>
						This slot was previously tied to a Left Bar agent. Dev Crew slots now spawn ephemeral
						agents per-claim. Click Clear to configure fresh settings.
					</p>
					<button
						onClick={handleDismissLegacy}
						className="mt-1.5 px-2 py-0.5 rounded text-[10px] font-medium border"
						style={{
							borderColor: theme.colors.warning,
							color: theme.colors.warning,
							cursor: 'pointer',
							backgroundColor: 'transparent',
						}}
					>
						Clear &amp; reconfigure
					</button>
				</div>
			)}

			{/* ----------------------------------------------------------------
			  3 cascading dropdowns: Provider → Model → Effort
			  (only shown for non-legacy slots)
			  Host is implicit: derived from WorkItem.projectPath at dispatch time.
			  ---------------------------------------------------------------- */}
			{!legacy && (
				<>
					{/* 1. Agent Provider dropdown */}
					<div className="mb-2">
						<label className="block text-[10px] mb-1" style={{ color: theme.colors.textDim }}>
							Agent Provider
						</label>
						{providerError ? (
							<div className="flex items-center gap-1">
								<p className="text-[10px]" style={{ color: theme.colors.error }}>
									{providerError}
								</p>
								<button
									onClick={refreshProviders}
									className="text-[10px] underline"
									style={{
										color: theme.colors.accent,
										cursor: 'pointer',
										background: 'none',
										border: 'none',
									}}
								>
									retry
								</button>
							</div>
						) : loadingProviders ? (
							<p className="text-[10px]" style={{ color: theme.colors.textDim }}>
								Detecting providers…
							</p>
						) : (
							<select
								value={config?.agentProvider ?? ''}
								onChange={(e) => handleProviderChange(e.target.value)}
								style={selectStyle}
								title="AI provider for ephemeral spawn"
							>
								<option value="">Select provider…</option>
								{availableProviders.map((a) => (
									<option key={a.id} value={a.id}>
										{a.name ?? a.id}
									</option>
								))}
								{availableProviders.length === 0 && (
									<option value="" disabled>
										No providers found on this host
									</option>
								)}
							</select>
						)}
					</div>

					{/* 2. Model dropdown (shown when provider selected + has models) */}
					{config?.agentProvider && (
						<div className="mb-2">
							<label className="block text-[10px] mb-1" style={{ color: theme.colors.textDim }}>
								Model
							</label>
							{loadingModels ? (
								<p className="text-[10px]" style={{ color: theme.colors.textDim }}>
									Loading models…
								</p>
							) : availableModels.length > 0 ? (
								<select
									value={config.model ?? ''}
									onChange={(e) => handleModelChange(e.target.value)}
									style={selectStyle}
									title="Model used when this slot claims a task"
								>
									<option value="">Provider default</option>
									{availableModels.map((m) => (
										<option key={m} value={m}>
											{m}
										</option>
									))}
								</select>
							) : (
								<p className="text-[10px]" style={{ color: theme.colors.textDim }}>
									No models available — provider default will be used.
								</p>
							)}
						</div>
					)}

					{/* 3. Effort dropdown (shown when provider selected + has efforts) */}
					{config?.agentProvider && !loadingEfforts && availableEfforts.length > 0 && (
						<div className="mb-2">
							<label className="block text-[10px] mb-1" style={{ color: theme.colors.textDim }}>
								Effort
							</label>
							<select
								value={config.effort ?? ''}
								onChange={(e) => handleEffortChange(e.target.value)}
								style={selectStyle}
								title="Effort level for this slot's claims"
							>
								<option value="">Provider default</option>
								{availableEfforts.map((e) => (
									<option key={e} value={e}>
										{e}
									</option>
								))}
							</select>
						</div>
					)}
				</>
			)}

			{/* Empty state hint */}
			{!config && !legacy && (
				<p className="text-[10px] mt-1" style={{ color: theme.colors.textDim }}>
					Select a provider above to fill this slot.
				</p>
			)}
		</div>
	);
}
