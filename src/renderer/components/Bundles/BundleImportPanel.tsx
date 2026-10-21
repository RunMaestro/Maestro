/**
 * BundleImportPanel - import a bundle into the running app.
 *
 * Choose a bundle, see what it holds, map each of its workspaces to a local
 * folder, review the dry run (agents, files, conflicts, secrets, shell
 * commands), then import. Same importer as `maestro-cli bundle import`;
 * agents land in the Left Bar through the renderer (`useCueBundleAgentSync`).
 *
 * Shown by the Cue modal's Bundles tab and by the Left Bar's Import Agent
 * modal, which passes the group the agents go in. An exact copy (an export
 * with "Exact copy" on) restores its machine settings and suggests the
 * folders it came from, unless the user turns that off.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileArchive, FolderOpen, PackagePlus } from 'lucide-react';
import type { Theme } from '../../types';
import type { CueBundleManifest } from '../../../shared/cue-bundle-types';
import type { CueBundleFailure, CueBundleInspectOutcome } from '../../../main/cue-bundle-service';
import type { CueBundleImportPlan } from '../../../main/cue/bundle/cue-bundle-importer';
import { cueBundleService } from '../../services/cueBundle';
import { notifyToast } from '../../stores/notificationStore';
import { captureException } from '../../utils/sentry';
import { Spinner } from '../ui/Spinner';
import { BundleNotice, BundleOption, ChipList } from './bundleUi';

type Inspection = Extract<CueBundleInspectOutcome, { ok: true }>;

export interface BundleImportPanelProps {
	theme: Theme;
	/** Called after an import lands, with what it did. */
	onImported?: (plan: CueBundleImportPlan) => void;
	/** Left Bar group the created agents go in. */
	groupId?: string;
	/** Open the file chooser as soon as the panel mounts. */
	chooseOnMount?: boolean;
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

