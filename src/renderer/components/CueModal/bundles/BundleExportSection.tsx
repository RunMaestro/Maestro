/**
 * BundleExportSection - Cue modal Bundles tab, export half.
 *
 * Exports one pipeline to a portable zip, with the Claude Code assets
 * (skills, MCP servers, memory) of the workspaces its Claude agents work in.
 * Same exporter as `maestro-cli bundle export --pipeline`. One agent is
 * exported from the Left Bar instead (right-click, Export Agent...).
 */

import { useCallback, useEffect, useState } from 'react';
import { PackageOpen } from 'lucide-react';
import type { Theme } from '../../../types';
import {
	bundleFileName,
	type CueBundleClaudeAssetSelection,
} from '../../../../shared/cue-bundle-types';
import type { CueBundleExportOutcome } from '../../../../main/cue-bundle-service';
import { cueBundleService } from '../../../services/cueBundle';
import { notifyToast } from '../../../stores/notificationStore';
import { captureException } from '../../../utils/sentry';
import { Spinner } from '../../ui/Spinner';
import {
	ALL_CLAUDE_ASSETS,
	BundleSection,
	ClaudeAssetOptions,
	ExportResultNotice,
} from '../../Bundles/bundleUi';

export interface BundleExportSectionProps {
	theme: Theme;
	pipelines: ReadonlyArray<{ id: string; name: string }>;
}

export function BundleExportSection({ theme, pipelines }: BundleExportSectionProps) {
	const [pipelineName, setPipelineName] = useState(pipelines[0]?.name ?? '');
	const [assets, setAssets] = useState<Required<CueBundleClaudeAssetSelection>>(ALL_CLAUDE_ASSETS);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<CueBundleExportOutcome | null>(null);

	// Keep the selection on something that exists as the list changes.
	useEffect(() => {
		if (!pipelines.some((p) => p.name === pipelineName)) setPipelineName(pipelines[0]?.name ?? '');
	}, [pipelines, pipelineName]);

	const handleExport = useCallback(async () => {
		if (!pipelineName) return;
		const outputPath = await window.maestro.dialog.saveFile({
			title: 'Export Pipeline',
			defaultPath: bundleFileName(pipelineName),
			filters: [{ name: 'Maestro bundle', extensions: ['zip'] }],
		});
		if (!outputPath) return;
		setBusy(true);
		setResult(null);
		try {
			const outcome = await cueBundleService.export({
				pipeline: pipelineName,
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
	}, [pipelineName, assets]);

	return (
		<BundleSection theme={theme} title="Export Pipeline" icon={PackageOpen}>
			<div className="flex flex-wrap items-center gap-3">
				{pipelines.length === 0 ? (
					<span className="text-sm" style={{ color: theme.colors.textDim }}>
						No pipelines yet.
					</span>
				) : (
					<select
						aria-label="Pipeline to export"
						className="px-2 py-1 rounded border text-sm min-w-[14rem]"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						value={pipelineName}
						onChange={(e) => setPipelineName(e.target.value)}
					>
						{pipelines.map((p) => (
							<option key={p.id} value={p.name}>
								{p.name}
							</option>
						))}
					</select>
				)}
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					To export one agent, right-click it in the Left Bar.
				</span>
			</div>

			<ClaudeAssetOptions
				theme={theme}
				legend="Claude Code assets, for workspaces a Claude Code agent works in"
				value={assets}
				onChange={setAssets}
			/>

			<div>
				<button
					onClick={handleExport}
					disabled={busy || !pipelineName}
					className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
				>
					{busy ? <Spinner size={16} /> : <PackageOpen className="w-4 h-4" />}
					{busy ? 'Exporting…' : 'Export…'}
				</button>
			</div>

			{result && <ExportResultNotice theme={theme} result={result} />}
		</BundleSection>
	);
}
