/**
 * ThemeTab - Theme selection and customization tab
 *
 * Displays grouped theme buttons (dark/light/vibe) with Tab key navigation,
 * plus the custom theme builder. Self-sources theme settings from useSettings().
 */

import React, { useRef, useEffect } from 'react';
import { Moon, Sun, Sparkles, Check } from 'lucide-react';
import { useSettings } from '../../../hooks';
import { CustomThemeBuilder } from '../../CustomThemeBuilder';
import type { Theme, ThemeId } from '../../../types';

export interface ThemeTabProps {
	theme: Theme;
	themes: Record<string, Theme>;
	onThemeImportError?: (message: string) => void;
	onThemeImportSuccess?: (message: string) => void;
}

export function ThemeTab({
	theme,
	themes,
	onThemeImportError,
	onThemeImportSuccess,
}: ThemeTabProps) {
	const {
		activeThemeId,
		setActiveThemeId,
		customThemeColors,
		setCustomThemeColors,
		customThemeBaseId,
		setCustomThemeBaseId,
	} = useSettings();

	const themePickerRef = useRef<HTMLDivElement>(null);

	// Auto-focus theme picker on mount
	useEffect(() => {
		const timer = setTimeout(() => themePickerRef.current?.focus(), 50);
		return () => clearTimeout(timer);
	}, []);

	// Group themes by mode (exclude 'custom' theme - it's handled separately)
	const groupedThemes = Object.values(themes).reduce(
		(acc: Record<string, Theme[]>, t: Theme) => {
			if (t.id === 'custom') return acc; // Skip custom theme in regular grouping
			if (!acc[t.mode]) acc[t.mode] = [];
			acc[t.mode].push(t);
			return acc;
		},
		{} as Record<string, Theme[]>
	);

	const handleThemePickerKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Tab') {
			e.preventDefault();
			e.stopPropagation();
			// Create ordered array: dark themes first, then light, then vibe, then custom (cycling back to dark)
			const allThemes = [
				...(groupedThemes['dark'] || []),
				...(groupedThemes['light'] || []),
				...(groupedThemes['vibe'] || []),
			];
			// Add 'custom' as the last item in the cycle
			const allThemeIds = [...allThemes.map((t) => t.id), 'custom'];
			let currentIndex = allThemeIds.findIndex((id: string) => id === activeThemeId);
			if (currentIndex === -1) currentIndex = 0;

			let newThemeId: string;
			if (e.shiftKey) {
				// Shift+Tab: go backwards
				const prevIndex = currentIndex === 0 ? allThemeIds.length - 1 : currentIndex - 1;
				newThemeId = allThemeIds[prevIndex];
			} else {
				// Tab: go forward
				const nextIndex = (currentIndex + 1) % allThemeIds.length;
				newThemeId = allThemeIds[nextIndex];
			}
			setActiveThemeId(newThemeId as ThemeId);

			// Scroll the newly selected theme button into view
			setTimeout(() => {
				const themeButton = themePickerRef.current?.querySelector(
					`[data-theme-id="${newThemeId}"]`
				);
				themeButton?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			}, 0);
		}
	};

	return (
		<div
			ref={themePickerRef}
			className="space-y-6 outline-none"
			tabIndex={0}
			onKeyDown={handleThemePickerKeyDown}
			role="group"
			aria-label="Theme picker"
		>
			{['dark', 'light', 'vibe'].map((mode) => (
				<div key={mode}>
					<div
						className="text-xs font-bold uppercase mb-3 flex items-center gap-2"
						style={{ color: theme.colors.textDim }}
					>
						{mode === 'dark' ? (
							<Moon className="w-3 h-3" />
						) : mode === 'light' ? (
							<Sun className="w-3 h-3" />
						) : (
							<Sparkles className="w-3 h-3" />
						)}
						{mode} Mode
					</div>
					<div className="grid grid-cols-2 gap-3">
						{groupedThemes[mode]?.map((t: Theme) => (
							<button
								key={t.id}
								data-theme-id={t.id}
								onClick={() => setActiveThemeId(t.id)}
								className={`p-3 rounded-lg border text-left transition-all ${activeThemeId === t.id ? 'ring-2' : ''}`}
								style={
									{
										borderColor: theme.colors.border,
										backgroundColor: t.colors.bgSidebar,
										'--tw-ring-color': t.colors.accent,
									} as React.CSSProperties
								}
								tabIndex={-1}
							>
								<div className="flex justify-between items-center mb-2">
									<span className="text-sm font-bold" style={{ color: t.colors.textMain }}>
										{t.name}
									</span>
									{activeThemeId === t.id && (
										<Check className="w-4 h-4" style={{ color: t.colors.accent }} />
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

			{/* Custom Theme Builder */}
			<div data-theme-id="custom">
				<CustomThemeBuilder
					theme={theme}
					customThemeColors={customThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId={customThemeBaseId}
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={activeThemeId === 'custom'}
					onSelect={() => setActiveThemeId('custom')}
					onImportError={onThemeImportError}
					onImportSuccess={onThemeImportSuccess}
				/>
			</div>
		</div>
	);
}
