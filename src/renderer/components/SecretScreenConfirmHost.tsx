/**
 * Draws the front of the secret-screen queue as a confirm dialog: the masked
 * findings, "Publish anyway", and "Cancel". Mounted once in `AppShell`; opened
 * through `withSecretScreenConfirm()` (services/secretScreen.ts), never
 * directly.
 *
 * Cancel and close both settle false, so a dismissed dialog never leaves a
 * publish hanging. It sits above the modals that raise it (Publish Gist and
 * Feedback are at 10000).
 */

import { ShieldAlert } from 'lucide-react';
import { ConfirmModal } from './ConfirmModal';
import type { Theme } from '../types';
import { useSecretScreenStore } from '../stores/secretScreenStore';
import { describeSecretFinding } from '../../shared/secretScan';

const SECRET_SCREEN_Z_INDEX = 10050;

export function SecretScreenConfirmHost({ theme }: { theme: Theme }) {
	const front = useSecretScreenStore((s) => s.queue[0]);
	const settle = useSecretScreenStore((s) => s.settle);
	if (!front) return null;

	const count = front.findings.length;
	return (
		<ConfirmModal
			theme={theme}
			title="Possible Secrets Found"
			message={`${front.subject.charAt(0).toUpperCase()}${front.subject.slice(1)} contains ${
				count === 1 ? 'what looks like a secret' : `${count} things that look like secrets`
			}. Nothing has been sent.`}
			headerIcon={<ShieldAlert className="w-4 h-4" style={{ color: theme.colors.error }} />}
			icon={<ShieldAlert className="w-5 h-5" style={{ color: theme.colors.error }} />}
			destructive
			confirmLabel={front.confirmLabel}
			width={540}
			zIndex={SECRET_SCREEN_Z_INDEX}
			onConfirm={() => settle(front.id, true)}
			onClose={() => settle(front.id, false)}
		>
			<ul
				className="max-h-56 overflow-y-auto rounded border px-3 py-2 space-y-1 text-xs font-mono select-text"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgActivity,
					color: theme.colors.textMain,
				}}
				data-testid="secret-screen-findings"
			>
				{front.findings.map((finding, index) => (
					<li key={index} className="break-all">
						{describeSecretFinding(finding)}
					</li>
				))}
			</ul>
			<p className="text-xs" style={{ color: theme.colors.textDim }}>
				Values are masked here. Cancel to remove them first.
			</p>
			{front.note && (
				<p className="text-xs" style={{ color: theme.colors.warning }}>
					{front.note}
				</p>
			)}
		</ConfirmModal>
	);
}
