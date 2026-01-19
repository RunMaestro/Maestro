import React, { useState, useCallback, useRef } from 'react';
import { Palette, Download, Upload, RotateCcw, Check, ChevronDown } from 'lucide-react';
import type { Theme, ThemeColors, ThemeId } from '../types';
import { THEMES, DEFAULT_CUSTOM_THEME_COLORS } from '../constants/themes';

/**
 * Validates that a string is a valid CSS color value
 */
function isValidColor(color: string): boolean {
	// Handle empty strings
	if (!color || typeof color !== 'string') return false;

	// Use the DOM to validate - create an option element and try to set its color
	const testElement = new Option().style;
	testElement.color = color;
	// If the browser accepts the color, it will be non-empty
	return testElement.color !== '';
}

interface CustomThemeBuilderProps {
	theme: Theme; // Current active theme for styling the builder
	customThemeColors: ThemeColors;
	setCustomThemeColors: (colors: ThemeColors) => void;
	customThemeBaseId: ThemeId;
	setCustomThemeBaseId: (id: ThemeId) => void;
	isSelected: boolean;
	onSelect: () => void;
	onImportError?: (message: string) => void;
	onImportSuccess?: (message: string) => void;
}

// Color picker labels with descriptions
const COLOR_CONFIG: { key: keyof ThemeColors; label: string; description: string }[] = [
	{ key: 'bgMain', label: 'Main Background', description: 'Primary content area' },
	{ key: 'bgSidebar', label: 'Sidebar Background', description: 'Left & right panels' },
	{ key: 'bgActivity', label: 'Activity Background', description: 'Hover, active states' },
	{ key: 'border', label: 'Border', description: 'Dividers & outlines' },
	{ key: 'textMain', label: 'Main Text', description: 'Primary text color' },
	{ key: 'textDim', label: 'Dimmed Text', description: 'Secondary text' },
	{ key: 'accent', label: 'Accent', description: 'Highlights, links' },
	{ key: 'accentDim', label: 'Accent Dim', description: 'Accent with transparency' },
	{ key: 'accentText', label: 'Accent Text', description: 'Text in accent contexts' },
	{ key: 'accentForeground', label: 'Accent Foreground', description: 'Text ON accent' },
	{ key: 'success', label: 'Success', description: 'Green states' },
	{ key: 'warning', label: 'Warning', description: 'Yellow/orange states' },
	{ key: 'error', label: 'Error', description: 'Red states' },
];

