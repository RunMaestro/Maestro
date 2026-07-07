import type { ReactNode } from 'react';
import type { Theme } from '../../types';
import { metadataLabel } from './dashboardHelpers';

export function DetailLine({ label, value }: { label: string; value: unknown }) {
	const rendered = metadataLabel(value);
	if (!rendered) return null;
	return (
		<div className="min-w-0">
			<div className="text-[10px] uppercase tracking-[0.16em] opacity-60">{label}</div>
			<div className="text-xs break-words">{rendered}</div>
		</div>
	);
}

export function Pill({
	theme,
	children,
	tone,
}: {
	theme: Theme;
	children: ReactNode;
	tone?: string;
}) {
	return (
		<span
			className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
			style={{
				borderColor: tone ?? theme.colors.border,
				color: tone ?? theme.colors.textDim,
				backgroundColor: `${tone ?? theme.colors.border}18`,
			}}
		>
			{children}
		</span>
	);
}

export function ToolbarButton({
	theme,
	active,
	children,
	onClick,
}: {
	theme: Theme;
	active?: boolean;
	children: ReactNode;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="rounded-md border px-2.5 py-1 text-xs transition-colors"
			style={{
				borderColor: active ? theme.colors.accent : theme.colors.border,
				backgroundColor: active ? `${theme.colors.accent}22` : 'transparent',
				color: active ? theme.colors.textMain : theme.colors.textDim,
			}}
		>
			{children}
		</button>
	);
}

export function DetailBox({
	theme,
	title,
	values,
	empty,
}: {
	theme: Theme;
	title: string;
	values: string[];
	empty: string;
}) {
	return (
		<div className="rounded-xl border p-3" style={{ borderColor: theme.colors.border }}>
			<h4 className="text-sm font-semibold">{title}</h4>
			{values.length === 0 ? (
				<p className="mt-2 text-xs" style={{ color: theme.colors.textDim }}>
					{empty}
				</p>
			) : (
				<ul className="mt-2 space-y-1 text-xs">
					{values.map((value, index) => (
						<li key={`${value}-${index}`} className="break-words">
							{value}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

export function JsonBox({ theme, title, value }: { theme: Theme; title: string; value: unknown }) {
	if (!value)
		return (
			<DetailBox
				theme={theme}
				title={title}
				values={[]}
				empty={`No ${title.toLowerCase()} recorded.`}
			/>
		);
	return (
		<div className="rounded-xl border p-3" style={{ borderColor: theme.colors.border }}>
			<h4 className="text-sm font-semibold">{title}</h4>
			<pre
				className="mt-2 max-h-44 overflow-auto rounded p-2 text-[11px]"
				style={{ backgroundColor: theme.colors.bgSidebar, color: theme.colors.textDim }}
			>
				{JSON.stringify(value, null, 2)}
			</pre>
		</div>
	);
}
