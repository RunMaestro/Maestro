import {
	ArrowRightLeft,
	AtSign,
	BarChart3,
	ChevronRightSquare,
	ClipboardEdit,
	Clock,
	GitBranch,
	Headphones,
	Highlighter,
	Keyboard,
	Lightbulb,
	ListOrdered,
	MessagesSquare,
	Music,
	Play,
	Server,
	ShieldCheck,
	Store,
	Terminal,
	TowerControl,
	Workflow,
	Zap,
	type LucideIcon,
} from 'lucide-react';
import type { DidYouKnowTip } from '../../../shared/didYouKnow';
import type { Theme } from '../../types';

// Add named imports from ../../assets/did-you-know/ here as screenshots ship.
// Keep filenames mapped to imported modules so Vite bundles the actual assets.
// No screenshots are bundled yet; unmapped filenames use the icon plate.
export const TIP_ART: Record<string, string> = {};

export const TIP_ICONS: Record<string, LucideIcon> = {
	ArrowRightLeft,
	AtSign,
	BarChart3,
	ChevronRightSquare,
	ClipboardEdit,
	Clock,
	GitBranch,
	Headphones,
	Highlighter,
	Keyboard,
	Lightbulb,
	ListOrdered,
	MessagesSquare,
	Music,
	Play,
	Server,
	ShieldCheck,
	Store,
	Terminal,
	TowerControl,
	Workflow,
	Zap,
};

interface TipArtworkProps {
	tip: DidYouKnowTip;
	theme: Theme;
}

/** Fills the aperture; OrnateFrame alone owns the artwork's aspect ratio. */
export function TipArtwork({ tip, theme }: TipArtworkProps) {
	const artSrc =
		tip.art && Object.prototype.hasOwnProperty.call(TIP_ART, tip.art)
			? TIP_ART[tip.art]
			: undefined;
	if (artSrc) {
		return <img src={artSrc} alt={tip.title} className="w-full h-full object-cover" />;
	}

	const Icon = Object.prototype.hasOwnProperty.call(TIP_ICONS, tip.icon)
		? TIP_ICONS[tip.icon]
		: Lightbulb;
	return (
		<div
			aria-hidden
			className="w-full h-full flex items-center justify-center"
			style={{
				backgroundColor: theme.colors.bgMain,
				backgroundImage: `radial-gradient(ellipse at center, transparent 30%, rgba(0, 0, 0, 0.08) 100%), linear-gradient(135deg, color-mix(in srgb, ${theme.colors.accent} 12%, transparent), color-mix(in srgb, ${theme.colors.accent} 4%, transparent))`,
				color: theme.colors.accent,
			}}
		>
			<Icon style={{ height: '40%', width: 'auto' }} />
		</div>
	);
}