// Mini UI Preview component
function MiniUIPreview({ colors }: { colors: ThemeColors }) {
	return (
		<div
			className="rounded-lg overflow-hidden border"
			style={{
				borderColor: colors.border,
				width: '100%',
				height: 140,
			}}
		>
			{/* Mini UI layout */}
			<div className="flex h-full">
				{/* Left sidebar */}
				<div className="w-12 flex flex-col gap-1 p-1" style={{ backgroundColor: colors.bgSidebar }}>
					{/* Session items */}
					<div
						className="h-4 rounded text-[6px] flex items-center justify-center"
						style={{ backgroundColor: colors.bgActivity, color: colors.textDim }}
					>
						S1
					</div>
					<div
						className="h-4 rounded text-[6px] flex items-center justify-center ring-1"
						style={
							{
								backgroundColor: colors.accentDim,
								color: colors.accent,
								'--tw-ring-color': colors.accent,
							} as React.CSSProperties
						}
					>
						S2
					</div>
					<div
						className="h-4 rounded text-[6px] flex items-center justify-center"
						style={{ backgroundColor: colors.bgActivity, color: colors.textDim }}
					>
						S3
					</div>
				</div>

				{/* Main content */}
				<div className="flex-1 flex flex-col" style={{ backgroundColor: colors.bgMain }}>
					{/* Header bar */}
					<div
						className="h-5 flex items-center px-2 border-b"
						style={{ borderColor: colors.border }}
					>
						<span className="text-[7px] font-bold" style={{ color: colors.textMain }}>
							AI Terminal
						</span>
					</div>

					{/* Chat area */}
					<div className="flex-1 p-1 space-y-1 overflow-hidden">
						{/* User message */}
						<div className="flex justify-end">
							<div
								className="rounded px-1.5 py-0.5 text-[6px] max-w-[80%]"
								style={{ backgroundColor: colors.accentDim, color: colors.textMain }}
							>
								User message
							</div>
						</div>
						{/* AI response */}
						<div className="flex justify-start">
							<div
								className="rounded px-1.5 py-0.5 text-[6px] max-w-[80%]"
								style={{ backgroundColor: colors.bgActivity, color: colors.textMain }}
							>
								AI response here
							</div>
						</div>
						{/* Status indicators */}
						<div className="flex gap-1 mt-1">
							<span
								className="text-[5px] px-1 rounded"
								style={{ backgroundColor: colors.success + '30', color: colors.success }}
							>
								ready
							</span>
							<span
								className="text-[5px] px-1 rounded"
								style={{ backgroundColor: colors.warning + '30', color: colors.warning }}
							>
								busy
							</span>
							<span
								className="text-[5px] px-1 rounded"
								style={{ backgroundColor: colors.error + '30', color: colors.error }}
							>
								error
							</span>
						</div>
					</div>

					{/* Input area */}
					<div
						className="h-6 border-t flex items-center px-1"
						style={{ borderColor: colors.border }}
					>
						<div
							className="flex-1 h-4 rounded border text-[6px] flex items-center px-1"
							style={{
								borderColor: colors.border,
								backgroundColor: colors.bgActivity,
								color: colors.textDim,
							}}
						>
							Type a message...
						</div>
						<div
							className="ml-1 w-4 h-4 rounded flex items-center justify-center text-[6px]"
							style={{ backgroundColor: colors.accent, color: colors.accentForeground }}
						>
							↵
						</div>
					</div>
				</div>

				{/* Right panel */}
				<div
					className="w-10 flex flex-col border-l"
					style={{ backgroundColor: colors.bgSidebar, borderColor: colors.border }}
				>
					<div
						className="text-[5px] px-1 py-0.5 border-b text-center font-bold"
						style={{ borderColor: colors.border, color: colors.accent }}
					>
						Files
					</div>
					<div className="p-0.5 space-y-0.5">
						<div className="text-[5px] truncate" style={{ color: colors.textMain }}>
							src/
						</div>
						<div className="text-[5px] truncate pl-1" style={{ color: colors.textDim }}>
							app.tsx
						</div>
						<div className="text-[5px] truncate pl-1" style={{ color: colors.textDim }}>
							index.ts
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

// Color input with label
function ColorInput({
	colorKey,
	label,
	description,
	value,
	onChange,
	theme,
}: {
	colorKey: keyof ThemeColors;
	label: string;
	description: string;
	value: string;
	onChange: (key: keyof ThemeColors, value: string) => void;
	theme: Theme;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// Handle rgba/hsla by showing the color picker for the base color
	const isComplexColor = value.includes('rgba') || value.includes('hsla');

	return (
		<div className="flex items-center gap-2 py-1">
			<div className="relative">
				<input
					ref={inputRef}
					type="color"
					value={isComplexColor ? '#888888' : value}
					onChange={(e) => onChange(colorKey, e.target.value)}
					className="w-8 h-8 rounded cursor-pointer border-2"
					style={{ borderColor: theme.colors.border }}
					title={label}
				/>
				{isComplexColor && (
					<div
						className="absolute inset-0 rounded pointer-events-none flex items-center justify-center text-[8px] font-bold"
						style={{ color: theme.colors.textMain }}
					>
						α
					</div>
				)}
			</div>
			<div className="flex-1 min-w-0">
				<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					{label}
				</div>
				<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
					{description}
				</div>
			</div>
			<div className="flex items-center gap-1">
				{isEditing ? (
					<input
						type="text"
						value={value}
						onChange={(e) => onChange(colorKey, e.target.value)}
						onBlur={() => setIsEditing(false)}
						onKeyDown={(e) => e.key === 'Enter' && setIsEditing(false)}
						className="w-32 px-1.5 py-0.5 rounded text-xs font-mono border"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						autoFocus
					/>
				) : (
					<button
						onClick={() => setIsEditing(true)}
						className="px-1.5 py-0.5 rounded text-xs font-mono hover:opacity-80"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textDim,
						}}
					>
						{value.length > 12 ? value.slice(0, 12) + '...' : value}
					</button>
				)}
			</div>
		</div>
	);
}

export function CustomThemeBuilder({
	theme,
	customThemeColors,
	setCustomThemeColors,
	customThemeBaseId,
	setCustomThemeBaseId,
	isSelected,
	onSelect,
	onImportError,
	onImportSuccess,
}: CustomThemeBuilderProps) {
	const [showBaseSelector, setShowBaseSelector] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Get all themes except 'custom' for base selection
	const baseThemes = Object.values(THEMES).filter((t) => t.id !== 'custom');

	const handleColorChange = useCallback(
		(key: keyof ThemeColors, value: string) => {
			setCustomThemeColors({
				...customThemeColors,
				[key]: value,
			});
		},
		[customThemeColors, setCustomThemeColors]
	);

	const handleInitializeFromBase = useCallback(
		(baseId: ThemeId) => {
			const baseTheme = THEMES[baseId];
			if (baseTheme) {
				setCustomThemeColors({ ...baseTheme.colors });
				setCustomThemeBaseId(baseId);
			}
			setShowBaseSelector(false);
		},
		[setCustomThemeColors, setCustomThemeBaseId]
	);

	const handleReset = useCallback(() => {
		setCustomThemeColors({ ...DEFAULT_CUSTOM_THEME_COLORS });
		setCustomThemeBaseId('dracula');
	}, [setCustomThemeColors, setCustomThemeBaseId]);

	const handleExport = useCallback(() => {
		const exportData = {
			name: 'Custom Theme',
			baseTheme: customThemeBaseId,
			colors: customThemeColors,
			exportedAt: new Date().toISOString(),
		};

		const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'maestro-custom-theme.json';
		a.click();
		URL.revokeObjectURL(url);
	}, [customThemeColors, customThemeBaseId]);

	const handleImport = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const file = event.target.files?.[0];
			if (!file) return;

			const reader = new FileReader();
			reader.onload = (e) => {
				try {
					const data = JSON.parse(e.target?.result as string);
					if (data.colors && typeof data.colors === 'object') {
						// Validate all required color keys exist
						const requiredKeys = COLOR_CONFIG.map((c) => c.key);
						const hasAllKeys = requiredKeys.every((key) => key in data.colors);

						if (!hasAllKeys) {
							const missing = requiredKeys.filter((key) => !(key in data.colors));
							const errorMsg = `Invalid theme file: missing color keys (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '...' : ''})`;
							onImportError?.(errorMsg);
							return;
						}

						// Validate all color values are valid CSS colors
						const invalidColors = requiredKeys.filter((key) => !isValidColor(data.colors[key]));
						if (invalidColors.length > 0) {
							const errorMsg = `Invalid theme file: invalid color values for ${invalidColors.slice(0, 3).join(', ')}${invalidColors.length > 3 ? '...' : ''}`;
							onImportError?.(errorMsg);
							return;
						}

						// All validations passed - apply the theme
						setCustomThemeColors(data.colors);
						if (data.baseTheme && THEMES[data.baseTheme as ThemeId]) {
							setCustomThemeBaseId(data.baseTheme);
						}
						onImportSuccess?.('Theme imported successfully');
					} else {
						onImportError?.('Invalid theme file: missing colors object');
					}
				} catch {
					onImportError?.('Failed to parse theme file: invalid JSON format');
				}
			};
			reader.readAsText(file);

			// Reset file input
			if (fileInputRef.current) {
				fileInputRef.current.value = '';
			}
		},
		[setCustomThemeColors, setCustomThemeBaseId, onImportError, onImportSuccess]
	);

	return (
		<div>
			{/* Custom Theme Header */}
			<div
				className="text-xs font-bold uppercase mb-3 flex items-center gap-2"
				style={{ color: theme.colors.textDim }}
			>
				<Palette className="w-3 h-3" />
				Custom Theme
			</div>

			{/* Theme Selection Button + Controls */}
			<div
				className={`rounded-lg border transition-all ${isSelected ? 'ring-2' : ''}`}
				style={
					{
						borderColor: theme.colors.border,
						backgroundColor: customThemeColors.bgSidebar,
						'--tw-ring-color': customThemeColors.accent,
					} as React.CSSProperties
				}
			>
				{/* Clickable Header to Select Theme */}
				<button onClick={onSelect} className="w-full p-3 text-left" tabIndex={-1}>
					<div className="flex justify-between items-center mb-2">
						<span className="text-sm font-bold" style={{ color: customThemeColors.textMain }}>
							Custom
						</span>
						{isSelected && (
							<Check className="w-4 h-4" style={{ color: customThemeColors.accent }} />
						)}
					</div>
					<div className="flex h-3 rounded overflow-hidden">
						<div className="flex-1" style={{ backgroundColor: customThemeColors.bgMain }} />
						<div className="flex-1" style={{ backgroundColor: customThemeColors.bgActivity }} />
						<div className="flex-1" style={{ backgroundColor: customThemeColors.accent }} />
					</div>
				</button>

				{/* Builder Controls (always visible but styled differently when not selected) */}
				<div
					className="px-3 pb-3 border-t"
					style={{
						borderColor: theme.colors.border,
						opacity: isSelected ? 1 : 0.6,
					}}
				>
					{/* Mini Preview */}
					<div className="py-3">
						<div
							className="text-[10px] uppercase font-bold mb-2"
							style={{ color: theme.colors.textDim }}
						>
							Preview
						</div>
						<MiniUIPreview colors={customThemeColors} />
					</div>

					{/* Action Buttons */}
					<div className="flex gap-2 mb-3">
						{/* Initialize From Base Theme */}
						<div className="relative flex-1">
							<button
								onClick={() => setShowBaseSelector(!showBaseSelector)}
								className="w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs font-medium border hover:opacity-80"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							>
								<RotateCcw className="w-3 h-3" />
								Initialize
								<ChevronDown className="w-3 h-3" />
							</button>

							{showBaseSelector && (
								<div
									className="absolute top-full left-0 right-0 mt-1 rounded-lg border shadow-lg z-10 max-h-48 overflow-y-auto"
									style={{
										backgroundColor: theme.colors.bgSidebar,
										borderColor: theme.colors.border,
									}}
								>
									{baseThemes.map((t) => (
										<button
											key={t.id}
											onClick={() => handleInitializeFromBase(t.id)}
											className="w-full px-2 py-1.5 text-left text-xs hover:opacity-80 flex items-center gap-2"
											style={{
												backgroundColor:
													customThemeBaseId === t.id ? theme.colors.accentDim : 'transparent',
												color: theme.colors.textMain,
											}}
										>
											<div className="flex h-3 w-8 rounded overflow-hidden">
												<div className="flex-1" style={{ backgroundColor: t.colors.bgMain }} />
												<div className="flex-1" style={{ backgroundColor: t.colors.accent }} />
											</div>
											{t.name}
											{customThemeBaseId === t.id && (
												<span
													className="ml-auto text-[9px]"
													style={{ color: theme.colors.textDim }}
												>
													current base
												</span>
											)}
										</button>
									))}
								</div>
							)}
						</div>

						{/* Export */}
						<button
							onClick={handleExport}
							className="flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs font-medium border hover:opacity-80"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
							title="Export theme"
						>
							<Download className="w-3 h-3" />
						</button>

						{/* Import */}
						<button
							onClick={() => fileInputRef.current?.click()}
							className="flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs font-medium border hover:opacity-80"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
							title="Import theme"
						>
							<Upload className="w-3 h-3" />
						</button>
						<input
							ref={fileInputRef}
							type="file"
							accept=".json"
							onChange={handleImport}
							className="hidden"
						/>

						{/* Reset */}
						<button
							onClick={handleReset}
							className="flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs font-medium border hover:opacity-80"
							style={{
								backgroundColor: theme.colors.error + '20',
								borderColor: theme.colors.error + '40',
								color: theme.colors.error,
							}}
							title="Reset to default"
						>
							<RotateCcw className="w-3 h-3" />
						</button>
					</div>

					{/* Color Editors */}
					<div
						className="text-[10px] uppercase font-bold mb-2"
						style={{ color: theme.colors.textDim }}
					>
						Colors
					</div>
					<div
						className="rounded-lg border p-2 max-h-64 overflow-y-auto"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
						}}
					>
						{COLOR_CONFIG.map(({ key, label, description }) => (
							<ColorInput
								key={key}
								colorKey={key}
								label={label}
								description={description}
								value={customThemeColors[key]}
								onChange={handleColorChange}
								theme={theme}
							/>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
