/**
 * AccountSelector - Dropdown for manual account selection per session
 *
 * Compact mode: shows a small icon/badge for tight spaces (InputArea footer).
 * Full mode: shows the current account name with a dropdown.
 *
 * Lists all active accounts with status dots, usage bars, and a "Manage Accounts" link.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { User, ChevronDown, Settings } from 'lucide-react';
import type { Theme } from '../types';
import type { AccountProfile } from '../../shared/account-types';

export interface AccountSelectorProps {
	theme: Theme;
	sessionId: string;
	currentAccountId?: string;
	onSwitchAccount: (toAccountId: string) => void;
	onManageAccounts?: () => void;
	compact?: boolean;
}

function getStatusColor(status: string, theme: Theme): string {
	switch (status) {
		case 'active':
			return theme.colors.success;
		case 'throttled':
			return theme.colors.warning;
		case 'expired':
		case 'disabled':
			return theme.colors.error;
		default:
			return theme.colors.textDim;
	}
}

export function AccountSelector({
	theme,
	sessionId: _sessionId,
	currentAccountId,
	onSwitchAccount,
	onManageAccounts,
	compact = false,
}: AccountSelectorProps) {
	const [accounts, setAccounts] = useState<AccountProfile[]>([]);
	const [isOpen, setIsOpen] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);

	// Fetch accounts when dropdown opens
	useEffect(() => {
		if (!isOpen) return;
		let cancelled = false;
		(async () => {
			try {
				const list = (await window.maestro.accounts.list()) as AccountProfile[];
				if (!cancelled) setAccounts(list);
			} catch {
				// Silently fail - dropdown will show empty
			}
		})();
		return () => { cancelled = true; };
	}, [isOpen]);

	// Close dropdown on outside click
	useEffect(() => {
		if (!isOpen) return;
		const handleClick = (e: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				setIsOpen(false);
			}
		};
		document.addEventListener('mousedown', handleClick);
		return () => document.removeEventListener('mousedown', handleClick);
	}, [isOpen]);

	// Close on Escape
	useEffect(() => {
		if (!isOpen) return;
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				setIsOpen(false);
			}
		};
		document.addEventListener('keydown', handleKey, true);
		return () => document.removeEventListener('keydown', handleKey, true);
	}, [isOpen]);

	const currentAccount = accounts.find((a) => a.id === currentAccountId);
	const displayName = currentAccount?.name ?? currentAccount?.email ?? 'No Account';

	const handleSelect = useCallback(
		(accountId: string) => {
			if (accountId !== currentAccountId) {
				onSwitchAccount(accountId);
			}
			setIsOpen(false);
		},
		[currentAccountId, onSwitchAccount]
	);

	return (
		<div className="relative" ref={dropdownRef}>
			{/* Trigger button */}
			{compact ? (
				<button
					type="button"
					onClick={() => setIsOpen((v) => !v)}
					className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all opacity-50 hover:opacity-100"
					style={{
						color: currentAccountId ? theme.colors.accent : theme.colors.textDim,
						backgroundColor: currentAccountId ? `${theme.colors.accent}15` : 'transparent',
						border: currentAccountId
							? `1px solid ${theme.colors.accent}40`
							: '1px solid transparent',
					}}
					title={currentAccountId ? `Account: ${displayName}` : 'Select account'}
				>
					<User className="w-3 h-3" />
					{currentAccountId && (
						<span className="max-w-[80px] truncate">{displayName.split('@')[0]}</span>
					)}
				</button>
			) : (
				<button
					type="button"
					onClick={() => setIsOpen((v) => !v)}
					className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border transition-colors hover:bg-white/5"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
						backgroundColor: theme.colors.bgMain,
					}}
				>
					<User className="w-3.5 h-3.5" />
					<span className="max-w-[120px] truncate">{displayName}</span>
					<ChevronDown className="w-3 h-3" style={{ color: theme.colors.textDim }} />
				</button>
			)}

			{/* Dropdown */}
			{isOpen && (
				<div
					className="absolute bottom-full mb-1 left-0 rounded-lg border shadow-xl overflow-hidden z-50"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.border,
						minWidth: '200px',
						maxWidth: '260px',
					}}
				>
					<div className="py-1 max-h-[240px] overflow-y-auto">
						{accounts.length === 0 && (
							<div className="px-3 py-2 text-xs" style={{ color: theme.colors.textDim }}>
								No accounts configured
							</div>
						)}
						{accounts.map((account) => {
							const isCurrent = account.id === currentAccountId;
							const statusColor = getStatusColor(account.status, theme);
							return (
								<button
									key={account.id}
									type="button"
									onClick={() => handleSelect(account.id)}
									className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-white/5"
									style={{
										backgroundColor: isCurrent ? `${theme.colors.accent}10` : undefined,
									}}
								>
									{/* Status dot */}
									<div
										className="w-2 h-2 rounded-full shrink-0"
										style={{ backgroundColor: statusColor }}
										title={account.status}
									/>
									{/* Account info */}
									<div className="flex-1 min-w-0">
										<div
											className="text-xs truncate"
											style={{
												color: isCurrent ? theme.colors.accent : theme.colors.textMain,
												fontWeight: isCurrent ? 600 : 400,
											}}
										>
											{account.name || account.email}
										</div>
										{/* Usage bar if limit configured */}
										{account.tokenLimitPerWindow > 0 && (
											<div
												className="mt-1 h-1 rounded-full overflow-hidden"
												style={{ backgroundColor: `${theme.colors.border}80` }}
											>
												<div
													className="h-full rounded-full transition-all"
													style={{
														width: '0%', // Usage percent would be populated by real-time data
														backgroundColor: statusColor,
													}}
												/>
											</div>
										)}
									</div>
									{/* Current indicator */}
									{isCurrent && (
										<span
											className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0"
											style={{
												backgroundColor: `${theme.colors.accent}20`,
												color: theme.colors.accent,
											}}
										>
											active
										</span>
									)}
								</button>
							);
						})}
					</div>
					{/* Manage Accounts link */}
					{onManageAccounts && (
						<div
							className="border-t"
							style={{ borderColor: theme.colors.border }}
						>
							<button
								type="button"
								onClick={() => {
									setIsOpen(false);
									onManageAccounts();
								}}
								className="w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-white/5"
								style={{ color: theme.colors.textDim }}
							>
								<Settings className="w-3 h-3" />
								Manage Accounts
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
