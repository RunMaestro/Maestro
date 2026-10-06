/**
 * BundleImportSection - Cue modal Bundles tab, import half.
 *
 * Choose a bundle, see what it holds, map each of its workspaces to a local
 * folder, review the dry run (agents, files, conflicts, secrets, shell
 * commands), then import into the running app. Same importer as
 * `maestro-cli bundle import`; agents land in the Left Bar through the
 * renderer (`useCueBundleAgentSync`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileArchive, FolderOpen, Loader2, PackagePlus } from 'lucide-react';
import type { Theme } from '../../../types';
import type { CueBundleManifest } from '../../../../shared/cue-bundle-types';
import type {
	CueBundleFailure,
	CueBundleInspectOutcome,
} from '../../../../main/cue-bundle-service';
import type { CueBundleImportPlan } from '../../../../main/cue/bundle/cue-bundle-importer';
import { cueBundleService } from '../../../services/cueBundle';
import { notifyToast } from '../../../stores/notificationStore';
import { captureException } from '../../../utils/sentry';
import { BundleNotice, BundleSection, ChipList } from './bundleUi';

type Inspection = Extract<CueBundleInspectOutcome, { ok: true }>;

export interface BundleImportSectionProps {
	theme: Theme;
	/** Called after an import lands, so the modal can refresh its pipelines. */
	onImported?: () => void;
}

function asFailure(error: unknown, code: string): CueBundleFailure {
	return { ok: false, code, message: error instanceof Error ? error.message : String(error) };
}

function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function claudeSummary(manifest: CueBundleManifest): string[] {
	const lines: string[] = [];
	for (const ws of manifest.workspaces) {
		const c = ws.claude;
		if (!c) continue;
		const parts = [
			c.skills?.length ? count(c.skills.length, 'skill') : '',
			c.mcpServers?.length ? count(c.mcpServers.length, 'MCP server') : '',
			c.projectMemory?.length || c.autoMemory?.length
				? count((c.projectMemory?.length ?? 0) + (c.autoMemory?.length ?? 0), 'memory file')
				: '',
		].filter(Boolean);
		if (parts.length > 0) lines.push(`${ws.key}: ${parts.join(', ')}`);
	}
	return lines;
}

