// Custom kill-confirmation dialog. We do NOT compose ConfirmModal here because
// ConfirmModal does not expose the "Killing…" spinner state we render on the confirm
// button while the IPC dispatch is in flight. Migrating to ConfirmModal is a separate,
// larger UX change and out of scope for the ProcessMonitor decomposition.
//
// Escape is owned by the layer stack (registers at MODAL_PRIORITIES.CONFIRM, which is
// higher than PROCESS_MONITOR's 550) so the dialog's Escape always wins over the
// underlying ProcessMonitor handler - per the CLAUDE.md convention "register with
// layer stack - don't handle Escape locally".
import { useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Theme } from '../../types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

export interface KillConfirmDialogProps {
	theme: Theme;
	isKilling: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function KillConfirmDialog({
	theme,
	isKilling,
	onConfirm,
	onCancel,
}: KillConfirmDialogProps) {
	const dialogRef = useRef<HTMLDivElement>(null);

	useModalLayer(MODAL_PRIORITIES.CONFIRM, 'Kill Process', onCancel);

	useEffect(() => {
		dialogRef.current?.focus();
	}, []);

	return (
		<div
			className="fixed inset-0 flex items-center justify-center z-[10000]"
			style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
			onClick={onCancel}
		>
			<div
				ref={dialogRef}
				className="p-4 rounded-lg shadow-xl max-w-md mx-4 outline-none"
				style={{ backgroundColor: theme.colors.bgMain }}
				onClick={(e) => e.stopPropagation()}
				tabIndex={-1}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !isKilling) {
						e.preventDefault();
						onConfirm();
					}
				}}
			>
				<h3 className="text-lg font-semibold mb-2" style={{ color: theme.colors.textMain }}>
					Kill Process?
				</h3>
				<p className="text-sm mb-4" style={{ color: theme.colors.textDim }}>
					This will forcefully terminate the process. Any unsaved work may be lost.
				</p>
				<div className="flex gap-2 justify-end">
					<button
						onClick={onCancel}
						className="px-3 py-1.5 rounded text-sm"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
						disabled={isKilling}
					>
						Cancel
					</button>
					<button
						onClick={onConfirm}
						className="px-3 py-1.5 rounded text-sm flex items-center gap-2"
						style={{ backgroundColor: theme.colors.error, color: 'white' }}
						disabled={isKilling}
					>
						{isKilling ? (
							<>
								<RefreshCw className="w-3 h-3 animate-spin" />
								Killing...
							</>
						) : (
							'Kill Process'
						)}
					</button>
				</div>
			</div>
		</div>
	);
}
