/**
 * SettingsPanel component for Maestro mobile web interface
 *
 * Full-screen settings panel for configuring appearance, behavior, and profile.
 * Follows the same layout pattern as AllSessionsView (full-screen overlay).
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { THEMES } from '../../shared/themes';
import type { ThemeId, Theme } from '../../shared/theme-types';
import type { UseSettingsReturn, WebSettings } from '../hooks/useSettings';

/**
 * Props for SettingsPanel component
 */
export interface SettingsPanelProps {
	onClose: () => void;
	settingsHook: UseSettingsReturn;
}

/**
 * Ordered list of theme IDs to display (excluding 'custom')
 */
const THEME_LIST: { id: ThemeId; theme: Theme }[] = (Object.keys(THEMES) as ThemeId[])
	.filter((id) => id !== 'custom')
	.map((id) => ({ id, theme: THEMES[id] }));

/**
 * Color blind mode options
 */
const COLOR_BLIND_OPTIONS = [
	{ value: 'none', label: 'None' },
	{ value: 'deuteranopia', label: 'Deuteranopia' },
	{ value: 'protanopia', label: 'Protanopia' },
	{ value: 'tritanopia', label: 'Tritanopia' },
];

/**
 * Show thinking options
 */
const SHOW_THINKING_OPTIONS = [
	{ value: 'off', label: 'Off' },
	{ value: 'on', label: 'On' },
	{ value: 'sticky', label: 'Sticky' },
];

/**
 * Max output lines options — mirrors the desktop Display tab.
 * `Infinity` is the "All" sentinel (serialized as null over the wire).
 */
const MAX_OUTPUT_LINES_OPTIONS: { value: number; label: string }[] = [
	{ value: 15, label: '15' },
	{ value: 25, label: '25' },
	{ value: 50, label: '50' },
	{ value: 100, label: '100' },
	{ value: Infinity, label: 'All' },
];

/**
 * "Saved" indicator that fades in/out
 */
function SavedIndicator({ visible }: { visible: boolean }) {
	return (
		<span
			style={{
				fontSize: '11px',
				fontWeight: 600,
				color: '#22c55e',
				opacity: visible ? 1 : 0,
				transition: 'opacity 0.3s ease',
				marginLeft: '8px',
			}}
		>
			Saved
		</span>
	);
}

/**
 * Toggle switch component
 */
function ToggleSwitch({
	checked,
	onChange,
	accentColor,
	dimColor,
}: {
	checked: boolean;
	onChange: () => void;
	accentColor: string;
	dimColor: string;
}) {
	return (
		<button
			onClick={onChange}
			role="switch"
			aria-checked={checked}
			style={{
				width: '44px',
				height: '26px',
				borderRadius: '13px',
				backgroundColor: checked ? accentColor : `${dimColor}30`,
				padding: '2px',
				transition: 'background-color 0.2s ease',
				flexShrink: 0,
				border: 'none',
				cursor: 'pointer',
				touchAction: 'manipulation',
				WebkitTapHighlightColor: 'transparent',
			}}
		>
			<div
				style={{
					width: '22px',
					height: '22px',
					borderRadius: '11px',
					backgroundColor: 'white',
					transition: 'transform 0.2s ease',
					transform: checked ? 'translateX(18px)' : 'translateX(0)',
					boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
				}}
			/>
		</button>
	);
}

/**
 * Section header component
 */
function SectionHeader({
	title,
	colors,
}: {
	title: string;
	colors: ReturnType<typeof useThemeColors>;
}) {
	return (
		<span
			style={{
				display: 'block',
				fontSize: '13px',
				fontWeight: 600,
				color: colors.textDim,
				textTransform: 'uppercase',
				letterSpacing: '0.5px',
				marginBottom: '10px',
			}}
		>
			{title}
		</span>
	);
}

/**
 * SettingsPanel component
 *
 * Full-screen overlay for managing application settings.
 */
