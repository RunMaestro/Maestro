import { Puzzle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Theme } from '../../../../../types';

interface EncoreFeatureCardProps {
	theme: Theme;
	enabled: boolean;
	/** Jump to the feature's tile in the Extensions marketplace below — the
	 * marketplace is the management surface; this card only shows state. */
	onManage: () => void;
	icon: LucideIcon;
	title: ReactNode;
	description: ReactNode;
	children?: ReactNode;
	contentClassName?: string;
}

/**
 * Per-feature CONFIG section header. Enable/disable is managed in the
 * Extensions marketplace (the tiles at the bottom of this tab) — the header
 * shows the current state and links there instead of toggling anything.
 */
export function EncoreFeatureCard({
	theme,
	enabled,
	onManage,
	icon: Icon,
	title,
	description,
	children,
	contentClassName = 'space-y-3',
}: EncoreFeatureCardProps) {
	return (
		<div
			className="rounded-lg border"
			style={{
				borderColor: enabled ? theme.colors.accent : theme.colors.border,
				backgroundColor: enabled ? `${theme.colors.accent}08` : 'transparent',
			}}
		>
			<div className="w-full flex items-center justify-between gap-3 p-4 text-left">
				<div className="flex items-center gap-3 min-w-0">
					<Icon
						className="w-5 h-5 flex-shrink-0"
						style={{ color: enabled ? theme.colors.accent : theme.colors.textDim }}
					/>
					<div className="min-w-0">
						<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							{title}
						</div>
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							{description}
						</div>
					</div>
				</div>
				<div className="flex items-center gap-2 flex-shrink-0">
					<span
						data-testid="encore-feature-state"
						className="px-1.5 py-0.5 rounded text-[10px] font-bold"
						style={{
							backgroundColor: (enabled ? theme.colors.success : theme.colors.textDim) + '22',
							color: enabled ? theme.colors.success : theme.colors.textDim,
						}}
					>
						{enabled ? 'Enabled' : 'Disabled'}
					</span>
					<button
						type="button"
						data-testid="encore-feature-manage"
						onClick={onManage}
						title="Manage in Extensions"
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors hover:bg-white/5"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<Puzzle className="w-3.5 h-3.5" /> Manage in Extensions
					</button>
				</div>
			</div>
			{enabled && children && (
				<div
					className={`px-4 pb-4 border-t ${contentClassName}`}
					style={{ borderColor: theme.colors.border }}
				>
					{children}
				</div>
			)}
		</div>
	);
}
