import { Sparkles, Trophy, Wand2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Theme } from '../../../types';
import type { TabId } from '../types';

interface Tab {
	id: TabId;
	label: string;
	icon: ReactNode;
}

const TABS: Tab[] = [
	{ id: 'achievements', label: 'Achievements', icon: <Trophy className="w-4 h-4" /> },
	{ id: 'confetti', label: 'Confetti', icon: <Sparkles className="w-4 h-4" /> },
	{ id: 'baton', label: 'Baton', icon: <Wand2 className="w-4 h-4" /> },
];

function withAlpha(color: string, alpha: number): string {
	const normalizedAlpha = Math.min(Math.max(alpha, 0), 1);
	const trimmedColor = color.trim();
	const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmedColor);
	if (hexMatch) {
		const hex =
			hexMatch[1].length === 3
				? hexMatch[1]
						.split('')
						.map((value) => value + value)
						.join('')
				: hexMatch[1];
		const red = parseInt(hex.slice(0, 2), 16);
		const green = parseInt(hex.slice(2, 4), 16);
		const blue = parseInt(hex.slice(4, 6), 16);
		return `rgba(${red}, ${green}, ${blue}, ${normalizedAlpha})`;
	}

	const rgb = withFunctionalAlpha(trimmedColor, 'rgb', normalizedAlpha);
	if (rgb) return rgb;

	const hsl = withFunctionalAlpha(trimmedColor, 'hsl', normalizedAlpha);
	if (hsl) return hsl;

	return `rgba(0, 0, 0, ${normalizedAlpha})`;
}

function withFunctionalAlpha(
	color: string,
	functionName: 'rgb' | 'hsl',
	alpha: number
): string | null {
	const match = new RegExp(`^${functionName}a?\\((.*)\\)$`, 'i').exec(color);
	if (!match) return null;

	const contents = match[1].trim();
	const commaParts = contents.split(',').map((part) => part.trim());
	if (commaParts.length >= 3 && commaParts.slice(0, 3).every(Boolean)) {
		return `${functionName}a(${commaParts[0]}, ${commaParts[1]}, ${commaParts[2]}, ${alpha})`;
	}

	const [channels] = contents.split('/');
	const spaceParts = channels.trim().split(/\s+/);
	if (spaceParts.length >= 3 && spaceParts.slice(0, 3).every(Boolean)) {
		return `${functionName}a(${spaceParts[0]}, ${spaceParts[1]}, ${spaceParts[2]}, ${alpha})`;
	}

	return null;
}

interface PlaygroundTabsProps {
	theme: Theme;
	activeTab: TabId;
	onSelectTab: (tab: TabId) => void;
}

export function PlaygroundTabs({ theme, activeTab, onSelectTab }: PlaygroundTabsProps) {
	return (
		<div className="flex border-b" style={{ borderColor: theme.colors.border }}>
			{TABS.map((tab) => (
				<button
					key={tab.id}
					onClick={() => onSelectTab(tab.id)}
					className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
						activeTab === tab.id ? 'border-b-2' : ''
					}`}
					style={{
						color: activeTab === tab.id ? theme.colors.accent : theme.colors.textDim,
						borderColor: activeTab === tab.id ? theme.colors.accent : 'transparent',
						backgroundColor:
							activeTab === tab.id ? withAlpha(theme.colors.accent, 0.1) : 'transparent',
					}}
				>
					{tab.icon}
					{tab.label}
				</button>
			))}
		</div>
	);
}
