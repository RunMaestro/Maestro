import React, { useEffect, useState } from 'react';
import type { Theme } from '../types';
import { useToast, Toast as ToastType } from '../contexts/ToastContext';

interface ToastContainerProps {
	theme: Theme;
	onSessionClick?: (sessionId: string, tabId?: string) => void;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 && days === 0) parts.push(`${seconds}s`); // Skip seconds when showing days

	return parts.join(' ') || '0s';
}

function ToastItem({
	toast,
	theme,
	onRemove,
	onSessionClick,
}: {
	toast: ToastType;
	theme: Theme;
	onRemove: () => void;
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
		setTimeout(onRemove, 300);
	};

	// Handle click on toast to navigate to session
	const handleToastClick = () => {
		if (toast.sessionId && onSessionClick) {
			onSessionClick(toast.sessionId, toast.tabId);
			handleClose();
		}
	};

	// Check if toast is clickable (has session navigation)
	const isClickable = toast.sessionId && onSessionClick;

	// Icon based on type
	const getIcon = () => {
		switch (toast.type) {
			case 'success':
				return (
					<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
					</svg>
				);
			case 'error':
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
			case 'warning':
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
			default:
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
		}
	};

	const getTypeColor = () => {
		switch (toast.type) {
			case 'success':
				return theme.colors.success;
			case 'error':
				return theme.colors.error;
			case 'warning':
				return theme.colors.warning;
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
								window.maestro.shell.openExternal(toast.actionUrl!);
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

				{/* Close button */}
				<button
					onClick={handleClose}
					className="flex-shrink-0 p-1 rounded hover:bg-opacity-10 transition-colors"
					style={{ color: theme.colors.textDim }}
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

			{/* Progress bar */}
			{toast.duration && toast.duration > 0 && (
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
}

export function ToastContainer({ theme, onSessionClick }: ToastContainerProps) {
	const { toasts, removeToast } = useToast();

	if (toasts.length === 0) return null;

	return (
		<div
			className="fixed bottom-4 right-4 z-50 flex flex-col-reverse"
			style={{ pointerEvents: 'none' }}
		>
			<div style={{ pointerEvents: 'auto' }}>
				{toasts.map((toast) => (
					<ToastItem
						key={toast.id}
						toast={toast}
						theme={theme}
						onRemove={() => removeToast(toast.id)}
						onSessionClick={onSessionClick}
					/>
				))}
			</div>
		</div>
	);
}
