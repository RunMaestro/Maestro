import { ChevronDown, ChevronRight, Puzzle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Theme } from '../../../../../types';

interface EncoreFeatureCardProps {
	theme: Theme;
	enabled: boolean;
	/** Collapsed/expanded state — owned by the tab so the marketplace tiles'
	 * Configure action can expand the right section. */
	open: boolean;
	onToggleOpen: () => void;
	/** Jump to the feature's tile in the Extensions marketplace above — the
	 * marketplace is the management surface; this card only shows state. */
	onManage: () => void;
	icon: LucideIcon;
	title: ReactNode;
	description: ReactNode;
	children?: ReactNode;
	contentClassName?: string;
}

/**
 * Per-feature CONFIG section: a collapsed-by-default accordion card. The
 * header toggles the config open; enable/disable is managed in the Extensions
 * marketplace (the tiles at the top of the Plugins tab) — the header shows
 * the current state and links there instead of toggling anything.
 */
export function EncoreFeatureCard({
	theme,
	enabled,
	open,
	onToggleOpen,
	onManage,
	icon: Icon,
	title,
	description,
	children,
	contentClassName = 'space-y-3',
}: EncoreFeatureCardProps) {
	const Chevron = open ? ChevronDown : ChevronRight;
	return (
		<div
			className="rounded-lg border"
			style={{
				borderColor: enabled ? theme.colors.accent : theme.colors.border,
				backgroundColor: enabled ? `${theme.colors.accent}08` : 'transparent',
			}}
		>
			{/* Header row: the expand toggle and the Manage action are SIBLING
			    buttons (nested interactive controls are invalid ARIA — a button
			    must not contain focusable descendants). The toggle button spans
			    the title area; state pill + Manage sit beside it. */}
			<div className="w-full flex items-center justify-between gap-3 p-4">
				<button
					type="button"
					data-testid="encore-feature-header"
					aria-expanded={open}
					onClick={onToggleOpen}
					className="flex items-center gap-3 min-w-0 flex-1 text-left"
				>
					<Chevron className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.textDim }} />
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
				</button>
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
						onClick={(e) => {
							e.stopPropagation();
							onManage();
						}}
						title="Manage in Extensions"
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors hover:bg-white/5"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<Puzzle className="w-3.5 h-3.5" /> Manage
					</button>
				</div>
			</div>
			{open &&
				(enabled && children ? (
					<div
						className={`px-4 pb-4 border-t ${contentClassName}`}
						style={{ borderColor: theme.colors.border }}
					>
						{children}
					</div>
				) : (
					<div
						data-testid="encore-feature-disabled-hint"
						className="px-4 pb-4 pt-3 border-t text-xs"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						{enabled
							? 'This feature has no additional configuration.'
							: 'Enable this plugin in Extensions above to configure it.'}
					</div>
				))}
		</div>
	);
}
