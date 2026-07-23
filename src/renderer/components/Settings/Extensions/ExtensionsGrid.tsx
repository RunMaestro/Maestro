/**
 * Tiled grid of extension cards (first-party Encore features + plugins).
 * Each tile shows an icon, name, one-line description, a category badge, a
 * state pill, and (for plugins) a tier + trust badge. Clicking a tile opens
 * the details pane.
 */

import {
	Puzzle,
	Database,
	Music,
	Zap,
	Clapperboard,
	Bot,
	KanbanSquare,
	ShieldCheck,
	ShieldAlert,
	ShieldX,
	Shield,
	type LucideIcon,
} from 'lucide-react';
import type { Theme } from '../../../types';
import { CATEGORY_LABELS, STATE_LABELS, type UnifiedExtension } from './extensionModel';

interface ExtensionsGridProps {
	theme: Theme;
	extensions: UnifiedExtension[];
	onSelect: (ext: UnifiedExtension) => void;
}

const BUILTIN_ICONS: Record<string, LucideIcon> = {
	usageStats: Database,
	symphony: Music,
	maestroCue: Zap,
	directorNotes: Clapperboard,
	pianola: Bot,
	board: KanbanSquare,
};

const TRUST_META: Record<
	NonNullable<UnifiedExtension['trust']>,
	{ label: string; icon: LucideIcon; color: 'success' | 'warning' | 'error' | 'textDim' }
> = {
	trusted: { label: 'Trusted', icon: ShieldCheck, color: 'success' },
	untrusted: { label: 'Untrusted', icon: ShieldAlert, color: 'warning' },
	invalid: { label: 'Bad signature', icon: ShieldX, color: 'error' },
	unsigned: { label: 'Unsigned', icon: Shield, color: 'textDim' },
};

export function ExtensionsGrid({ theme, extensions, onSelect }: ExtensionsGridProps) {
	const stateTone = (ext: UnifiedExtension): string => {
		if (ext.state === 'enabled') return theme.colors.success;
		if (ext.state === 'installed') return theme.colors.accent;
		return theme.colors.textDim;
	};

	if (extensions.length === 0) {
		return (
			<div
				data-testid="extensions-empty"
				className="text-sm py-10 text-center"
				style={{ color: theme.colors.textDim }}
			>
				No extensions match your filters.
			</div>
		);
	}

	return (
		<div
			data-testid="extensions-grid"
			className="grid gap-3"
			style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
		>
			{extensions.map((ext) => {
				const Icon = ext.kind === 'plugin' ? Puzzle : (BUILTIN_ICONS[ext.id] ?? Puzzle);
				const trust = ext.trust ? TRUST_META[ext.trust] : null;
				const TrustIcon = trust?.icon;
				const isEnabled = ext.state === 'enabled';
				return (
					<button
						key={ext.key}
						type="button"
						data-testid="extension-card"
						data-extension-key={ext.key}
						data-extension-id={ext.id}
						data-extension-kind={ext.kind}
						data-extension-state={ext.state}
						data-extension-category={ext.category}
						onClick={() => onSelect(ext)}
						className="flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-white/5"
						style={{
							borderColor: isEnabled ? theme.colors.accent : theme.colors.border,
							backgroundColor: isEnabled ? `${theme.colors.accent}08` : 'transparent',
						}}
					>
						<div className="flex items-start gap-2.5">
							<Icon
								className="w-5 h-5 mt-0.5 flex-shrink-0"
								style={{ color: isEnabled ? theme.colors.accent : theme.colors.textDim }}
							/>
							<div className="min-w-0 flex-1">
								<div
									className="text-sm font-bold flex items-center gap-1.5"
									style={{ color: theme.colors.textMain }}
								>
									<span className="truncate">{ext.name}</span>
									{ext.beta && (
										<span
											className="px-1 py-0.5 rounded text-[8px] font-bold uppercase flex-shrink-0"
											style={{
												backgroundColor: theme.colors.warning + '30',
												color: theme.colors.warning,
											}}
										>
											Beta
										</span>
									)}
								</div>
								<div
									className="text-xs mt-0.5 line-clamp-2"
									style={{ color: theme.colors.textDim }}
								>
									{ext.description || 'No description provided.'}
								</div>
							</div>
						</div>

						<div className="flex items-center gap-1.5 flex-wrap mt-auto pt-1">
							<span
								data-testid="extension-category"
								className="px-1.5 py-0.5 rounded text-[10px] font-medium"
								style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
							>
								{CATEGORY_LABELS[ext.category]}
							</span>
							<span
								data-testid="extension-state"
								className="px-1.5 py-0.5 rounded text-[10px] font-bold"
								style={{ backgroundColor: stateTone(ext) + '22', color: stateTone(ext) }}
							>
								{STATE_LABELS[ext.state]}
							</span>
							{ext.kind === 'plugin' && ext.tier !== undefined && (
								<span
									className="px-1.5 py-0.5 rounded text-[10px] font-medium"
									style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
								>
									Tier {ext.tier}
								</span>
							)}
							{trust && TrustIcon && (
								<span
									data-testid="extension-trust"
									className="px-1.5 py-0.5 rounded text-[10px] font-medium inline-flex items-center gap-1"
									style={{
										backgroundColor: theme.colors.bgActivity,
										color: theme.colors[trust.color],
									}}
								>
									<TrustIcon className="w-3 h-3" />
									{trust.label}
								</span>
							)}
						</div>
					</button>
				);
			})}
		</div>
	);
}
