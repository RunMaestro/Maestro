/**
 * BundleExportSection - Cue modal Bundles tab, export half.
 *
 * Exports one pipeline or one agent to a portable zip, with the Claude Code
 * assets (skills, MCP servers, memory) of the workspaces its Claude agents
 * work in. Same exporter as `maestro-cli bundle export`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderOpen, Loader2, PackageOpen } from 'lucide-react';
import type { Theme } from '../../../types';
import type { CueBundleClaudeAssetSelection } from '../../../../shared/cue-bundle-types';
import type { CueBundleExportOutcome } from '../../../../main/cue-bundle-service';
import { cueBundleService } from '../../../services/cueBundle';
import { notifyToast } from '../../../stores/notificationStore';
import { captureException } from '../../../utils/sentry';
import { formatSize } from '../../../../shared/formatters';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { BundleNotice, BundleSection, ChipList } from './bundleUi';

type ExportKind = 'pipeline' | 'agent';

export interface BundleExportSectionProps {
	theme: Theme;
	pipelines: ReadonlyArray<{ id: string; name: string }>;
	agents: ReadonlyArray<{ id: string; name: string; toolType: string }>;
}

const KIND_OPTIONS = [
	{ value: 'pipeline', label: 'Pipeline' },
	{ value: 'agent', label: 'Agent' },
] as const;

const ASSET_OPTIONS: ReadonlyArray<{
	key: keyof CueBundleClaudeAssetSelection;
	label: string;
	hint: string;
}> = [
	{ key: 'skills', label: 'Skills', hint: '.claude/skills' },
	{ key: 'mcp', label: 'MCP servers', hint: '.mcp.json, secrets become ${VAR} references' },
	{
		key: 'memory',
		label: 'Memory',
		hint: 'CLAUDE.md and auto memory, secret-looking tokens redacted',
	},
];

function fileSlug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'bundle'
	);
}

export function BundleExportSection({ theme, pipelines, agents }: BundleExportSectionProps) {
	const [kind, setKind] = useState<ExportKind>(pipelines.length > 0 ? 'pipeline' : 'agent');
	const [pipelineName, setPipelineName] = useState(pipelines[0]?.name ?? '');
	const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
	const [assets, setAssets] = useState<Required<CueBundleClaudeAssetSelection>>({
		skills: true,
		mcp: true,
		memory: true,
	});
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<CueBundleExportOutcome | null>(null);

	// Keep the selection on something that exists as the lists change.
	useEffect(() => {
		if (!pipelines.some((p) => p.name === pipelineName)) setPipelineName(pipelines[0]?.name ?? '');
	}, [pipelines, pipelineName]);
	useEffect(() => {
		if (!agents.some((a) => a.id === agentId)) setAgentId(agents[0]?.id ?? '');
	}, [agents, agentId]);

	const targetName = useMemo(
		() => (kind === 'pipeline' ? pipelineName : agents.find((a) => a.id === agentId)?.name),
		[kind, pipelineName, agents, agentId]
	);

	const handleExport = useCallback(async () => {
		if (!targetName) return;
		const outputPath = await window.maestro.dialog.saveFile({
			title: 'Export Bundle',
			defaultPath: `${fileSlug(targetName)}.maestro-bundle.zip`,
			filters: [{ name: 'Maestro bundle', extensions: ['zip'] }],
		});
		if (!outputPath) return;
		setBusy(true);
		setResult(null);
		try {
			const outcome = await cueBundleService.export({
				...(kind === 'pipeline' ? { pipeline: targetName } : { agentId }),
				outputPath,
				claudeAssets: assets,
			});
			setResult(outcome);
			if (outcome.ok) {
				notifyToast({
					color: 'green',
					title: 'Bundle exported',
					message: `${outcome.manifest.name} saved to ${outcome.outputPath}`,
				});
			}
		} catch (error) {
			captureException(error, { extra: { context: 'BundleExportSection.handleExport' } });
			setResult({
				ok: false,
				code: 'EXPORT_FAILED',
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(false);
		}
	}, [targetName, kind, agentId, assets]);

	const options = kind === 'pipeline' ? pipelines : agents;
	const selectStyle = {
		backgroundColor: theme.colors.bgMain,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};

	return (
		<BundleSection theme={theme} title="Export" icon={PackageOpen}>
			<div className="flex flex-wrap items-center gap-3">
				<SegmentedControl
					value={kind}
					onChange={(value) => {
						setKind(value);
						setResult(null);
					}}
					options={KIND_OPTIONS}
					theme={theme}
					ariaLabel="What to export"
				/>
				{options.length === 0 ? (
					<span className="text-sm" style={{ color: theme.colors.textDim }}>
						{kind === 'pipeline' ? 'No pipelines yet.' : 'No agents yet.'}
					</span>
				) : (
					<select
						aria-label={kind === 'pipeline' ? 'Pipeline to export' : 'Agent to export'}
						className="px-2 py-1 rounded border text-sm min-w-[14rem]"
						style={selectStyle}
						value={kind === 'pipeline' ? pipelineName : agentId}
						onChange={(e) =>
							kind === 'pipeline' ? setPipelineName(e.target.value) : setAgentId(e.target.value)
						}
					>
						{kind === 'pipeline'
							? pipelines.map((p) => (
									<option key={p.id} value={p.name}>
										{p.name}
									</option>
								))
							: agents.map((a) => (
									<option key={a.id} value={a.id}>
										{a.name}
									</option>
								))}
					</select>
				)}
			</div>

			<fieldset className="space-y-1.5">
				<legend className="text-xs mb-1" style={{ color: theme.colors.textDim }}>
					Claude Code assets, for workspaces a Claude Code agent works in
				</legend>
				{ASSET_OPTIONS.map(({ key, label, hint }) => (
					<label
						key={key}
						className="flex items-center gap-2 text-sm cursor-pointer"
						style={{ color: theme.colors.textMain }}
					>
						<input
							type="checkbox"
							checked={assets[key]}
							onChange={(e) => setAssets((prev) => ({ ...prev, [key]: e.target.checked }))}
						/>
						{label}
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{hint}
						</span>
					</label>
				))}
			</fieldset>

			<div>
				<button
					onClick={handleExport}
					disabled={busy || !targetName}
					className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
				>
					{busy ? (
						<Loader2 className="w-4 h-4 animate-spin" />
					) : (
						<PackageOpen className="w-4 h-4" />
					)}
					{busy ? 'Exporting…' : 'Export…'}
				</button>
			</div>

			{result && !result.ok && (
				<BundleNotice theme={theme} tone="error" title="Export failed">
					<div className="whitespace-pre-line break-words">{result.message}</div>
				</BundleNotice>
			)}
			{result?.ok && (
				<BundleNotice theme={theme} tone="success" title={`Exported ${result.manifest.name}`}>
					<div className="flex items-center gap-2">
						<span className="font-mono text-xs break-all">{result.outputPath}</span>
						<button
							onClick={() => void window.maestro.shell.showItemInFolder(result.outputPath)}
							className="p-1 rounded hover:bg-white/10"
							title="Show in folder"
							aria-label="Show in folder"
						>
							<FolderOpen className="w-3.5 h-3.5" />
						</button>
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						{formatSize(result.size)} · {result.manifest.agents.length} agent
						{result.manifest.agents.length === 1 ? '' : 's'} · {result.manifest.files.length} file
						{result.manifest.files.length === 1 ? '' : 's'}
					</div>
					{result.manifest.requirements.secrets.length > 0 && (
						<ChipList
							theme={theme}
							label="Secrets to set where it is imported"
							items={result.manifest.requirements.secrets}
						/>
					)}
					{result.manifest.warnings && result.manifest.warnings.length > 0 && (
						<ul className="text-xs list-disc pl-4" style={{ color: theme.colors.warning }}>
							{result.manifest.warnings.map((w) => (
								<li key={w}>{w}</li>
							))}
						</ul>
					)}
				</BundleNotice>
			)}
		</BundleSection>
	);
}
