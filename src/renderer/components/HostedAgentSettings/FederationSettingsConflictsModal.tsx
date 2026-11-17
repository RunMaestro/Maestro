/**
 * FederationSettingsConflictsModal - the fields of hosted agents that this machine and the host
 * both changed (or that differ on an agent's first sync), and the person's pick for each.
 *
 * Per field: take the host's value (the default, and what other conductors see), keep this
 * machine's, or, for free text two people may both have extended, ask the agent for a merge.
 * A merge is a proposal in an editable box; only "Use this" makes it the pick. A pick goes to the
 * settings sync (`hostedAgentSettingsStore.resolve()`), which writes it here and on the host.
 *
 * Opened from the conflict toast, the palette ("Review Federation Settings Conflicts"), the
 * hamburger menu, and `maestro-cli open federation-conflicts`; `maestro-cli federation conflicts`
 * lists and settles the same conflicts without it.
 */

import { useCallback, useState } from 'react';
import { GitMerge } from 'lucide-react';
import type { Theme } from '../../types';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Spinner';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import {
	useHostedAgentSettingsStore,
	type HostedConflictSet,
} from '../../stores/hostedAgentSettingsStore';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { proposeSettingsMerge } from '../../services/hostedSettingsMerge';
import type {
	LiftSyncConflict,
	SyncValue,
} from '../../../shared/maestro-lib/agents/lift-settings-sync';

function shown(value: SyncValue): string {
	if (value === undefined) return '(not set)';
	if (typeof value === 'boolean') return value ? 'On' : 'Off';
	return String(value);
}

function ValueBox({ theme, label, value }: { theme: Theme; label: string; value: SyncValue }) {
	return (
		<div className="flex-1 min-w-0">
			<div
				className="text-2xs uppercase tracking-wide mb-1"
				style={{ color: theme.colors.textDim }}
			>
				{label}
			</div>
			<pre
				className="text-xs whitespace-pre-wrap break-words rounded border px-2 py-1.5 max-h-40 overflow-y-auto select-text font-sans"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgMain,
					color: value === undefined ? theme.colors.textDim : theme.colors.textMain,
				}}
			>
				{shown(value)}
			</pre>
		</div>
	);
}

function ConflictRow({
	theme,
	targetKey: key,
	set,
	conflict,
}: {
	theme: Theme;
	/** The conflict set's key in the store (`mirrorKey()` of the host agent). */
	targetKey: string;
	set: HostedConflictSet;
	conflict: LiftSyncConflict;
}) {
	const [merging, setMerging] = useState(false);
	const [proposal, setProposal] = useState<string | null>(null);
	const [error, setError] = useState('');
	const resolve = useHostedAgentSettingsStore((s) => s.resolve);

	const merge = useCallback(async () => {
		const peer = usePeerMirrorStore.getState().peers[set.peerId];
		const host = peer?.agents.find((agent) => agent.id === set.agentId);
		if (!peer || !host) {
			setError('The agent is not on its host right now.');
			return;
		}
		setMerging(true);
		setError('');
		try {
			setProposal(await proposeSettingsMerge(conflict, peer, host));
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setMerging(false);
		}
	}, [conflict, set.peerId, set.agentId]);

	const button = (label: string, onClick: () => void, primary = false, disabled = false) => (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="px-2.5 py-1 rounded border text-xs transition-colors hover:bg-white/5 disabled:opacity-40"
			style={{
				borderColor: primary ? theme.colors.accent : theme.colors.border,
				color: primary ? theme.colors.accent : theme.colors.textMain,
			}}
		>
			{label}
		</button>
	);

	return (
		<div
			className="rounded border p-3 space-y-2"
			style={{ borderColor: theme.colors.border }}
			data-testid={`settings-conflict-${conflict.id}`}
		>
			<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
				{conflict.label}
				{conflict.firstSync && (
					<span className="ml-2 text-2xs" style={{ color: theme.colors.textDim }}>
						first sync
					</span>
				)}
			</div>
			<div className="flex gap-3">
				<ValueBox theme={theme} label={`On ${set.peerId}`} value={conflict.host} />
				<ValueBox theme={theme} label="On this machine" value={conflict.local} />
			</div>
			{proposal !== null && (
				<div className="space-y-1">
					<div className="text-2xs uppercase tracking-wide" style={{ color: theme.colors.textDim }}>
						Proposed merge (edit before using it)
					</div>
					<textarea
						value={proposal}
						onChange={(e) => setProposal(e.target.value)}
						rows={5}
						className="w-full text-xs rounded border px-2 py-1.5 outline-none resize-y select-text"
						style={{
							borderColor: theme.colors.accent,
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textMain,
						}}
						aria-label={`Proposed merge for ${conflict.label}`}
					/>
				</div>
			)}
			{error && (
				<div className="text-xs select-text" style={{ color: theme.colors.error }}>
					{error}
				</div>
			)}
			<div className="flex gap-2 flex-wrap items-center">
				{button('Take host', () => resolve(key, conflict.id, { take: 'host' }), true)}
				{button('Keep mine', () => resolve(key, conflict.id, { take: 'local' }))}
				{conflict.mergeable &&
					proposal === null &&
					button(merging ? 'Merging...' : 'Merge', () => void merge(), false, merging)}
				{merging && <Spinner size={12} />}
				{proposal !== null &&
					button(
						'Use this',
						() => resolve(key, conflict.id, { take: 'value', value: proposal.trim() || undefined }),
						true,
						!proposal.trim()
					)}
			</div>
		</div>
	);
}

