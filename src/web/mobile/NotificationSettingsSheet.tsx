/**
 * NotificationSettingsSheet component for Maestro mobile web interface
 *
 * Bottom sheet modal for configuring push notification preferences.
 * Allows toggling individual notification event types and sound.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { NotificationPreferences, NotificationPermission } from '../hooks/useNotifications';

/**
 * Props for NotificationSettingsSheet component
 */
export interface NotificationSettingsSheetProps {
	preferences: NotificationPreferences;
	onPreferencesChange: (prefs: Partial<NotificationPreferences>) => void;
	permission: NotificationPermission;
	onClose: () => void;
}

/**
 * Toggle item configuration
 */
interface ToggleItem {
	key: keyof NotificationPreferences;
	label: string;
	description: string;
}

const EVENT_TOGGLES: ToggleItem[] = [
	{ key: 'agentComplete', label: 'Agent Complete', description: 'When an agent finishes thinking' },
	{ key: 'agentError', label: 'Agent Error', description: 'When an agent encounters an error' },
	{
		key: 'autoRunComplete',
		label: 'Auto Run Complete',
		description: 'When Auto Run finishes all documents',
	},
	{
		key: 'autoRunTaskComplete',
		label: 'Auto Run Task Complete',
		description: 'When each individual task completes',
	},
	{
		key: 'contextWarning',
		label: 'Context Warning',
		description: 'When context window is running low',
	},
];

/**
 * Permission status badge colors
 */
function getPermissionBadge(permission: NotificationPermission): {
	label: string;
	color: string;
	bgColor: string;
} {
	switch (permission) {
		case 'granted':
			return { label: 'Enabled', color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.15)' };
		case 'denied':
			return { label: 'Blocked', color: '#ef4444', bgColor: 'rgba(239, 68, 68, 0.15)' };
		default:
			return { label: 'Not Set', color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.15)' };
	}
}

/**
 * NotificationSettingsSheet component
 *
 * Bottom sheet modal that slides up from the bottom of the screen.
 * Provides notification permission management and per-event-type toggles.
 */
