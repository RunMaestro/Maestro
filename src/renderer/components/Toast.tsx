import React, { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Theme } from '../types';
import { useNotificationStore, type Toast as ToastType } from '../stores/notificationStore';
import { openUrl } from '../utils/openUrl';
import { formatDurationParts as formatDuration } from '../../shared/formatters';

interface ToastContainerProps {
	theme: Theme;
	onSessionClick?: (sessionId: string, tabId?: string) => void;
}

const ToastItem = memo(function ToastItem({
	toast,
	theme,
	onRemove,
	onSessionClick,
}: {
	toast: ToastType;
	theme: Theme;
	onRemove: (toastId: string) => void;
	onSessionClick?: (sessionId: string, tabId?: string) => void;
}) {
	const [isExiting, setIsExiting] = useState(false);
	const [isEntering, setIsEntering] = useState(true);

	useEffect(() => {
		// Trigger enter animation
		const enterTimer = setTimeout(() => setIsEntering(false), 50);
		return () => clearTimeout(enterTimer);
	}, []);

	useEffect(() => {
		// Start exit animation before removal
		if (toast.duration && toast.duration > 0) {
			const exitTimer = setTimeout(() => {
				setIsExiting(true);
			}, toast.duration - 300); // Start exit animation 300ms before removal
			return () => clearTimeout(exitTimer);
		}
	}, [toast.duration]);

	const handleClose = (e?: React.MouseEvent) => {
		e?.stopPropagation();
		setIsExiting(true);
		setTimeout(() => onRemove(toast.id), 300);
	};

	// Handle click on toast to navigate to session or trigger custom action
	const handleToastClick = () => {
		if (toast.onClick) {
			toast.onClick();
			handleClose();
		} else if (toast.sessionId && onSessionClick) {
			onSessionClick(toast.sessionId, toast.tabId);
			handleClose();
		}
	};

	// Check if toast is clickable (has session navigation or custom action)
	const isClickable = toast.onClick || (toast.sessionId && onSessionClick);

	// Icon based on the toast color (5-color design language).
	const getIcon = () => {
		switch (toast.color) {
			case 'green':
				return (
					<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
					</svg>
				);
			case 'red':
				return (
					<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
				);
			case 'yellow':
				// Info-style "i" — yellow is a soft heads-up.
				return (
					<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
				);
			case 'orange':
				// AlertTriangle — more emphatic warning than yellow.
				return (
					<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
						/>
					</svg>
				);
			case 'theme':
			default:
				// Sparkles — themed default, no semantic.
				return (
					<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
						/>
					</svg>
				);
		}
	};

	/** Fixed orange — no theme defines this slot. Matches CenterFlash. */
	const ORANGE_HEX = '#f97316';

	const getTypeColor = () => {
		switch (toast.color) {
			case 'green':
				return theme.colors.success;
			case 'red':
				return theme.colors.error;
			case 'yellow':
				return theme.colors.warning;
			case 'orange':
				return ORANGE_HEX;
			case 'theme':
			default:
				return theme.colors.accent;
		}
	};

	return (
		<div
			className="relative overflow-hidden transition-all duration-300 ease-out"
			style={{
				opacity: isEntering ? 0 : isExiting ? 0 : 1,
				transform: isEntering
					? 'translateX(100%)'
					: isExiting
						? 'translateX(100%)'
						: 'translateX(0)',
				marginBottom: '8px',
			}}
		>
			<div
				className={`flex items-start gap-3 p-4 rounded-lg shadow-lg backdrop-blur-sm ${isClickable ? 'cursor-pointer hover:brightness-110' : ''}`}
				style={{
					backgroundColor: theme.colors.bgSidebar,
					border: `1px solid ${theme.colors.border}`,
					minWidth: '320px',
					maxWidth: '400px',
				}}
				onClick={isClickable ? handleToastClick : undefined}
			>
				{/* Icon */}
				<div
					className="flex-shrink-0 p-1 rounded"
					style={{
						color: getTypeColor(),
						backgroundColor: `${getTypeColor()}20`,
					}}
				>
					{getIcon()}
				</div>

				{/* Content */}
				<div className="flex-1 min-w-0">
					{/* Line 1: Group + Agent/Project name + Tab name (wraps to line 2 if needed) */}
					{(toast.group || toast.project || toast.tabName) && (
						<div
							className="flex flex-wrap items-center gap-2 text-xs mb-1"
							style={{ color: theme.colors.textDim }}
						>
							{toast.group && (
								<span
									className="px-1.5 py-0.5 rounded"
									style={{
										backgroundColor: theme.colors.accentDim,
										color: theme.colors.accentText,
									}}
								>
									{toast.group}
								</span>
							)}
							{toast.project && (
								<span className="truncate font-medium" style={{ color: theme.colors.textMain }}>
									{toast.project}
								</span>
							)}
							{toast.tabName && (
								<span
									className="font-mono px-1.5 py-0.5 rounded-full truncate"
									style={{
										backgroundColor: theme.colors.accent + '30',
										color: theme.colors.accent,
										border: `1px solid ${theme.colors.accent}50`,
									}}
									title={
										toast.agentSessionId ? `Claude Session: ${toast.agentSessionId}` : undefined
									}
								>
									{toast.tabName}
								</span>
							)}
						</div>
					)}

					{/* Title */}
					<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
						{toast.title}
					</div>

					{/* Message */}
					<div className="text-xs mt-1 leading-relaxed" style={{ color: theme.colors.textDim }}>
						{toast.message}
					</div>

					{/* Action link */}
					{toast.actionUrl && (
						<button
							type="button"
							className="flex items-center gap-1 text-xs mt-2 hover:underline"
							style={{ color: theme.colors.accent }}
							onClick={(e) => {
								e.stopPropagation();
								openUrl(toast.actionUrl!);
							}}
						>
							<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
								/>
							</svg>
							<span className="truncate">{toast.actionLabel || toast.actionUrl}</span>
						</button>
					)}

					{/* Duration badge */}
					{toast.taskDuration && toast.taskDuration > 0 && (
						<div
							className="flex items-center gap-1 text-xs mt-2"
							style={{ color: theme.colors.textDim }}
						>
							<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
							<span>Completed in {formatDuration(toast.taskDuration)}</span>
						</div>
					)}
				</div>

				{/* Close button — emphasized when toast is dismissible (sticky) */}
				<button
					onClick={handleClose}
					className="flex-shrink-0 p-1 rounded transition-colors"
					style={
						toast.dismissible
							? {
									color: getTypeColor(),
									backgroundColor: `${getTypeColor()}1F`,
									boxShadow: `0 0 0 1px ${getTypeColor()}40 inset`,
								}
							: { color: theme.colors.textDim }
					}
					title={toast.dismissible ? 'Dismiss' : undefined}
					aria-label={toast.dismissible ? 'Dismiss notification' : 'Close'}
				>
					<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
				</button>
			</div>

			{/* Progress bar — hidden for dismissible (sticky) toasts */}
			{!toast.dismissible && toast.duration && toast.duration > 0 && (
				<div
					className="absolute bottom-0 left-0 h-1 rounded-b-lg transition-all ease-linear"
					style={{
						backgroundColor: getTypeColor(),
						width: '100%',
						animation: `shrink ${toast.duration}ms linear forwards`,
					}}
				/>
			)}

			<style>{`
        @keyframes shrink {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>
		</div>
	);
});

export const ToastContainer = memo(function ToastContainer({
	theme,
	onSessionClick,
}: ToastContainerProps) {
	const toasts = useNotificationStore((s) => s.toasts);
	const removeToast = useNotificationStore((s) => s.removeToast);

	if (toasts.length === 0) return null;

	return createPortal(
		<div
			className="fixed bottom-4 right-4 flex flex-col-reverse"
			style={{ pointerEvents: 'none', zIndex: 100000 }}
		>
			<div style={{ pointerEvents: 'auto' }}>
				{toasts.map((toast) => (
					<ToastItem
						key={toast.id}
						toast={toast}
						theme={theme}
						onRemove={removeToast}
						onSessionClick={onSessionClick}
					/>
				))}
			</div>
		</div>,
		document.body
	);
});
