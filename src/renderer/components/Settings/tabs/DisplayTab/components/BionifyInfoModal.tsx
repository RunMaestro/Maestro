import type { Theme } from '../../../../../types';
import { MODAL_PRIORITIES } from '../../../../../constants/modalPriorities';
import { Modal } from '../../../../ui/Modal';

interface BionifyInfoModalProps {
	theme: Theme;
	onClose: () => void;
}

export function BionifyInfoModal({ theme, onClose }: BionifyInfoModalProps) {
	return (
		<Modal
			theme={theme}
			title="Bionify Algorithm Reference"
			priority={MODAL_PRIORITIES.GROUP_CHAT_INFO}
			onClose={onClose}
			width={520}
			maxHeight="70vh"
			closeOnBackdropClick
		>
			<div className="space-y-4 text-sm" style={{ color: theme.colors.textMain }}>
				<div
					className="rounded border px-3 py-2 font-mono text-sm"
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: theme.colors.border,
					}}
				>
					- 0 1 1 2 0.4
				</div>
				<p style={{ color: theme.colors.textDim }}>
					The first character is `-` or `+`. `-` skips common english words like `a`, `and`, and
					`the`. `+` highlights every word.
				</p>
				<ul className="list-disc pl-5 space-y-2" style={{ color: theme.colors.textDim }}>
					<li>The next four numbers control highlighted characters for words of length 1-4.</li>
					<li>
						The final value is a fraction of each word&apos;s characters to emphasize (for example,
						`0.4` highlights the first 40% of characters in words longer than 4 letters).
					</li>
					<li>
						Current default: `- 0 1 1 2 0.4`, which skips common words and highlights the first 40%
						of longer words.
					</li>
				</ul>
			</div>
		</Modal>
	);
}
