import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Zap, Sparkles, Database } from 'lucide-react';
import type { Theme } from '../../constants/themes';
import type { PreviewTier } from './filePreviewUtils';
import { HoverTooltip } from '../ui/HoverTooltip';

export interface PreviewTierChipProps {
	/** The tier the auto-picker would choose for the current file. */
	autoTier: PreviewTier;
	/** User-forced tier override, or undefined when running in auto mode. */
	override: PreviewTier | undefined;
	/** Set or clear the override. Passing `undefined` returns to auto mode. */
	onSelect: (tier: PreviewTier | undefined) => void;
	theme: Theme;
	/** Hidden when false (e.g. while a file is loading). */
	visible?: boolean;
	/**
	 * When true, render a compact icon-only trigger that matches the header
	 * toolbar styling. The popover is unchanged. Use inside the file preview
	 * header button cluster.
	 */
	iconOnly?: boolean;
	/** Header button class string (only used when `iconOnly`). */
	headerBtnClass?: string;
	/** Header icon class string (only used when `iconOnly`). */
	headerIconClass?: string;
}

const TIER_META: Record<
	PreviewTier,
	{ label: string; icon: React.ComponentType<{ className?: string }> }
> = {
	rich: { label: 'Rich', icon: Sparkles },
	fast: { label: 'Fast', icon: Zap },
	giant: { label: 'Giant', icon: Database },
};

const TIER_DESCRIPTION: Record<PreviewTier, string> = {
	rich: 'Full features (Mermaid, math, full plugins). Slower on huge files.',
	fast: 'Virtualized markdown-it preview. Best for 5k+ line documents.',
	giant: 'CodeMirror viewer (multi-MB files). Read-only, instant open.',
};

/**
 * Header chip showing the active preview tier with a popover to switch.
 *
 * The chip itself is presentation-only - all decisions about which tier is
 * "auto" come from the caller via `autoTier`, and persistence of the override
 * is delegated via `onSelect`. This keeps the chip easy to test and reusable
 * regardless of where the override lives in app state.
 */
export const PreviewTierChip: React.FC<PreviewTierChipProps> = ({
	autoTier,
	override,
	onSelect,
	theme,
	visible = true,
	iconOnly = false,
	headerBtnClass,
	headerIconClass,
}) => {
	const [open, setOpen] = useState(false);
	const wrapperRef = useRef<HTMLDivElement | null>(null);

	const effective: PreviewTier = override ?? autoTier;
	const Icon = TIER_META[effective].icon;

	// Close on outside click and Escape so the popover doesn't strand itself.
	useEffect(() => {
		if (!open) return;
		const onDocClick = (event: MouseEvent) => {
			if (!wrapperRef.current) return;
			if (!wrapperRef.current.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener('mousedown', onDocClick);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDocClick);
			document.removeEventListener('keydown', onKey);
		};
	}, [open]);

	if (!visible) return null;

	const select = (tier: PreviewTier | undefined) => {
		onSelect(tier);
		setOpen(false);
	};

	const chipButtonStyle: React.CSSProperties = {
		backgroundColor: override ? theme.colors.accent + '20' : 'transparent',
		borderColor: override ? theme.colors.accent + '60' : theme.colors.border,
		color: override ? theme.colors.accent : theme.colors.textDim,
	};

	const triggerTitle = override
		? `Forced ${TIER_META[effective].label} preview · click to change`
		: `Auto · ${TIER_META[effective].label} preview · click to change`;
	const hoverLabel = override
		? `Forced ${TIER_META[effective].label} preview`
		: `Auto · ${TIER_META[effective].label} preview`;

	return (
		<div ref={wrapperRef} className="relative" data-testid="preview-tier-chip">
			{iconOnly ? (
				<HoverTooltip theme={theme} label={hoverLabel} disabled={open}>
					<button
						type="button"
						onClick={() => setOpen((v) => !v)}
						className={headerBtnClass}
						style={{ color: override ? theme.colors.accent : theme.colors.textDim }}
						aria-haspopup="menu"
						aria-expanded={open}
						data-testid="preview-tier-chip-button"
					>
						<Icon className={headerIconClass} />
					</button>
				</HoverTooltip>
			) : (
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium border transition-colors hover:brightness-125"
					style={chipButtonStyle}
					aria-haspopup="menu"
					aria-expanded={open}
					data-testid="preview-tier-chip-button"
					title={triggerTitle}
				>
					<Icon className="w-3 h-3" />
					<span>{TIER_META[effective].label}</span>
					{!override && <span style={{ color: theme.colors.textDim, opacity: 0.7 }}>· auto</span>}
					<ChevronDown className="w-3 h-3 opacity-70" />
				</button>
			)}

			{open && (
				<div
					role="menu"
					data-testid="preview-tier-chip-menu"
					className="absolute right-0 mt-1 rounded-md shadow-lg z-50 overflow-hidden"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						border: `1px solid ${theme.colors.border}`,
						minWidth: '240px',
					}}
				>
					{/* Status header - always reflects the tier that is actually
					    rendering right now (override if set, otherwise auto). */}
					<div
						data-testid="preview-tier-chip-status"
						className="px-3 py-2 text-[10px] uppercase tracking-wider border-b"
						style={{
							color: theme.colors.textDim,
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
						}}
					>
						Currently rendering:{' '}
						<span style={{ color: theme.colors.accent, fontWeight: 600 }}>
							{TIER_META[effective].label}
						</span>
					</div>
					<MenuRow
						theme={theme}
						active={!override}
						label="Auto"
						description={`Auto picks ${TIER_META[autoTier].label} for this file`}
						onClick={() => select(undefined)}
					/>
					{(['rich', 'fast', 'giant'] as const).map((tier) => {
						const TierIcon = TIER_META[tier].icon;
						return (
							<MenuRow
								key={tier}
								theme={theme}
								active={override === tier}
								label={TIER_META[tier].label}
								description={TIER_DESCRIPTION[tier]}
								icon={<TierIcon className="w-3.5 h-3.5" />}
								onClick={() => select(tier)}
							/>
						);
					})}
				</div>
			)}
		</div>
	);
};

interface MenuRowProps {
	theme: Theme;
	active: boolean;
	label: string;
	description: string;
	icon?: React.ReactNode;
	onClick: () => void;
}

const MenuRow: React.FC<MenuRowProps> = ({ theme, active, label, description, icon, onClick }) => (
	<button
		type="button"
		role="menuitem"
		onClick={onClick}
		aria-current={active ? 'true' : undefined}
		// Inactive rows get the standard hover-bg from Tailwind. Active rows
		// keep the accent-tinted background via inline style - leaving that off
		// when inactive lets `:hover` win (an inline `background: transparent`
		// would otherwise override the hover class).
		className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors ${
			active ? '' : 'hover:bg-white/10'
		}`}
		style={{
			backgroundColor: active ? theme.colors.accent + '20' : undefined,
			color: active ? theme.colors.accent : theme.colors.textMain,
		}}
	>
		{icon}
		<div className="flex-1 min-w-0">
			<div className="text-xs font-medium">{label}</div>
			<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
				{description}
			</div>
		</div>
	</button>
);