export function FederationSettingsConflictsModal({ theme }: { theme: Theme }) {
	const open = useHostedAgentSettingsStore((s) => s.conflictsOpen);
	const conflicts = useHostedAgentSettingsStore((s) => s.conflicts);
	const resolve = useHostedAgentSettingsStore((s) => s.resolve);
	const close = useCallback(
		() => useHostedAgentSettingsStore.getState().setConflictsOpen(false),
		[]
	);
	if (!open) return null;
	const sets = Object.entries(conflicts);
	const takeAllHost = () => {
		for (const [key, set] of sets) {
			for (const conflict of set.conflicts) resolve(key, conflict.id, { take: 'host' });
		}
	};
	return (
		<Modal
			theme={theme}
			title="Federation Settings Conflicts"
			priority={MODAL_PRIORITIES.FEDERATION_SETTINGS_CONFLICTS}
			onClose={close}
			headerIcon={<GitMerge className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			width={720}
			resizeKey="federationSettingsConflicts"
			defaultSize={{ width: 720, height: 560 }}
			contentClassName="p-5 overflow-y-auto flex-1 space-y-5 select-none"
			footer={
				<div className="flex gap-2 w-full justify-end">
					{sets.length > 0 && (
						<button
							type="button"
							onClick={takeAllHost}
							className="px-3 py-1.5 rounded border text-xs hover:bg-white/5 transition-colors"
							style={{ borderColor: theme.colors.accent, color: theme.colors.accent }}
						>
							Take host for all
						</button>
					)}
					<button
						type="button"
						onClick={close}
						className="px-3 py-1.5 rounded border text-xs hover:bg-white/5 transition-colors"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						Close
					</button>
				</div>
			}
		>
			{sets.length === 0 ? (
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Every hosted agent matches its host.
				</div>
			) : (
				sets.map(([key, set]) => (
					<section key={key} className="space-y-2">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							{set.agentName}
							<span className="ml-2 text-xs" style={{ color: theme.colors.textDim }}>
								on {set.peerId}
							</span>
						</div>
						{set.conflicts.map((conflict) => (
							<ConflictRow
								key={conflict.id}
								theme={theme}
								targetKey={key}
								set={set}
								conflict={conflict}
							/>
						))}
					</section>
				))
			)}
		</Modal>
	);
}
