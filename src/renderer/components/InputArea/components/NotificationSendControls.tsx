import { memo, useEffect, useRef, useState } from 'react';
import { ArrowUp, Bell, ChevronDown } from 'lucide-react';
import type { OmpDeliveryIntent } from '../../../../shared/omp-native-session';
import type { Theme } from '../../../types';
import { NotificationPopover } from '../../NotificationPopover';

interface NotificationSendControlsProps {
	theme: Theme;
	isTerminalMode: boolean;
	processInput: () => void;
	ompBusy?: boolean;
	onOmpDelivery?: (intent: OmpDeliveryIntent) => void;
}

const DELIVERY_OPTIONS: ReadonlyArray<{
	intent: OmpDeliveryIntent;
	label: string;
	shortcut: string;
}> = [
	{ intent: 'steer', label: 'Steer now', shortcut: 'Enter' },
	{ intent: 'follow_up', label: 'Queue follow-up', shortcut: 'Ctrl+Enter' },
	{ intent: 'abort_and_prompt', label: 'Interrupt & replace', shortcut: 'Ctrl+Shift+Enter' },
];

export const NotificationSendControls = memo(function NotificationSendControls({
	theme,
	isTerminalMode,
	processInput,
	ompBusy = false,
	onOmpDelivery,
}: NotificationSendControlsProps) {
	const [notificationPopoverOpen, setNotificationPopoverOpen] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [selectedIntent, setSelectedIntent] = useState<OmpDeliveryIntent>('steer');
	const notificationBtnRef = useRef<HTMLButtonElement>(null);
	const menuButtonRef = useRef<HTMLButtonElement>(null);
	const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const selected = DELIVERY_OPTIONS.find((option) => option.intent === selectedIntent)!;

	useEffect(() => {
		if (!menuOpen) return;
		menuItemRefs.current[0]?.focus();
	}, [menuOpen]);

	const deliver = (intent: OmpDeliveryIntent) => {
		setSelectedIntent(intent);
		setMenuOpen(false);
		onOmpDelivery?.(intent);
	};

	const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const currentIndex = menuItemRefs.current.findIndex((item) => item === document.activeElement);
		if (event.key === 'Escape') {
			event.preventDefault();
			setMenuOpen(false);
			menuButtonRef.current?.focus();
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		const direction = event.key === 'ArrowDown' ? 1 : -1;
		const nextIndex =
			(currentIndex + direction + DELIVERY_OPTIONS.length) % DELIVERY_OPTIONS.length;
		menuItemRefs.current[nextIndex]?.focus();
	};

	return (
		<div className="flex flex-shrink-0 flex-col gap-2">
			<button
				ref={notificationBtnRef}
				type="button"
				onClick={() => setNotificationPopoverOpen((prev) => !prev)}
				className="p-2 rounded-lg border transition-all"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					color: theme.colors.textDim,
				}}
				title="Notification Settings"
			>
				<Bell className="w-4 h-4" />
			</button>
			{notificationPopoverOpen && (
				<NotificationPopover
					theme={theme}
					anchorRef={notificationBtnRef}
					onClose={() => setNotificationPopoverOpen(false)}
				/>
			)}
			{ompBusy ? (
				<div className="relative flex" role="group" aria-label="OMP delivery controls">
					<button
						type="button"
						onClick={() => deliver(selectedIntent)}
						className="min-w-0 px-2 py-2 rounded-l-md shadow-sm transition-all hover:opacity-90 cursor-pointer text-xs font-semibold"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						title={`${selected.label} (${selected.shortcut})`}
					>
						{selected.intent === 'steer'
							? 'Steer'
							: selected.intent === 'follow_up'
								? 'Queue'
								: 'Replace'}
					</button>
					<button
						ref={menuButtonRef}
						type="button"
						aria-label="Choose OMP delivery mode"
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						onClick={() => setMenuOpen((open) => !open)}
						onKeyDown={(event) => {
							if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
								event.preventDefault();
								setMenuOpen(true);
							}
						}}
						className="px-1.5 py-2 rounded-r-md border-l transition-all hover:opacity-90 cursor-pointer"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
							borderColor: `${theme.colors.accentForeground}45`,
						}}
					>
						<ChevronDown className="w-3.5 h-3.5" aria-hidden />
					</button>
					{menuOpen && (
						<div
							role="menu"
							aria-label="OMP delivery mode"
							onKeyDown={onMenuKeyDown}
							className="absolute bottom-full right-0 z-30 mb-1 min-w-52 rounded-md border p-1 shadow-lg"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								borderColor: theme.colors.border,
							}}
						>
							{DELIVERY_OPTIONS.map((option, index) => (
								<button
									key={option.intent}
									ref={(node) => {
										menuItemRefs.current[index] = node;
									}}
									type="button"
									role="menuitem"
									onClick={() => deliver(option.intent)}
									className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-xs hover:bg-white/10"
									style={{ color: theme.colors.textMain }}
								>
									<span>{option.label}</span>
									<kbd style={{ color: theme.colors.textDim }}>{option.shortcut}</kbd>
								</button>
							))}
						</div>
					)}
				</div>
			) : (
				<button
					type="button"
					onClick={() => processInput()}
					className="p-2 rounded-md shadow-sm transition-all hover:opacity-90 cursor-pointer"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
					title={isTerminalMode ? 'Run command (Enter)' : 'Send message'}
				>
					<ArrowUp className="w-4 h-4" />
				</button>
			)}
		</div>
	);
});
