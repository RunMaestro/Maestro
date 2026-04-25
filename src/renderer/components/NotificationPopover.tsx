import { useRef, useEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Volume2, Coffee, type LucideIcon } from 'lucide-react';
import type { Theme } from '../types';
import { ToggleSwitch } from './ui/ToggleSwitch';
import { useClickOutside } from '../hooks/ui/useClickOutside';
import { useSettingsStore } from '../stores/settingsStore';

interface NotificationPopoverProps {
	theme: Theme;
	anchorRef: React.RefObject<HTMLElement | null>;
	onClose: () => void;
}

/**
 * Popover for toggling notification types (OS, custom/audio, idle).
 * Stays open when toggling items; dismisses on click-outside or Escape.
 */
export const NotificationPopover = memo(function NotificationPopover({
	theme,
	anchorRef,
	onClose,
}: NotificationPopoverProps) {
	const popoverRef = useRef<HTMLDivElement>(null);

	// Settings store
	const osNotificationsEnabled = useSettingsStore((s) => s.osNotificationsEnabled);
	const setOsNotificationsEnabled = useSettingsStore((s) => s.setOsNotificationsEnabled);
	const audioFeedbackEnabled = useSettingsStore((s) => s.audioFeedbackEnabled);
	const setAudioFeedbackEnabled = useSettingsStore((s) => s.setAudioFeedbackEnabled);
	const idleNotificationEnabled = useSettingsStore((s) => s.idleNotificationEnabled);
	const setIdleNotificationEnabled = useSettingsStore((s) => s.setIdleNotificationEnabled);

	// Click-outside dismissal (exclude both popover and anchor button)
	useClickOutside([popoverRef, anchorRef] as React.RefObject<HTMLElement | null>[], onClose, true, {
		delay: true,
	});

	// Escape key dismissal
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [onClose]);

	// Position relative to anchor
	const anchorRect = anchorRef.current?.getBoundingClientRect();
	if (!anchorRect) return null;

	const style: React.CSSProperties = {
		position: 'fixed',
		// Appear to the left of the button, vertically centered
		top: anchorRect.top - 4,
		right: window.innerWidth - anchorRect.left + 8,
		zIndex: 9999,
		backgroundColor: theme.colors.bgMain,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};

	const items: ReadonlyArray<{
		label: string;
		icon: LucideIcon;
		checked: boolean;
		onChange: (value: boolean) => void;
	}> = [
		{
			label: 'OS Notifications',
			icon: Bell,
			checked: osNotificationsEnabled,
			onChange: setOsNotificationsEnabled,
		},
		{
			label: 'Custom Notifications',
			icon: Volume2,
			checked: audioFeedbackEnabled,
			onChange: setAudioFeedbackEnabled,
		},
		{
			label: 'Idle Notifications',
			icon: Coffee,
			checked: idleNotificationEnabled,
			onChange: setIdleNotificationEnabled,
		},
	];

	return createPortal(
		<div
			ref={popoverRef}
			className="rounded-lg border shadow-lg py-2 px-3"
			style={style}
			tabIndex={-1}
		>
			{items.map((item) => {
				const Icon = item.icon;
				return (
					<div
						key={item.label}
						className="flex items-center justify-between gap-4 py-1.5"
						style={{ minWidth: 200 }}
					>
						<span
							className="flex items-center gap-2 text-xs whitespace-nowrap"
							style={{ color: theme.colors.textDim }}
						>
							<Icon className="w-3.5 h-3.5" />
							{item.label}
						</span>
						<ToggleSwitch
							checked={item.checked}
							onChange={item.onChange}
							theme={theme}
							ariaLabel={item.label}
						/>
					</div>
				);
			})}
		</div>,
		document.body
	);
});