export function NotificationSettingsSheet({
	preferences,
	onPreferencesChange,
	permission,
	onClose,
}: NotificationSettingsSheetProps) {
	const colors = useThemeColors();
	const [isVisible, setIsVisible] = useState(false);
	const sheetRef = useRef<HTMLDivElement>(null);

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsVisible(false);
		setTimeout(() => onClose(), 300);
	}, [onClose]);

	// Animate in on mount
	useEffect(() => {
		requestAnimationFrame(() => setIsVisible(true));
	}, []);

	// Close on escape key
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				handleClose();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [handleClose]);

	const handleBackdropTap = useCallback(
		(e: React.MouseEvent) => {
			if (e.target === e.currentTarget) {
				handleClose();
			}
		},
		[handleClose]
	);

	const handleToggle = useCallback(
		(key: keyof NotificationPreferences) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			onPreferencesChange({ [key]: !preferences[key] });
		},
		[preferences, onPreferencesChange]
	);

	const handleRequestPermission = useCallback(async () => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		if ('Notification' in window) {
			await Notification.requestPermission();
		}
	}, []);

	const badge = getPermissionBadge(permission);

	return (
		<div
			onClick={handleBackdropTap}
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: `rgba(0, 0, 0, ${isVisible ? 0.5 : 0})`,
				zIndex: 220,
				display: 'flex',
				alignItems: 'flex-end',
				transition: 'background-color 0.3s ease-out',
			}}
		>
			{/* Sheet */}
			<div
				ref={sheetRef}
				style={{
					width: '100%',
					maxHeight: '80vh',
					backgroundColor: colors.bgMain,
					borderTopLeftRadius: '16px',
					borderTopRightRadius: '16px',
					display: 'flex',
					flexDirection: 'column',
					transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
					transition: 'transform 0.3s ease-out',
					paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
				}}
			>
				{/* Drag handle */}
				<div
					style={{
						display: 'flex',
						justifyContent: 'center',
						padding: '10px 0 4px',
						flexShrink: 0,
					}}
				>
					<div
						style={{
							width: '36px',
							height: '4px',
							borderRadius: '2px',
							backgroundColor: `${colors.textDim}40`,
						}}
					/>
				</div>

				{/* Header */}
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						padding: '8px 16px 12px',
						flexShrink: 0,
					}}
				>
					<h2
						style={{
							fontSize: '18px',
							fontWeight: 600,
							margin: 0,
							color: colors.textMain,
						}}
					>
						Notification Settings
					</h2>
					<button
						onClick={handleClose}
						style={{
							width: '44px',
							height: '44px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: colors.bgSidebar,
							border: `1px solid ${colors.border}`,
							color: colors.textMain,
							cursor: 'pointer',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
						}}
						aria-label="Close notification settings"
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
				</div>

				{/* Scrollable content */}
				<div
					style={{
						flex: 1,
						overflowY: 'auto',
						overflowX: 'hidden',
						padding: '0 16px',
					}}
				>
					{/* Permission status section */}
					<div style={{ marginBottom: '20px' }}>
						<span
							style={{
								fontSize: '13px',
								fontWeight: 600,
								color: colors.textDim,
								textTransform: 'uppercase',
								letterSpacing: '0.5px',
							}}
						>
							Permission
						</span>
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								padding: '12px 14px',
								borderRadius: '10px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgSidebar,
								marginTop: '10px',
								minHeight: '44px',
							}}
						>
							<div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
								{/* Bell icon */}
								<svg
									width="20"
									height="20"
									viewBox="0 0 24 24"
									fill="none"
									stroke={colors.textMain}
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
									<path d="M13.73 21a2 2 0 0 1-3.46 0" />
								</svg>
								<span style={{ fontSize: '14px', fontWeight: 500, color: colors.textMain }}>
									Browser Notifications
								</span>
							</div>
							{/* Status badge */}
							<span
								style={{
									fontSize: '12px',
									fontWeight: 600,
									padding: '4px 10px',
									borderRadius: '12px',
									color: badge.color,
									backgroundColor: badge.bgColor,
								}}
							>
								{badge.label}
							</span>
						</div>

						{permission !== 'granted' && (
							<button
								onClick={handleRequestPermission}
								disabled={permission === 'denied'}
								style={{
									width: '100%',
									padding: '12px 14px',
									borderRadius: '10px',
									backgroundColor: permission === 'denied' ? `${colors.accent}40` : colors.accent,
									border: 'none',
									color: 'white',
									fontSize: '14px',
									fontWeight: 600,
									cursor: permission === 'denied' ? 'not-allowed' : 'pointer',
									opacity: permission === 'denied' ? 0.5 : 1,
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
									marginTop: '8px',
									minHeight: '44px',
								}}
								aria-label="Enable notifications"
							>
								{permission === 'denied'
									? 'Blocked — Enable in Browser Settings'
									: 'Enable Notifications'}
							</button>
						)}
					</div>

					{/* Event toggles section */}
					<div style={{ marginBottom: '20px' }}>
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
							Events
						</span>
						<div
							style={{
								display: 'flex',
								flexDirection: 'column',
								gap: '6px',
							}}
						>
							{EVENT_TOGGLES.map((toggle) => (
								<button
									key={toggle.key}
									onClick={() => handleToggle(toggle.key)}
									style={{
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'space-between',
										width: '100%',
										padding: '12px 14px',
										borderRadius: '10px',
										border: `1px solid ${colors.border}`,
										backgroundColor: colors.bgSidebar,
										color: colors.textMain,
										cursor: 'pointer',
										touchAction: 'manipulation',
										WebkitTapHighlightColor: 'transparent',
										outline: 'none',
										minHeight: '44px',
									}}
									role="switch"
									aria-checked={preferences[toggle.key]}
									aria-label={toggle.label}
								>
									<div style={{ textAlign: 'left' }}>
										<div style={{ fontSize: '14px', fontWeight: 500 }}>{toggle.label}</div>
										<div style={{ fontSize: '12px', color: colors.textDim, marginTop: '2px' }}>
											{toggle.description}
										</div>
									</div>
									{/* Toggle switch */}
									<div
										style={{
											width: '44px',
											height: '26px',
											borderRadius: '13px',
											backgroundColor: preferences[toggle.key]
												? colors.accent
												: `${colors.textDim}30`,
											padding: '2px',
											transition: 'background-color 0.2s ease',
											flexShrink: 0,
											marginLeft: '12px',
										}}
									>
										<div
											style={{
												width: '22px',
												height: '22px',
												borderRadius: '11px',
												backgroundColor: 'white',
												transition: 'transform 0.2s ease',
												transform: preferences[toggle.key] ? 'translateX(18px)' : 'translateX(0)',
												boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
											}}
										/>
									</div>
								</button>
							))}
						</div>
					</div>

					{/* Sound toggle section */}
					<div style={{ marginBottom: '20px' }}>
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
							Sound
						</span>
						<button
							onClick={() => handleToggle('soundEnabled')}
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								width: '100%',
								padding: '12px 14px',
								borderRadius: '10px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgSidebar,
								color: colors.textMain,
								cursor: 'pointer',
								touchAction: 'manipulation',
								WebkitTapHighlightColor: 'transparent',
								outline: 'none',
								minHeight: '44px',
							}}
							role="switch"
							aria-checked={preferences.soundEnabled}
							aria-label="Play sound with notifications"
						>
							<span style={{ fontSize: '14px', fontWeight: 500 }}>
								Play sound with notifications
							</span>
							{/* Toggle switch */}
							<div
								style={{
									width: '44px',
									height: '26px',
									borderRadius: '13px',
									backgroundColor: preferences.soundEnabled ? colors.accent : `${colors.textDim}30`,
									padding: '2px',
									transition: 'background-color 0.2s ease',
									flexShrink: 0,
								}}
							>
								<div
									style={{
										width: '22px',
										height: '22px',
										borderRadius: '11px',
										backgroundColor: 'white',
										transition: 'transform 0.2s ease',
										transform: preferences.soundEnabled ? 'translateX(18px)' : 'translateX(0)',
										boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
									}}
								/>
							</div>
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

export default NotificationSettingsSheet;