export function BundleImportSection({ theme, onImported }: BundleImportSectionProps) {
	const [inspection, setInspection] = useState<Inspection | null>(null);
	const [folders, setFolders] = useState<Record<string, string>>({});
	const [plan, setPlan] = useState<CueBundleImportPlan | null>(null);
	const [failure, setFailure] = useState<CueBundleFailure | null>(null);
	const [force, setForce] = useState(false);
	const [busy, setBusy] = useState<'inspect' | 'plan' | 'import' | null>(null);
	const [imported, setImported] = useState<CueBundleImportPlan | null>(null);

	const manifest = inspection?.manifest;
	const allMapped = useMemo(
		() => !!manifest && manifest.workspaces.every((ws) => !!folders[ws.key]),
		[manifest, folders]
	);

	const reset = () => {
		setPlan(null);
		setFailure(null);
		setForce(false);
		setImported(null);
	};

	const handleChoose = useCallback(async () => {
		const bundlePath = await cueBundleService.chooseFile();
		if (!bundlePath) return;
		reset();
		setInspection(null);
		setFolders({});
		setBusy('inspect');
		try {
			const outcome = await cueBundleService.inspect(bundlePath);
			if (outcome.ok) setInspection(outcome);
			else setFailure(outcome);
		} catch (error) {
			captureException(error, { extra: { context: 'BundleImportSection.inspect' } });
			setFailure(asFailure(error, 'BUNDLE_UNREADABLE'));
		} finally {
			setBusy(null);
		}
	}, []);

	const handlePickFolder = useCallback(async (key: string) => {
		const folder = await window.maestro.dialog.selectFolder();
		if (!folder) return;
		setFolders((prev) => ({ ...prev, [key]: folder }));
	}, []);

	// Dry run whenever the bundle and its folders are all known.
	useEffect(() => {
		if (!inspection?.valid || !allMapped) return;
		let cancelled = false;
		setBusy('plan');
		setPlan(null);
		setFailure(null);
		setImported(null);
		cueBundleService
			.plan({ bundlePath: inspection.bundlePath, workspaces: folders })
			.then((outcome) => {
				if (cancelled) return;
				if (outcome.ok) setPlan(outcome.plan);
				else setFailure(outcome);
			})
			.catch((error) => {
				if (cancelled) return;
				captureException(error, { extra: { context: 'BundleImportSection.plan' } });
				setFailure(asFailure(error, 'WRITE_FAILED'));
			})
			.finally(() => {
				if (!cancelled) setBusy(null);
			});
		return () => {
			cancelled = true;
		};
	}, [inspection, allMapped, folders]);

	const handleImport = useCallback(async () => {
		if (!inspection) return;
		setBusy('import');
		setFailure(null);
		try {
			const outcome = await cueBundleService.import({
				bundlePath: inspection.bundlePath,
				workspaces: folders,
				force,
			});
			if (!outcome.ok) {
				setFailure(outcome);
				return;
			}
			setImported(outcome.plan);
			setPlan(null);
			notifyToast({
				color: 'green',
				title: 'Bundle imported',
				message: `${outcome.plan.bundle.name}: ${count(outcome.plan.agents.length, 'agent')}`,
			});
			onImported?.();
		} catch (error) {
			captureException(error, { extra: { context: 'BundleImportSection.import' } });
			setFailure(asFailure(error, 'WRITE_FAILED'));
		} finally {
			setBusy(null);
		}
	}, [inspection, folders, force, onImported]);

	const conflicts = plan?.conflicts ?? [];
	const canImport =
		!!plan && !busy && inspection?.valid === true && (conflicts.length === 0 || force);

	return (
		<BundleSection theme={theme} title="Import" icon={PackagePlus}>
			<div className="flex items-center gap-3">
				<button
					onClick={handleChoose}
					disabled={busy !== null}
					className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors disabled:opacity-50"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					{busy === 'inspect' ? (
						<Loader2 className="w-4 h-4 animate-spin" />
					) : (
						<FileArchive className="w-4 h-4" />
					)}
					Choose Bundle…
				</button>
				{inspection && (
					<span
						className="text-xs font-mono truncate select-text"
						style={{ color: theme.colors.textDim }}
						title={inspection.bundlePath}
					>
						{inspection.bundlePath}
					</span>
				)}
			</div>

			{manifest && (
				<div className="space-y-2 text-sm select-text" style={{ color: theme.colors.textMain }}>
					<div>
						<span className="font-medium">{manifest.name}</span>{' '}
						<span style={{ color: theme.colors.textDim }}>
							{manifest.kind === 'maestro-pipeline' ? 'pipeline' : 'agent'} from Maestro{' '}
							{manifest.producer.version}
						</span>
					</div>
					<ChipList
						theme={theme}
						label="Agents"
						items={manifest.agents.map((a) => `${a.name} (${a.toolType})`)}
					/>
					{claudeSummary(manifest).length > 0 && (
						<ChipList theme={theme} label="Claude Code assets" items={claudeSummary(manifest)} />
					)}
					{manifest.requirements.tools.length > 0 && (
						<ChipList theme={theme} label="Tools it needs" items={manifest.requirements.tools} />
					)}
				</div>
			)}

			{inspection && !inspection.valid && (
				<BundleNotice theme={theme} tone="error" title="This bundle cannot be imported">
					<ul className="list-disc pl-4 text-xs">
						{inspection.errors.map((issue) => (
							<li key={`${issue.code}:${issue.file ?? ''}:${issue.message}`}>{issue.message}</li>
						))}
					</ul>
				</BundleNotice>
			)}

			{manifest && inspection?.valid && (
				<div className="space-y-2">
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Folder for each workspace (usually a clone of the project)
					</div>
					{manifest.workspaces.map((ws) => (
						<div key={ws.key} className="flex items-center gap-3 text-sm">
							<span className="w-32 shrink-0 font-mono" style={{ color: theme.colors.textMain }}>
								{ws.key}
							</span>
							<button
								onClick={() => handlePickFolder(ws.key)}
								disabled={busy === 'import'}
								aria-label={`Choose the folder for workspace ${ws.key}`}
								className="flex items-center gap-1.5 px-2 py-1 rounded border text-xs disabled:opacity-50"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							>
								<FolderOpen className="w-3.5 h-3.5" />
								{folders[ws.key] ? 'Change…' : 'Choose…'}
							</button>
							<span
								className="text-xs font-mono truncate select-text"
								style={{ color: folders[ws.key] ? theme.colors.textMain : theme.colors.textDim }}
							>
								{folders[ws.key] ??
									(ws.source?.gitRemote ? `clone ${ws.source.gitRemote}` : 'not chosen')}
							</span>
						</div>
					))}
				</div>
			)}

			{busy === 'plan' && (
				<div className="flex items-center gap-2 text-xs" style={{ color: theme.colors.textDim }}>
					<Loader2 className="w-3.5 h-3.5 animate-spin" />
					Checking what the import would do…
				</div>
			)}

			{plan && <PlanSummary theme={theme} plan={plan} />}

			{conflicts.length > 0 && (
				<BundleNotice theme={theme} tone="warning" title={count(conflicts.length, 'conflict')}>
					<ul className="list-disc pl-4 text-xs">
						{conflicts.map((c) => (
							<li key={`${c.kind}:${c.target}`}>{c.message}</li>
						))}
					</ul>
					<label className="flex items-center gap-2 text-xs cursor-pointer">
						<input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
						Overwrite them with the bundle's version
					</label>
				</BundleNotice>
			)}

			{failure && (
				<BundleNotice theme={theme} tone="error" title="Import refused">
					{failure.message}
				</BundleNotice>
			)}

			{imported && (
				<BundleNotice theme={theme} tone="success" title={`Imported ${imported.bundle.name}`}>
					{count(imported.agents.length, 'agent')} added or updated. Their Cue subscriptions are
					active now.
				</BundleNotice>
			)}

			{plan && (
				<div>
					<button
						onClick={handleImport}
						disabled={!canImport}
						className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
					>
						{busy === 'import' ? (
							<Loader2 className="w-4 h-4 animate-spin" />
						) : (
							<PackagePlus className="w-4 h-4" />
						)}
						{busy === 'import' ? 'Importing…' : 'Import'}
					</button>
				</div>
			)}
		</BundleSection>
	);
}

