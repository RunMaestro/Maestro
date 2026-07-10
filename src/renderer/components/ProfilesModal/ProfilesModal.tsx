import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Users, Plus, Trash2, RefreshCw } from 'lucide-react';
import type { Theme } from '../../types';
import type { AgentProfile } from '../../../shared/profiles/types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { notifyToast } from '../../stores/notificationStore';
import { generateUUID } from '../../../shared/uuid';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

export interface ProfilesModalProps {
	theme: Theme;
	onClose: () => void;
}

/** Effort choices offered in the picker. Blank means "inherit the base agent". */
const EFFORT_OPTIONS = ['', 'low', 'medium', 'high'] as const;

/**
 * Minimal Agent Profiles manager. Lists the profiles stored in the active
 * project's `.maestro/profiles.yaml` and lets the user create one by picking a
 * base agent, a model, an effort, and an optional role prompt. Intentionally
 * minimal - the Board (later phase) is the primary consumer.
 *
 * Reads/writes through the gated `window.maestro.profiles` bridge, which owns
 * the YAML file. Base agents come from the Left Bar session list.
 */
export function ProfilesModal({ theme, onClose }: ProfilesModalProps) {
	useModalLayer(MODAL_PRIORITIES.PROFILES_MODAL, 'Agent Profiles', onClose);

	const sessions = useSessionStore((s) => s.sessions);
	const activeSession = useSessionStore(selectActiveSession);
	const projectRoot = activeSession?.projectRoot ?? '';

	const [profiles, setProfiles] = useState<AgentProfile[]>([]);
	const [loading, setLoading] = useState(true);

	// New-profile form state.
	const [name, setName] = useState('');
	const [baseAgentId, setBaseAgentId] = useState('');
	const [model, setModel] = useState('');
	const [effort, setEffort] = useState('');
	const [role, setRole] = useState('');
	const [saving, setSaving] = useState(false);

	const baseAgentName = useCallback(
		(id: string) => sessions.find((s) => s.id === id)?.name ?? id,
		[sessions]
	);

	const load = useCallback(async () => {
		if (!projectRoot) {
			setProfiles([]);
			setLoading(false);
			return;
		}
		setLoading(true);
		try {
			setProfiles(await window.maestro.profiles.list(projectRoot));
		} catch (err) {
			logger.error(`Failed to load profiles: ${String(err)}`);
			captureException(err, { operation: 'profiles:list' });
			notifyToast({ color: 'red', title: 'Profiles', message: 'Failed to load profiles.' });
		} finally {
			setLoading(false);
		}
	}, [projectRoot]);

	useEffect(() => {
		void load();
	}, [load]);

	// Default the base-agent picker to the active session once sessions load.
	useEffect(() => {
		if (!baseAgentId && activeSession) setBaseAgentId(activeSession.id);
	}, [activeSession, baseAgentId]);

	const canSave = useMemo(
		() => !!projectRoot && name.trim().length > 0 && baseAgentId.length > 0 && !saving,
		[projectRoot, name, baseAgentId, saving]
	);

	const handleCreate = useCallback(async () => {
		if (!canSave) return;
		const profile: AgentProfile = {
			id: generateUUID(),
			name: name.trim(),
			baseAgentId,
			...(model.trim() ? { model: model.trim() } : {}),
			...(effort ? { effort } : {}),
			...(role.trim() ? { appendSystemPrompt: role.trim() } : {}),
		};
		setSaving(true);
		try {
			const updated = await window.maestro.profiles.upsert(projectRoot, profile);
			setProfiles(updated);
			// Reset the form (keep the base agent selection for quick repeat creation).
			setName('');
			setModel('');
			setEffort('');
			setRole('');
			notifyToast({ color: 'green', title: 'Profiles', message: `Created "${profile.name}".` });
		} catch (err) {
			logger.error(`Failed to create profile: ${String(err)}`);
			captureException(err, { operation: 'profiles:upsert' });
			notifyToast({ color: 'red', title: 'Profiles', message: 'Failed to save profile.' });
		} finally {
			setSaving(false);
		}
	}, [canSave, name, baseAgentId, model, effort, role, projectRoot]);

	const handleDelete = useCallback(
		async (profileId: string) => {
			try {
				setProfiles(await window.maestro.profiles.delete(projectRoot, profileId));
			} catch (err) {
				logger.error(`Failed to delete profile: ${String(err)}`);
				captureException(err, { operation: 'profiles:delete' });
				notifyToast({ color: 'red', title: 'Profiles', message: 'Failed to delete profile.' });
			}
		},
		[projectRoot]
	);

	const inputStyle = {
		backgroundColor: theme.colors.bgActivity,
		border: `1px solid ${theme.colors.border}`,
		color: theme.colors.textMain,
	} as const;

	return createPortal(
		<div
			className="fixed inset-0 flex items-center justify-center select-none"
			style={{ zIndex: MODAL_PRIORITIES.PROFILES_MODAL }}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="absolute inset-0 bg-black/50" />

			<div
				className="relative rounded-xl shadow-2xl flex flex-col"
				style={{
					width: '92vw',
					maxWidth: 720,
					height: '86vh',
					maxHeight: 820,
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
						<Users className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h2 className="text-base font-bold" style={{ color: theme.colors.textMain }}>
							Agent Profiles
						</h2>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							model / effort / role bundles
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

				{/* Body */}
				<div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
					{!projectRoot && (
						<div className="text-sm" style={{ color: theme.colors.textDim }}>
							Select an agent first so profiles can be stored for its project.
						</div>
					)}

					{/* Existing profiles */}
					<div className="space-y-2">
						<div
							className="text-xs font-semibold uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							Profiles
						</div>
						{profiles.length === 0 && !loading && (
							<div className="text-sm" style={{ color: theme.colors.textDim }}>
								No profiles yet. Create one below.
							</div>
						)}
						{profiles.map((p) => (
							<div
								key={p.id}
								className="flex items-center justify-between rounded-md px-3 py-2"
								style={{
									backgroundColor: theme.colors.bgActivity,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<div className="min-w-0 select-text">
									<div
										className="text-sm font-medium truncate"
										style={{ color: theme.colors.textMain }}
									>
										{p.name}
									</div>
									<div className="text-xs truncate" style={{ color: theme.colors.textDim }}>
										{baseAgentName(p.baseAgentId)}
										{p.model ? ` · ${p.model}` : ''}
										{p.effort ? ` · ${p.effort}` : ''}
										{p.appendSystemPrompt ? ' · role' : ''}
									</div>
								</div>
								<button
									onClick={() => void handleDelete(p.id)}
									className="p-1.5 rounded-md hover:bg-white/10 transition-colors shrink-0"
									style={{ color: theme.colors.textDim }}
									aria-label={`Delete ${p.name}`}
									title="Delete profile"
								>
									<Trash2 className="w-4 h-4" />
								</button>
							</div>
						))}
					</div>

					{/* New profile form */}
					<div
						className="space-y-3 rounded-lg p-4"
						style={{ border: `1px solid ${theme.colors.border}` }}
					>
						<div
							className="text-xs font-semibold uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							New profile
						</div>

						<label className="block space-y-1">
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Name
							</span>
							<input
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="e.g. Reviewer"
								className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
								style={inputStyle}
							/>
						</label>

						<label className="block space-y-1">
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Base agent
							</span>
							<select
								value={baseAgentId}
								onChange={(e) => setBaseAgentId(e.target.value)}
								className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
								style={inputStyle}
							>
								{sessions.length === 0 && <option value="">No agents available</option>}
								{sessions.map((s) => (
									<option key={s.id} value={s.id}>
										{s.name}
									</option>
								))}
							</select>
						</label>

						<div className="flex gap-3">
							<label className="block space-y-1 flex-1">
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									Model (optional)
								</span>
								<input
									value={model}
									onChange={(e) => setModel(e.target.value)}
									placeholder="inherit base agent"
									className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
									style={inputStyle}
								/>
							</label>
							<label className="block space-y-1 w-40">
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									Effort (optional)
								</span>
								<select
									value={effort}
									onChange={(e) => setEffort(e.target.value)}
									className="w-full rounded-md px-2 py-1.5 text-sm outline-none"
									style={inputStyle}
								>
									{EFFORT_OPTIONS.map((opt) => (
										<option key={opt || 'inherit'} value={opt}>
											{opt || 'inherit base agent'}
										</option>
									))}
								</select>
							</label>
						</div>

						<label className="block space-y-1">
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Role prompt (optional)
							</span>
							<textarea
								value={role}
								onChange={(e) => setRole(e.target.value)}
								placeholder="Appended to the agent's system prompt for this profile."
								rows={3}
								className="w-full rounded-md px-2 py-1.5 text-sm outline-none resize-y"
								style={inputStyle}
							/>
						</label>

						<button
							onClick={() => void handleCreate()}
							disabled={!canSave}
							className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-40"
							style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
						>
							<Plus className="w-4 h-4" />
							Create profile
						</button>
					</div>
				</div>
			</div>
		</div>,
		document.body
	);
}
