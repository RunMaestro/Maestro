/**
 * Pre-enable permission review for a first-party (built-in) feature.
 *
 * First-party features are trusted host code, so enabling them mints their
 * declared grants server-side via the lifecycle bridge without the
 * community-plugin consent window. Those grants are still real (file watches,
 * network polling, transcript reads…), so we surface them for review BEFORE
 * minting: this modal is the gate. Confirm commits the enable through the
 * bridge; cancel leaves the flag and the bridge untouched.
 *
 * The capability rows come from the shared PermissionList, so this modal and
 * the tile's Permissions sub-tab render identically.
 */

import { ShieldCheck } from 'lucide-react';
import type { Theme } from '../../../types';
import type { PermissionRequest } from '../../../../shared/plugins/permissions';
import { Modal } from '../../ui/Modal';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { PermissionList } from './PermissionList';

interface FirstPartyEnableModalProps {
	theme: Theme;
	/** Display name of the feature being enabled (e.g. "Maestro Cue"). */
	name: string;
	/** The feature's declared capabilities, minted on confirm. */
	permissions: readonly PermissionRequest[];
	/** Commit the enable (routes through the lifecycle bridge). */
	onConfirm: () => void;
	/** Abort without touching the flag or minting grants. */
	onCancel: () => void;
}

export function FirstPartyEnableModal({
	theme,
	name,
	permissions,
	onConfirm,
	onCancel,
}: FirstPartyEnableModalProps) {
	return (
		<Modal
			theme={theme}
			title={`Enable ${name}`}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={onCancel}
			testId="first-party-enable-modal"
			headerIcon={<ShieldCheck className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			width={460}
			closeOnBackdropClick
			footer={
				<>
					<button
						type="button"
						data-testid="first-party-enable-cancel"
						onClick={onCancel}
						className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						Cancel
					</button>
					<button
						type="button"
						data-testid="first-party-enable-confirm"
						onClick={onConfirm}
						className="px-4 py-2 rounded transition-colors"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
					>
						Enable {name}
					</button>
				</>
			}
		>
			<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
				{name} is a built-in Maestro feature. Enabling it grants the following capabilities to
				first-party code:
			</p>
			{permissions.length > 0 ? (
				<PermissionList theme={theme} permissions={permissions} statusLabel="Will be granted" />
			) : (
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					This feature requests no special capabilities.
				</p>
			)}
		</Modal>
	);
}
