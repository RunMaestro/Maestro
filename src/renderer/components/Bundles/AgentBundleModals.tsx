/**
 * Export Agent and Import Agent: the Left Bar's way in to bundles.
 *
 * Right-click an agent for Export Agent... One export, with options: its Cue
 * subscriptions (when Cue is on), its Claude Code assets (for a Claude Code
 * agent), and an exact copy that also carries secret values, binary paths,
 * SSH and other providers' settings, so export, delete, import on the same
 * machine gives back the same agent. Right-click a group for Import Agent...,
 * which lands the bundle's new agents in that group.
 *
 * Same exporter and importer as `maestro-cli bundle export --agent` and
 * `maestro-cli bundle import --group`.
 */

import { useCallback, useState } from 'react';
import { PackageOpen, PackagePlus } from 'lucide-react';
import type { Session, Theme } from '../../types';
import {
	bundleFileName,
	type CueBundleClaudeAssetSelection,
} from '../../../shared/cue-bundle-types';
import type { CueBundleExportOutcome } from '../../../main/cue-bundle-service';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { selectModalData, selectModalOpen, useModalStore } from '../../stores/modalStore';
import { selectSessionById, useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { notifyToast } from '../../stores/notificationStore';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { cueBundleService } from '../../services/cueBundle';
import { captureException } from '../../utils/sentry';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Spinner';
import { BundleImportPanel } from './BundleImportPanel';
import {
	ALL_CLAUDE_ASSETS,
	BundleNotice,
	BundleOption,
	ClaudeAssetOptions,
	ExportResultNotice,
} from './bundleUi';

/** Mounts the Export Agent and Import Agent modals from the modal store. */
export function AgentBundleModals({ theme }: { theme: Theme }) {
	const exportOpen = useModalStore(selectModalOpen('agentExport'));
	const exportData = useModalStore(selectModalData('agentExport'));
	const importOpen = useModalStore(selectModalOpen('agentImport'));
	const importData = useModalStore(selectModalData('agentImport'));
	const session = useSessionStore(selectSessionById(exportData?.sessionId ?? ''));
	const closeModal = useModalStore((s) => s.closeModal);

	return (
		<>
			{exportOpen && session && (
				<AgentExportModal
					theme={theme}
					session={session}
					onClose={() => closeModal('agentExport')}
				/>
			)}
			{importOpen && (
				<AgentImportModal
					theme={theme}
					groupId={importData?.groupId}
					onClose={() => closeModal('agentImport')}
				/>
			)}
		</>
	);
}

export function AgentExportModal({
	theme,
	session,
	onClose,
}: {
	theme: Theme;
	session: Session;
	onClose: () => void;
}) {
	const cueEnabled = useSettingsStore((s) => s.encoreFeatures?.maestroCue === true);
	const isClaude = session.toolType === 'claude-code';
	const [includeCue, setIncludeCue] = useState(true);
	const [assets, setAssets] = useState<Required<CueBundleClaudeAssetSelection>>(ALL_CLAUDE_ASSETS);
	const exact = usePersistedToggle('agentExport.exactCopy', false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<CueBundleExportOutcome | null>(null);

	const handleExport = useCallback(async () => {
		const outputPath = await window.maestro.dialog.saveFile({
			title: 'Export Agent',
			defaultPath: bundleFileName(session.name),
			filters: [{ name: 'Maestro bundle', extensions: ['zip'] }],
		});
		if (!outputPath) return;
		setBusy(true);
		setResult(null);
		try {
			const outcome = await cueBundleService.export({
				agentId: session.id,
				outputPath,
				// With Cue off the agent's subscriptions stay out entirely.
				includeCue: cueEnabled && includeCue,
				includeLocal: exact.value,
				...(isClaude ? { claudeAssets: assets } : {}),
			});
			setResult(outcome);
			if (outcome.ok) {
				notifyToast({
					color: 'green',
					title: 'Agent exported',
					message: `${outcome.manifest.name} saved to ${outcome.outputPath}`,
				});
			}
		} catch (error) {
			captureException(error, { extra: { context: 'AgentExportModal.handleExport' } });
			setResult({
				ok: false,
				code: 'EXPORT_FAILED',
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(false);
		}
	}, [session.id, session.name, cueEnabled, includeCue, exact.value, isClaude, assets]);

	const done = result?.ok === true;

	return (
		<Modal
			theme={theme}
			title="Export Agent"
			subtitle={session.name}
			priority={MODAL_PRIORITIES.AGENT_EXPORT}
			onClose={onClose}
			headerIcon={<PackageOpen className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			width={560}
			resizeKey="agentExport"
			defaultSize={{ width: 560, height: 460 }}
			contentClassName="p-5 overflow-y-auto flex-1 space-y-4 select-none"
			footer={
				<div className="flex gap-2 w-full justify-end">
					<button
						type="button"
						onClick={onClose}
						className="px-3 py-1.5 rounded border text-xs hover:bg-white/5 transition-colors"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						{done ? 'Done' : 'Cancel'}
					</button>
					<button
						type="button"
						onClick={handleExport}
						disabled={busy}
						className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
					>
						{busy ? <Spinner size={14} /> : <PackageOpen className="w-3.5 h-3.5" />}
						{busy ? 'Exporting…' : done ? 'Export Again…' : 'Export…'}
					</button>
				</div>
			}
		>
			<fieldset className="space-y-1.5">
				<legend className="text-xs mb-1" style={{ color: theme.colors.textDim }}>
					Always included: provider, model, effort, working directory, environment, messages,
					resilience settings, playbooks and Auto Run documents
				</legend>
				{cueEnabled && (
					<BundleOption
						theme={theme}
						label="Cue subscriptions"
						hint="the ones this agent runs, with their prompt files"
						checked={includeCue}
						onChange={setIncludeCue}
					/>
				)}
			</fieldset>

			{isClaude && (
				<ClaudeAssetOptions
					theme={theme}
					legend="Claude Code assets of the agent's project"
					value={assets}
					onChange={setAssets}
				/>
			)}

			<fieldset className="space-y-1.5">
				<legend className="text-xs mb-1" style={{ color: theme.colors.textDim }}>
					Restoring on this machine
				</legend>
				<BundleOption
					theme={theme}
					label="Exact copy"
					hint="secret values, binary paths, SSH, other providers' settings, folders"
					checked={exact.value}
					onChange={exact.setValue}
				/>
				{exact.value && (
					<BundleNotice theme={theme} tone="warning">
						<div className="text-xs">
							The file will hold secret values and local paths. Use it to restore this agent here;
							do not share it.
						</div>
					</BundleNotice>
				)}
			</fieldset>

			{result && <ExportResultNotice theme={theme} result={result} />}
		</Modal>
	);
}

export function AgentImportModal({
	theme,
	groupId,
	onClose,
}: {
	theme: Theme;
	groupId?: string;
	onClose: () => void;
}) {
	const groupName = useSessionStore((s) =>
		groupId ? s.groups.find((g) => g.id === groupId)?.name : undefined
	);
	return (
		<Modal
			theme={theme}
			title="Import Agent"
			subtitle={groupName}
			priority={MODAL_PRIORITIES.AGENT_IMPORT}
			onClose={onClose}
			headerIcon={<PackagePlus className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			width={640}
			resizeKey="agentImport"
			defaultSize={{ width: 640, height: 560 }}
			contentClassName="p-5 overflow-y-auto flex-1 select-none"
		>
			<BundleImportPanel theme={theme} groupId={groupId} chooseOnMount />
		</Modal>
	);
}
