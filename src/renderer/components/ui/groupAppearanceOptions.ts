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
import { GROUP_ICON_CATALOG, GROUP_LABEL_COLORS } from '../../../shared/groupAppearance';

export { GROUP_LABEL_COLORS };

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
 * Icon-id -> Lucide component. The id list itself lives in the shared catalog
 * (`shared/groupAppearance.ts`) so the CLI and the WebSocket handlers validate
 * against the same ids; only this mapping is renderer-owned, because Lucide
 * cannot be imported outside the renderer bundle.
 */
const GROUP_ICON_COMPONENTS: Record<string, LucideIcon> = {
	folder: Folder,
	briefcase: Briefcase,
	rocket: Rocket,
	code: Code2,
	star: Star,
	heart: Heart,
	lightbulb: Lightbulb,
	target: Target,
	calendar: Calendar,
	book: BookOpen,
	layers: Layers,
	shield: Shield,
	wrench: Wrench,
	palette: Palette,
	archive: Archive,
	zap: Zap,
};

export const GROUP_ICON_OPTIONS: readonly GroupIconOption[] = GROUP_ICON_CATALOG.filter(
	(entry) => entry.id in GROUP_ICON_COMPONENTS
).map((entry) => ({ id: entry.id, label: entry.label, Icon: GROUP_ICON_COMPONENTS[entry.id] }));

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