export function BundleImportPanel({
	theme,
	onImported,
	groupId,
	chooseOnMount = false,
}: BundleImportPanelProps) {
	const [inspection, setInspection] = useState<Inspection | null>(null);
	const [folders, setFolders] = useState<Record<string, string>>({});
	const [useLocal, setUseLocal] = useState(true);
	const [plan, setPlan] = useState<CueBundleImportPlan | null>(null);
	const [failure, setFailure] = useState<CueBundleFailure | null>(null);
	const [force, setForce] = useState(false);
	const [busy, setBusy] = useState<'inspect' | 'plan' | 'import' | null>(null);
	const [imported, setImported] = useState<CueBundleImportPlan | null>(null);

	const manifest = inspection?.manifest;
	const isExactCopy = !!manifest?.local;
	/** The folders an exact copy came from that exist here, suggested until the user picks another. */
	const suggested = useMemo(() => {
		const out: Record<string, string> = {};
		if (!useLocal) return out;
		for (const [key, folder] of Object.entries(inspection?.localWorkspaces ?? {})) {
			if (folder.exists) out[key] = folder.path;
		}
		return out;
	}, [inspection, useLocal]);
	const effectiveFolders = useMemo(() => ({ ...suggested, ...folders }), [suggested, folders]);
	const allMapped = useMemo(
		() => !!manifest && manifest.workspaces.every((ws) => !!effectiveFolders[ws.key]),
		[manifest, effectiveFolders]
	);

	/** Fields every plan and import request carries beyond the folders. */
	const requestExtras = useMemo(
		() => ({
			...(groupId ? { groupId } : {}),
			...(isExactCopy ? { useLocal } : {}),
		}),
		[groupId, isExactCopy, useLocal]
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
		setUseLocal(true);
		setBusy('inspect');
		try {
			const outcome = await cueBundleService.inspect(bundlePath);
			if (outcome.ok) setInspection(outcome);
			else setFailure(outcome);
		} catch (error) {
			captureException(error, { extra: { context: 'BundleImportPanel.inspect' } });
			setFailure(asFailure(error, 'BUNDLE_UNREADABLE'));
		} finally {
			setBusy(null);
		}
	}, []);

	const choseOnMount = useRef(false);
	useEffect(() => {
		if (!chooseOnMount || choseOnMount.current) return;
		choseOnMount.current = true;
		void handleChoose();
	}, [chooseOnMount, handleChoose]);

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
		// Approval to overwrite covers the conflicts the user saw, not a new plan's.
		setForce(false);
		cueBundleService
			.plan({ bundlePath: inspection.bundlePath, workspaces: effectiveFolders, ...requestExtras })
			.then((outcome) => {
				if (cancelled) return;
				if (outcome.ok) setPlan(outcome.plan);
				else setFailure(outcome);
			})
			.catch((error) => {
				if (cancelled) return;
				captureException(error, { extra: { context: 'BundleImportPanel.plan' } });
				setFailure(asFailure(error, 'WRITE_FAILED'));
			})
			.finally(() => {
				if (!cancelled) setBusy(null);
			});
		return () => {
			cancelled = true;
		};
	}, [inspection, allMapped, effectiveFolders, requestExtras]);

	const handleImport = useCallback(async () => {
		if (!inspection) return;
		setBusy('import');
		setFailure(null);
		try {
			const outcome = await cueBundleService.import({
				bundlePath: inspection.bundlePath,
				workspaces: effectiveFolders,
				force,
				...requestExtras,
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
			onImported?.(outcome.plan);
		} catch (error) {
			captureException(error, { extra: { context: 'BundleImportPanel.import' } });
			setFailure(asFailure(error, 'WRITE_FAILED'));
		} finally {
			setBusy(null);
		}
	}, [inspection, effectiveFolders, force, requestExtras, onImported]);

	const conflicts = plan?.conflicts ?? [];
	const canImport =
		!!plan && !busy && inspection?.valid === true && (conflicts.length === 0 || force);

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-3">
				<button
					onClick={handleChoose}
					disabled={busy !== null}
					className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors disabled:opacity-50"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					{busy === 'inspect' ? <Spinner size={16} /> : <FileArchive className="w-4 h-4" />}
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

			{isExactCopy && inspection?.valid && (
				<BundleNotice theme={theme} tone="warning" title="Exact copy">
					<div className="text-xs">
						Holds secret values, binary paths, SSH settings and the folders its agents lived in.
						Restore them only from a bundle you exported yourself.
					</div>
					<BundleOption
						theme={theme}
						label="Restore machine settings"
						hint="env values, binaries, SSH, other providers' settings, folders"
						checked={useLocal}
						onChange={setUseLocal}
						disabled={busy === 'import'}
					/>
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
								{effectiveFolders[ws.key] ? 'Change…' : 'Choose…'}
							</button>
							<span
								className="text-xs font-mono truncate select-text"
								style={{
									color: effectiveFolders[ws.key] ? theme.colors.textMain : theme.colors.textDim,
								}}
							>
								{effectiveFolders[ws.key] ??
									(ws.source?.gitRemote ? `clone ${ws.source.gitRemote}` : 'not chosen')}
							</span>
						</div>
					))}
				</div>
			)}

			{busy === 'plan' && (
				<div className="flex items-center gap-2 text-xs" style={{ color: theme.colors.textDim }}>
					<Spinner size={14} />
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
					{count(imported.agents.length, 'agent')} added or updated.
					{imported.cueConfigs.some((c) => c.added.length > 0 || c.replaced.length > 0)
						? ' Their Cue subscriptions are active now.'
						: ''}
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
						{busy === 'import' ? <Spinner size={16} /> : <PackagePlus className="w-4 h-4" />}
						{busy === 'import' ? 'Importing…' : 'Import'}
					</button>
				</div>
			)}
		</div>
	);
}

function PlanSummary({ theme, plan }: { theme: Theme; plan: CueBundleImportPlan }) {
	const byAction = (action: 'create' | 'overwrite' | 'unchanged') =>
		plan.files.filter((f) => f.action === action).length;
	const unsetSecrets = plan.secrets.filter((s) => !s.set);
	const added = plan.cueConfigs.flatMap((c) => c.added);
	const replaced = plan.cueConfigs.flatMap((c) => c.replaced);
	const binaries = plan.local?.applied
		? plan.local.agents.flatMap((a) => a.binaries.map((b) => `${a.agentName}: ${b}`))
		: [];

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

			{binaries.length > 0 && (
				<BundleNotice theme={theme} tone="warning" title="Runs these binaries">
					<ul className="text-xs font-mono space-y-0.5">
						{binaries.map((b) => (
							<li key={b} className="break-all">
								{b}
							</li>
						))}
					</ul>
				</BundleNotice>
			)}

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