function PlanSummary({ theme, plan }: { theme: Theme; plan: CueBundleImportPlan }) {
	const byAction = (action: 'create' | 'overwrite' | 'unchanged') =>
		plan.files.filter((f) => f.action === action).length;
	const unsetSecrets = plan.secrets.filter((s) => !s.set);
	const added = plan.cueConfigs.flatMap((c) => c.added);
	const replaced = plan.cueConfigs.flatMap((c) => c.replaced);

	return (
		<div className="space-y-2 text-sm select-text" style={{ color: theme.colors.textMain }}>
			<ul className="text-xs space-y-0.5">
				{plan.agents.map((a) => (
					<li key={a.id}>
						<span className="font-medium">{a.action === 'create' ? 'Add' : 'Update'}</span> {a.name}{' '}
						({a.toolType}) in <span className="font-mono">{a.cwd}</span>
					</li>
				))}
				<li>
					Files: {byAction('create')} new, {byAction('overwrite')} changed, {byAction('unchanged')}{' '}
					unchanged
				</li>
				{(added.length > 0 || replaced.length > 0) && (
					<li>
						Subscriptions: {added.length} added
						{replaced.length > 0 ? `, ${replaced.length} replaced` : ''}
					</li>
				)}
				{plan.pipeline && <li>Pipeline layout: {plan.pipeline.name}</li>}
			</ul>

			{plan.shellCommands.length > 0 && (
				<BundleNotice theme={theme} tone="warning" title="Runs shell commands on this machine">
					<ul className="text-xs font-mono space-y-0.5">
						{plan.shellCommands.map((c) => (
							<li key={`${c.workspace}:${c.subscription}`} className="break-all">
								{c.subscription}: {c.command}
							</li>
						))}
					</ul>
				</BundleNotice>
			)}

			{unsetSecrets.length > 0 && (
				<BundleNotice theme={theme} tone="info" title="Set these before the agents run">
					<ChipList
						theme={theme}
						label="Environment variables not set here"
						items={unsetSecrets.map((s) => s.name)}
					/>
				</BundleNotice>
			)}

			{plan.warnings.length > 0 && (
				<ul className="text-xs list-disc pl-4" style={{ color: theme.colors.warning }}>
					{plan.warnings.map((w) => (
						<li key={w}>{w}</li>
					))}
				</ul>
			)}
		</div>
	);
}