export function SettingsPanel({ onClose, settingsHook }: SettingsPanelProps) {
	const colors = useThemeColors();
	const { settings, setSetting, setTheme, setFontSize, setMaxOutputLines } = settingsHook;
	const [savedKey, setSavedKey] = useState<string | null>(null);
	const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const showSaved = useCallback((key: string) => {
		setSavedKey(key);
		if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
		savedTimeoutRef.current = setTimeout(() => setSavedKey(null), 1500);
	}, []);

	// Cleanup timeout on unmount
	useEffect(() => {
		return () => {
			if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
		};
	}, []);

	// Close on escape key
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [onClose]);

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onClose();
	}, [onClose]);

	const handleToggle = useCallback(
		async (key: string, currentValue: boolean) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			const success = await setSetting(key, !currentValue);
			if (success) showSaved(key);
		},
		[setSetting, showSaved]
	);

	const handleThemeSelect = useCallback(
		async (themeId: string) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			const success = await setTheme(themeId);
			if (success) showSaved('theme');
		},
		[setTheme, showSaved]
	);

	const handleFontSizeChange = useCallback(
		async (delta: number) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			const current = settings?.fontSize ?? 14;
			const next = Math.min(24, Math.max(10, current + delta));
			if (next === current) return;
			const success = await setFontSize(next);
			if (success) showSaved('fontSize');
		},
		[settings?.fontSize, setFontSize, showSaved]
	);

	const handleColorBlindChange = useCallback(
		async (value: string) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			const success = await setSetting('colorBlindMode', value);
			if (success) showSaved('colorBlindMode');
		},
		[setSetting, showSaved]
	);

	const handleShowThinkingChange = useCallback(
		async (value: string) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			const success = await setSetting('defaultShowThinking', value);
			if (success) showSaved('defaultShowThinking');
		},
		[setSetting, showSaved]
	);

	const handleConductorProfileChange = useCallback(
		async (value: string) => {
			const success = await setSetting('conductorProfile', value);
			if (success) showSaved('conductorProfile');
		},
		[setSetting, showSaved]
	);

	const handleMaxOutputLinesChange = useCallback(
		async (value: number) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			const success = await setMaxOutputLines(value);
			if (success) showSaved('maxOutputLines');
		},
		[setMaxOutputLines, showSaved]
	);

	if (!settings) {
		return (
			<div
				style={{
					position: 'fixed',
					top: 0,
					left: 0,
					right: 0,
					bottom: 0,
					backgroundColor: colors.bgMain,
					zIndex: 200,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					color: colors.textDim,
					fontSize: '14px',
				}}
			>
				Loading settings...
			</div>
		);
	}

	return (
		<div
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: colors.bgMain,
				zIndex: 200,
				display: 'flex',
				flexDirection: 'column',
				animation: 'settingsPanelSlideUp 0.25s ease-out',
			}}
		>
			{/* Header */}
			<header
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '12px 16px',
					paddingTop: 'max(12px, env(safe-area-inset-top))',
					borderBottom: `1px solid ${colors.border}`,
					backgroundColor: colors.bgSidebar,
					minHeight: '56px',
					flexShrink: 0,
				}}
			>
				<h1
					style={{
						fontSize: '18px',
						fontWeight: 600,
						margin: 0,
						color: colors.textMain,
					}}
				>
					Settings
				</h1>
				<button
					onClick={handleClose}
					style={{
						width: '44px',
						height: '44px',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						borderRadius: '8px',
						backgroundColor: colors.bgMain,
						border: `1px solid ${colors.border}`,
						color: colors.textMain,
						cursor: 'pointer',
						touchAction: 'manipulation',
						WebkitTapHighlightColor: 'transparent',
					}}
					aria-label="Close settings"
				>
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			</header>

			{/* Scrollable content */}
			<div
				style={{
					flex: 1,
					overflowY: 'auto',
					overflowX: 'hidden',
					padding: '16px',
					paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
				}}
			>
				{/* Appearance Section */}
				<div style={{ marginBottom: '24px' }}>
					<SectionHeader title="Appearance" colors={colors} />

					{/* Theme selector */}
					<div style={{ marginBottom: '16px' }}>
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								marginBottom: '10px',
							}}
						>
							<span style={{ fontSize: '14px', fontWeight: 500, color: colors.textMain }}>
								Theme
							</span>
							<SavedIndicator visible={savedKey === 'theme'} />
						</div>
						<div
							style={{
								display: 'flex',
								gap: '10px',
								overflowX: 'auto',
								padding: '4px 0',
								WebkitOverflowScrolling: 'touch',
							}}
						>
							{THEME_LIST.map(({ id, theme }) => {
								const isActive = settings.theme === id;
								return (
									<button
										key={id}
										onClick={() => handleThemeSelect(id)}
										title={theme.name}
										style={{
											width: '48px',
											height: '48px',
											minWidth: '48px',
											borderRadius: '24px',
											border: isActive
												? `3px solid ${colors.accent}`
												: `2px solid ${colors.border}`,
											cursor: 'pointer',
											touchAction: 'manipulation',
											WebkitTapHighlightColor: 'transparent',
											padding: 0,
											overflow: 'hidden',
											position: 'relative',
											background: 'none',
											outline: isActive ? `2px solid ${colors.accent}40` : 'none',
											outlineOffset: '2px',
										}}
										aria-label={`${theme.name} theme${isActive ? ' (active)' : ''}`}
										aria-pressed={isActive}
									>
										{/* Two-tone circle: left half = bgMain, right half = accent */}
										<div
											style={{
												position: 'absolute',
												top: 0,
												left: 0,
												width: '50%',
												height: '100%',
												backgroundColor: theme.colors.bgMain,
											}}
										/>
										<div
											style={{
												position: 'absolute',
												top: 0,
												right: 0,
												width: '50%',
												height: '100%',
												backgroundColor: theme.colors.accent,
											}}
										/>
									</button>
								);
							})}
						</div>
					</div>

					{/* Font size */}
					<div style={{ marginBottom: '16px' }}>
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								padding: '12px 14px',
								borderRadius: '10px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgSidebar,
								minHeight: '44px',
							}}
						>
							<div style={{ display: 'flex', alignItems: 'center' }}>
								<span style={{ fontSize: '14px', fontWeight: 500, color: colors.textMain }}>
									Font Size
								</span>
								<SavedIndicator visible={savedKey === 'fontSize'} />
							</div>
							<div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
								<button
									onClick={() => handleFontSizeChange(-1)}
									disabled={settings.fontSize <= 10}
									style={{
										width: '32px',
										height: '32px',
										borderRadius: '8px',
										border: `1px solid ${colors.border}`,
										backgroundColor: colors.bgMain,
										color: settings.fontSize <= 10 ? colors.textDim : colors.textMain,
										fontSize: '16px',
										fontWeight: 600,
										cursor: settings.fontSize <= 10 ? 'not-allowed' : 'pointer',
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
										touchAction: 'manipulation',
										WebkitTapHighlightColor: 'transparent',
										opacity: settings.fontSize <= 10 ? 0.4 : 1,
									}}
									aria-label="Decrease font size"
								>
									-
								</button>
								<span
									style={{
										fontSize: '14px',
										fontWeight: 600,
										color: colors.textMain,
										minWidth: '24px',
										textAlign: 'center',
									}}
								>
									{settings.fontSize}
								</span>
								<button
									onClick={() => handleFontSizeChange(1)}
									disabled={settings.fontSize >= 24}
									style={{
										width: '32px',
										height: '32px',
										borderRadius: '8px',
										border: `1px solid ${colors.border}`,
										backgroundColor: colors.bgMain,
										color: settings.fontSize >= 24 ? colors.textDim : colors.textMain,
										fontSize: '16px',
										fontWeight: 600,
										cursor: settings.fontSize >= 24 ? 'not-allowed' : 'pointer',
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
										touchAction: 'manipulation',
										WebkitTapHighlightColor: 'transparent',
										opacity: settings.fontSize >= 24 ? 0.4 : 1,
									}}
									aria-label="Increase font size"
								>
									+
								</button>
							</div>
						</div>
					</div>

					{/* Color blind mode */}
					<div>
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								marginBottom: '8px',
							}}
						>
							<span style={{ fontSize: '14px', fontWeight: 500, color: colors.textMain }}>
								Color Blind Mode
							</span>
							<SavedIndicator visible={savedKey === 'colorBlindMode'} />
						</div>
						<div
							style={{
								display: 'flex',
								gap: '6px',
								flexWrap: 'wrap',
							}}
						>
							{COLOR_BLIND_OPTIONS.map((opt) => {
								const isActive = (settings.colorBlindMode || 'none') === opt.value;
								return (
									<button
										key={opt.value}
										onClick={() => handleColorBlindChange(opt.value)}
										style={{
											padding: '8px 14px',
											borderRadius: '8px',
											border: isActive
												? `2px solid ${colors.accent}`
												: `1px solid ${colors.border}`,
											backgroundColor: isActive ? `${colors.accent}15` : colors.bgSidebar,
											color: isActive ? colors.accent : colors.textMain,
											fontSize: '13px',
											fontWeight: isActive ? 600 : 400,
											cursor: 'pointer',
											touchAction: 'manipulation',
											WebkitTapHighlightColor: 'transparent',
											minHeight: '36px',
										}}
										aria-pressed={isActive}
									>
										{opt.label}
									</button>
								);
							})}
						</div>
					</div>
				</div>

				{/* Behavior Section */}
				<div style={{ marginBottom: '24px' }}>
					<SectionHeader title="Behavior" colors={colors} />

					<div
						style={{
							display: 'flex',
							flexDirection: 'column',
							gap: '6px',
						}}
					>
						{/* Toggle rows */}
						{(
							[
								{ key: 'enterToSendAI', label: 'Enter to send (AI mode)', field: 'enterToSendAI' },
								{
									key: 'defaultSaveToHistory',
									label: 'Save to history by default',
									field: 'defaultSaveToHistory',
								},
							] as const
						).map((item) => (
							<div
								key={item.key}
								style={{
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'space-between',
									padding: '12px 14px',
									borderRadius: '10px',
									border: `1px solid ${colors.border}`,
									backgroundColor: colors.bgSidebar,
									minHeight: '44px',
								}}
							>
								<div style={{ display: 'flex', alignItems: 'center' }}>
									<span style={{ fontSize: '14px', fontWeight: 500, color: colors.textMain }}>
										{item.label}
									</span>
									<SavedIndicator visible={savedKey === item.key} />
								</div>
								<ToggleSwitch
									checked={settings[item.field as keyof WebSettings] as boolean}
									onChange={() =>
										handleToggle(item.key, settings[item.field as keyof WebSettings] as boolean)
									}
									accentColor={colors.accent}
									dimColor={colors.textDim}
								/>
							</div>
						))}

						{/* Show thinking selector */}
						<div
							style={{
								padding: '12px 14px',
								borderRadius: '10px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgSidebar,
								minHeight: '44px',
							}}
						>
							<div
								style={{
									display: 'flex',
									alignItems: 'center',
									marginBottom: '10px',
								}}
							>
								<span style={{ fontSize: '14px', fontWeight: 500, color: colors.textMain }}>
									Show thinking
								</span>
								<SavedIndicator visible={savedKey === 'defaultShowThinking'} />
							</div>
							<div style={{ display: 'flex', gap: '6px' }}>
								{SHOW_THINKING_OPTIONS.map((opt) => {
									const isActive = (settings.defaultShowThinking || 'off') === opt.value;
									return (
										<button
											key={opt.value}
											onClick={() => handleShowThinkingChange(opt.value)}
											style={{
												flex: 1,
												padding: '8px 12px',
												borderRadius: '8px',
												border: isActive
													? `2px solid ${colors.accent}`
													: `1px solid ${colors.border}`,
												backgroundColor: isActive ? `${colors.accent}15` : colors.bgMain,
												color: isActive ? colors.accent : colors.textMain,
												fontSize: '13px',
												fontWeight: isActive ? 600 : 400,
												cursor: 'pointer',
												touchAction: 'manipulation',
												WebkitTapHighlightColor: 'transparent',
												minHeight: '36px',
											}}
											aria-pressed={isActive}
										>
											{opt.label}
										</button>
									);
								})}
							</div>
						</div>

						{/* Max Output Lines per Response */}
						<div
							style={{
								padding: '12px 14px',
								borderRadius: '10px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgSidebar,
								minHeight: '44px',
							}}
						>
							<div
								style={{
									display: 'flex',
									alignItems: 'center',
									marginBottom: '10px',
								}}
							>
								<span style={{ fontSize: '14px', fontWeight: 500, color: colors.textMain }}>
									Max Output Lines per Response
								</span>
								<SavedIndicator visible={savedKey === 'maxOutputLines'} />
							</div>
							<div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
								{MAX_OUTPUT_LINES_OPTIONS.map((opt) => {
									// Null (from wire) and undefined (unset) both mean "All"/Infinity.
									const currentRaw = settings.maxOutputLines;
									const currentValue =
										currentRaw === null || currentRaw === undefined ? Infinity : currentRaw;
									const isActive = currentValue === opt.value;
									return (
										<button
											key={opt.label}
											onClick={() => handleMaxOutputLinesChange(opt.value)}
											style={{
												flex: 1,
												padding: '8px 12px',
												borderRadius: '8px',
												border: isActive
													? `2px solid ${colors.accent}`
													: `1px solid ${colors.border}`,
												backgroundColor: isActive ? `${colors.accent}15` : colors.bgMain,
												color: isActive ? colors.accent : colors.textMain,
												fontSize: '13px',
												fontWeight: isActive ? 600 : 400,
												cursor: 'pointer',
												touchAction: 'manipulation',
												WebkitTapHighlightColor: 'transparent',
												minHeight: '36px',
											}}
											aria-pressed={isActive}
										>
											{opt.label}
										</button>
									);
								})}
							</div>
							<p
								style={{
									fontSize: '11px',
									color: colors.textDim,
									marginTop: '8px',
									lineHeight: 1.4,
								}}
							>
								Long outputs are collapsed into a scrollable window. Set to "All" to always show the
								full response.
							</p>
						</div>
					</div>
				</div>

				{/* Profile Section */}
				<div style={{ marginBottom: '24px' }}>
					<SectionHeader title="Profile" colors={colors} />

					<div
						style={{
							padding: '12px 14px',
							borderRadius: '10px',
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.bgSidebar,
						}}
					>
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								marginBottom: '10px',
							}}
						>
							<span style={{ fontSize: '14px', fontWeight: 500, color: colors.textMain }}>
								Conductor Profile
							</span>
							<SavedIndicator visible={savedKey === 'conductorProfile'} />
						</div>
						<textarea
							value={settings.conductorProfile || ''}
							onChange={(e) => handleConductorProfileChange(e.target.value)}
							placeholder="Tell your agents about yourself..."
							rows={4}
							style={{
								width: '100%',
								padding: '10px 12px',
								borderRadius: '8px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgMain,
								color: colors.textMain,
								fontSize: '14px',
								fontFamily: 'inherit',
								resize: 'vertical',
								outline: 'none',
								boxSizing: 'border-box',
							}}
						/>
					</div>
				</div>
			</div>

			{/* Animation keyframes */}
			<style>{`
				@keyframes settingsPanelSlideUp {
					from {
						opacity: 0;
						transform: translateY(20px);
					}
					to {
						opacity: 1;
						transform: translateY(0);
					}
				}
			`}</style>
		</div>
	);
}

export default SettingsPanel;
