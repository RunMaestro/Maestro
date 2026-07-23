import {
	Archive,
	BookOpen,
	Briefcase,
	Calendar,
	Code2,
	Folder,
	Heart,
	Layers,
	Lightbulb,
	Palette,
	Rocket,
	Shield,
	Star,
	Target,
	Wrench,
	Zap,
	type LucideIcon,
} from 'lucide-react';
import type { IconPackContribution } from '../../../shared/plugins/contributions';
import {
	GROUP_ICON_IDS,
	GROUP_LABEL_COLORS,
	type BuiltInGroupIconId,
} from '../../../shared/groupAppearance';

export interface GroupIconOption {
	id: string;
	label: string;
	Icon: LucideIcon;
}

export type ResolvedGroupIcon =
	| { kind: 'built-in'; Icon: LucideIcon }
	| { kind: 'plugin'; path: string; viewBox?: string }
	| { kind: 'missing'; Icon: LucideIcon };

export interface ResolvedGroupAppearance {
	icon: ResolvedGroupIcon | undefined;
	color: string | undefined;
}

/**
 * Renderer-owned mapping from the shared built-in icon IDs to their Lucide
 * components and display labels. The IDs themselves live in the UI-independent
 * shared catalog (`shared/groupAppearance.ts`) so the CLI and main process can
 * validate them without importing lucide-react.
 */
const BUILT_IN_ICON_META: Record<BuiltInGroupIconId, { label: string; Icon: LucideIcon }> = {
	folder: { label: 'Folder', Icon: Folder },
	briefcase: { label: 'Briefcase', Icon: Briefcase },
	rocket: { label: 'Rocket', Icon: Rocket },
	code: { label: 'Code', Icon: Code2 },
	star: { label: 'Star', Icon: Star },
	heart: { label: 'Heart', Icon: Heart },
	lightbulb: { label: 'Lightbulb', Icon: Lightbulb },
	target: { label: 'Target', Icon: Target },
	calendar: { label: 'Calendar', Icon: Calendar },
	book: { label: 'Book', Icon: BookOpen },
	layers: { label: 'Layers', Icon: Layers },
	shield: { label: 'Shield', Icon: Shield },
	wrench: { label: 'Wrench', Icon: Wrench },
	palette: { label: 'Palette', Icon: Palette },
	archive: { label: 'Archive', Icon: Archive },
	zap: { label: 'Zap', Icon: Zap },
};

export const GROUP_ICON_OPTIONS: readonly GroupIconOption[] = GROUP_ICON_IDS.map((id) => ({
	id,
	label: BUILT_IN_ICON_META[id].label,
	Icon: BUILT_IN_ICON_META[id].Icon,
}));

export { GROUP_LABEL_COLORS };

/**
 * Resolves a stored group appearance against the current host and plugin option
 * catalogs. Missing namespaced values intentionally fall back without changing
 * persistence, so disabling a plugin is reversible.
 */
export function resolveGroupAppearance(
	iconId: string | undefined,
	colorId: string | undefined,
	iconPacks: readonly IconPackContribution[]
): ResolvedGroupAppearance {
	const builtInIcon = GROUP_ICON_OPTIONS.find((option) => option.id === iconId);
	const builtInColor = GROUP_LABEL_COLORS.find((option) => option.value === colorId);
	let contributedIcon: IconPackContribution['icons'][number] | undefined;
	let contributedColor: IconPackContribution['colors'][number] | undefined;
	for (const pack of iconPacks) {
		contributedIcon ??= pack.icons.find((icon) => icon.id === iconId);
		contributedColor ??= pack.colors.find((color) => color.id === colorId);
		if (contributedIcon && contributedColor) break;
	}

	return {
		icon: builtInIcon
			? { kind: 'built-in', Icon: builtInIcon.Icon }
			: contributedIcon
				? {
						kind: 'plugin',
						path: contributedIcon.path,
						...(contributedIcon.viewBox ? { viewBox: contributedIcon.viewBox } : {}),
					}
				: iconId?.includes('/')
					? { kind: 'missing', Icon: Folder }
					: undefined,
		color: builtInColor
			? builtInColor.value
			: contributedColor
				? contributedColor.value
				: colorId && /^#[0-9a-fA-F]{6}$/.test(colorId)
					? colorId
					: undefined,
	};
}
