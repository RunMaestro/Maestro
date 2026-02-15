/**
 * AccountSwitchModal - Confirmation modal for prompted account switches
 *
 * Appears when `promptBeforeSwitch` is true and a throttle/limit event triggers
 * an account switch suggestion. Shows current account status, recommended switch
 * target, and action buttons to confirm, dismiss, or view the dashboard.
 */

import React from 'react';
import { AlertTriangle, ArrowRightLeft, BarChart3 } from 'lucide-react';
import type { Theme } from '../types';
import { Modal } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

export interface AccountSwitchModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	switchData: {
		sessionId: string;
		fromAccountId: string;
		fromAccountName: string;
		toAccountId: string;
		toAccountName: string;
		reason: string;
		tokensAtThrottle?: number;
		usagePercent?: number;
	};
	onConfirmSwitch: () => void;
	onConfirmSwitchAndResume?: () => void;
	onViewDashboard: () => void;
}

function getReasonHeader(reason: string): string {
	switch (reason) {
		case 'throttled':
			return 'Account Throttled';
		case 'limit-approaching':
		case 'limit-reached':
			return 'Account Limit Reached';
		case 'auth-expired':
			return 'Authentication Expired';
		default:
			return 'Account Switch Recommended';
	}
}

function getReasonDescription(reason: string, name: string, usagePercent?: number): string {
	switch (reason) {
		case 'throttled':
			return `Account ${name} has been rate limited`;
		case 'limit-approaching':
			return `Account ${name} is at ${usagePercent != null ? Math.round(usagePercent) : '?'}% of its token limit`;
		case 'limit-reached':
			return `Account ${name} has reached its token limit (${usagePercent != null ? Math.round(usagePercent) : '?'}%)`;
		case 'auth-expired':
			return `Account ${name} authentication has expired`;
		default:
			return `Account ${name} needs to be switched`;
	}
}

function getStatusColor(reason: string, theme: Theme): string {
	switch (reason) {
		case 'throttled':
			return theme.colors.warning;
		case 'limit-approaching':
			return theme.colors.warning;
		case 'limit-reached':
		case 'auth-expired':
			return theme.colors.error;
		default:
			return theme.colors.textDim;
	}
}

export function AccountSwitchModal({
	theme,
	isOpen,
	onClose,
	switchData,
	onConfirmSwitch,
	onConfirmSwitchAndResume,
	onViewDashboard,
}: AccountSwitchModalProps) {
	if (!isOpen) return null;

	const { fromAccountName, toAccountName, reason, usagePercent } = switchData;

	return (
		<Modal
			theme={theme}
			title={getReasonHeader(reason)}
			priority={MODAL_PRIORITIES.ACCOUNT_SWITCH}
			onClose={onClose}
			headerIcon={<AlertTriangle className="w-4 h-4" style={{ color: getStatusColor(reason, theme) }} />}
			width={440}
			closeOnBackdropClick
			footer={
				<div className="flex items-center gap-2 w-full">
					<button
						type="button"
						onClick={onViewDashboard}
						className="flex items-center gap-1.5 px-3 py-2 rounded text-xs transition-colors hover:bg-white/5"
						style={{ color: theme.colors.textDim }}
						title="View All Accounts"
					>
						<BarChart3 className="w-3.5 h-3.5" />
						View All Accounts
					</button>
					<div className="flex-1" />
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 rounded border text-xs transition-colors hover:bg-white/5"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							backgroundColor: theme.colors.bgActivity,
						}}
					>
						Stay on Current
					</button>
					{onConfirmSwitchAndResume && (
						<button
							type="button"
							onClick={onConfirmSwitchAndResume}
							className="px-4 py-2 rounded text-xs transition-colors hover:opacity-90"
							style={{
								backgroundColor: `${theme.colors.accent}cc`,
								color: theme.colors.accentForeground,
							}}
						>
							Switch &amp; Resume
						</button>
					)}
					<button
						type="button"
						onClick={onConfirmSwitch}
						className="px-4 py-2 rounded text-xs transition-colors hover:opacity-90"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						Switch Account
					</button>
				</div>
			}
		>
			<div className="flex flex-col gap-4">
				{/* Reason explanation */}
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					{getReasonDescription(reason, fromAccountName, usagePercent)}
				</p>

				{/* Current account */}
				<div
					className="flex items-center gap-3 p-3 rounded-lg border"
					style={{
						borderColor: getStatusColor(reason, theme),
						backgroundColor: `${getStatusColor(reason, theme)}10`,
					}}
				>
					<div
						className="w-2 h-2 rounded-full shrink-0"
						style={{ backgroundColor: getStatusColor(reason, theme) }}
					/>
					<div className="flex-1 min-w-0">
						<div className="text-xs font-medium truncate" style={{ color: theme.colors.textMain }}>
							{fromAccountName}
						</div>
						<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
							Current account
							{usagePercent != null && ` \u00B7 ${Math.round(usagePercent)}% used`}
						</div>
					</div>
				</div>

				{/* Arrow */}
				<div className="flex justify-center">
					<ArrowRightLeft className="w-4 h-4" style={{ color: theme.colors.textDim }} />
				</div>

				{/* Recommended account */}
				<div
					className="flex items-center gap-3 p-3 rounded-lg border"
					style={{
						borderColor: theme.colors.success,
						backgroundColor: `${theme.colors.success}10`,
					}}
				>
					<div
						className="w-2 h-2 rounded-full shrink-0"
						style={{ backgroundColor: theme.colors.success }}
					/>
					<div className="flex-1 min-w-0">
						<div className="text-xs font-medium truncate" style={{ color: theme.colors.textMain }}>
							{toAccountName}
						</div>
						<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
							Recommended switch target
						</div>
					</div>
				</div>
			</div>
		</Modal>
	);
}
