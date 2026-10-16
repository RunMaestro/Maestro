/**
 * Small layout pieces the Bundles tab's export and import halves share.
 */

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Theme } from '../../../types';

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
