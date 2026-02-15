/**
 * VirtuososModal - Standalone modal for account (Virtuoso) management
 *
 * Wraps AccountsPanel in its own top-level modal, accessible from the
 * hamburger menu. Previously, accounts were nested under Settings.
 */

import React from 'react';
import { Users } from 'lucide-react';
import { AccountsPanel } from './AccountsPanel';
import { Modal } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import type { Theme } from '../types';

interface VirtuososModalProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
}

export function VirtuososModal({ isOpen, onClose, theme }: VirtuososModalProps) {
	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title="Virtuosos"
			priority={MODAL_PRIORITIES.VIRTUOSOS}
			onClose={onClose}
			headerIcon={<Users className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			width={720}
			closeOnBackdropClick
		>
			<div className="mb-1">
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					AI Account Providers
				</p>
			</div>
			<AccountsPanel theme={theme} />
		</Modal>
	);
}
