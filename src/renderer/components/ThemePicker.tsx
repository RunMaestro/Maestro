import React from 'react';
import { Moon, Sun } from 'lucide-react';
import type { Theme, ThemeId } from '../types';

interface ThemePickerProps {
	theme: Theme;
	themes: Record<ThemeId, Theme>;
	activeThemeId: ThemeId;
	setActiveThemeId: (id: ThemeId) => void;
}

export function ThemePicker({ theme, themes, activeThemeId, setActiveThemeId }: ThemePickerProps) {
	const grouped = Object.values(themes).reduce(
		(acc, t) => {
			if (!acc[t.mode]) acc[t.mode] = [];
			acc[t.mode].push(t);
			return acc;
		},
		{} as Record<string, Theme[]>
	);

	return (
		<div className="space-y-6">
			{['dark', 'light'].map((mode) => (
				<div key={mode}>
					<div
						className="text-xs font-bold uppercase mb-3 flex items-center gap-2"
						style={{ color: theme.colors.textDim }}
					>
						{mode === 'dark' ? <Moon className="w-3 h-3" /> : <Sun className="w-3 h-3" />}
						{mode} Mode
					</div>
					<div className="grid grid-cols-2 gap-3">
						{grouped[mode]?.map((t) => (
							<button
								key={t.id}
								onClick={() => setActiveThemeId(t.id)}
								className={`p-3 rounded-lg border text-left transition-all ${activeThemeId === t.id ? 'ring-2' : ''}`}
								style={
									{
										borderColor: theme.colors.border,
										backgroundColor: t.colors.bgSidebar,
										'--tw-ring-color': theme.colors.accent,
									} as React.CSSProperties
								}
							>
								<div className="flex justify-between items-center mb-2">
									<span className="text-sm font-bold" style={{ color: t.colors.textMain }}>
										{t.name}
									</span>
									{activeThemeId === t.id && (
										<div
											className="w-2 h-2 rounded-full"
											style={{ backgroundColor: theme.colors.accent }}
										/>
									)}
								</div>
								<div className="flex h-3 rounded overflow-hidden">
									<div className="flex-1" style={{ backgroundColor: t.colors.bgMain }} />
									<div className="flex-1" style={{ backgroundColor: t.colors.bgActivity }} />
									<div className="flex-1" style={{ backgroundColor: t.colors.accent }} />
								</div>
							</button>
						))}
					</div>
				</div>
			))}
		</div>
	);
}
