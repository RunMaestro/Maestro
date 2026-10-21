/**
 * Layout pieces every bundle surface shares: the Cue modal's Bundles tab and
 * the Left Bar's Export Agent and Import Agent modals.
 */

import type { ReactNode } from 'react';
import { FolderOpen, type LucideIcon } from 'lucide-react';
import type { Theme } from '../../types';
import type { CueBundleClaudeAssetSelection } from '../../../shared/cue-bundle-types';
import type { CueBundleExportOutcome } from '../../../main/cue-bundle-service';
import { formatSize } from '../../../shared/formatters';

export function BundleSection({
	theme,
	title,
	icon: Icon,
	children,
}: {
	theme: Theme;
	title: string;
	icon: LucideIcon;
	children: ReactNode;
}) {
	return (
		<section
			className="rounded-lg border p-4 space-y-3"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			<h3
				className="flex items-center gap-2 text-sm font-semibold"
				style={{ color: theme.colors.textMain }}
			>
				<Icon className="w-4 h-4" style={{ color: theme.colors.accent }} />
				{title}
			</h3>
			{children}
		</section>
	);
}

type Tone = 'success' | 'warning' | 'error' | 'info';

/** A tinted box for a result, a warning or a refusal. Its text is selectable. */
export function BundleNotice({
	theme,
	tone,
	title,
	children,
}: {
	theme: Theme;
	tone: Tone;
	title?: string;
	children?: ReactNode;
}) {
	const color = tone === 'info' ? theme.colors.accent : theme.colors[tone];
	return (
		<div
			role={tone === 'error' ? 'alert' : undefined}
			className="rounded-md border px-3 py-2 text-sm space-y-1.5 select-text"
			style={{
				borderColor: `${color}66`,
				backgroundColor: `${color}14`,
				color: theme.colors.textMain,
			}}
		>
			{title && (
				<div className="font-medium" style={{ color }}>
					{title}
				</div>
			)}
			{children}
		</div>
	);
}

export function ChipList({
	theme,
	label,
	items,
	render,
}: {
	theme: Theme;
	label: string;
	items: ReadonlyArray<string>;
	render?: (item: string) => ReactNode;
}) {
	return (
		<div className="text-xs space-y-1">
			<div style={{ color: theme.colors.textDim }}>{label}</div>
			<div className="flex flex-wrap gap-1.5">
				{items.map((item) => (
					<span
						key={item}
						className="px-1.5 py-0.5 rounded font-mono"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
					>
						{render ? render(item) : item}
					</span>
				))}
			</div>
		</div>
	);
}

/** One checkbox row: a label and a dim hint beside it. */
export function BundleOption({
	theme,
	label,
	hint,
	checked,
	onChange,
	disabled,
}: {
	theme: Theme;
	label: string;
	hint?: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
}) {
	return (
		<label
			className={`flex items-center gap-2 text-sm ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
			style={{ color: theme.colors.textMain }}
		>
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={(e) => onChange(e.target.checked)}
			/>
			{label}
			{hint && (
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					{hint}
				</span>
			)}
		</label>
	);
}

export const CLAUDE_ASSET_OPTIONS: ReadonlyArray<{
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

export const ALL_CLAUDE_ASSETS: Required<CueBundleClaudeAssetSelection> = {
	skills: true,
	mcp: true,
	memory: true,
};

/** The Claude Code asset checkboxes of an export. */
export function ClaudeAssetOptions({
	theme,
	legend,
	value,
	onChange,
}: {
	theme: Theme;
	legend: string;
	value: Required<CueBundleClaudeAssetSelection>;
	onChange: (next: Required<CueBundleClaudeAssetSelection>) => void;
}) {
	return (
		<fieldset className="space-y-1.5">
			<legend className="text-xs mb-1" style={{ color: theme.colors.textDim }}>
				{legend}
			</legend>
			{CLAUDE_ASSET_OPTIONS.map(({ key, label, hint }) => (
				<BundleOption
					key={key}
					theme={theme}
					label={label}
					hint={hint}
					checked={value[key]}
					onChange={(checked) => onChange({ ...value, [key]: checked })}
				/>
			))}
		</fieldset>
	);
}

/** What an export produced, or why it was refused. */
export function ExportResultNotice({
	theme,
	result,
}: {
	theme: Theme;
	result: CueBundleExportOutcome;
}) {
	if (!result.ok) {
		return (
			<BundleNotice theme={theme} tone="error" title="Export failed">
				<div className="whitespace-pre-line break-words">{result.message}</div>
			</BundleNotice>
		);
	}
	const { manifest } = result;
	return (
		<BundleNotice theme={theme} tone="success" title={`Exported ${manifest.name}`}>
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
				{formatSize(result.size)} · {manifest.agents.length} agent
				{manifest.agents.length === 1 ? '' : 's'} · {manifest.files.length} file
				{manifest.files.length === 1 ? '' : 's'}
			</div>
			{manifest.local ? (
				<div className="text-xs" style={{ color: theme.colors.warning }}>
					Exact copy: holds secret values and local paths. Keep it private.
				</div>
			) : (
				manifest.requirements.secrets.length > 0 && (
					<ChipList
						theme={theme}
						label="Secrets to set where it is imported"
						items={manifest.requirements.secrets}
					/>
				)
			)}
			{manifest.warnings && manifest.warnings.length > 0 && (
				<ul className="text-xs list-disc pl-4" style={{ color: theme.colors.warning }}>
					{manifest.warnings.map((w) => (
						<li key={w}>{w}</li>
					))}
				</ul>
			)}
		</BundleNotice>
	);
}
