/**
 * PatternPreviewModal - Shows pattern YAML with explanation and copy button.
 */

import { useCallback } from 'react';
import { Copy } from 'lucide-react';
import type { CuePattern } from '../../constants/cuePatterns';
import { Modal } from '../ui/Modal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import { safeClipboardWrite } from '../../utils/clipboard';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';
import type { Theme } from '../../types';

interface PatternPreviewModalProps {
	pattern: CuePattern;
	theme: Theme;
	onClose: () => void;
}

export function PatternPreviewModal({ pattern, theme, onClose }: PatternPreviewModalProps) {
	const handleCopy = useCallback(async () => {
		// The shared clipboard flash is the one acknowledgment for a copy; a
		// hand-rolled "Copied" state and timer is what it exists to replace.
		// Non-fatal when the clipboard is unavailable: nothing flashes.
		if (await safeClipboardWrite(pattern.yaml)) {
			flashCopiedToClipboard(undefined, 'Pattern YAML Copied');
		}
	}, [pattern.yaml]);

	return (
		<Modal
			theme={theme}
			title={pattern.name}
			priority={MODAL_PRIORITIES.CUE_PATTERN_PREVIEW}
			onClose={onClose}
			width={560}
			maxHeight="70vh"
			closeOnBackdropClick={true}
			testId="cue-pattern-preview"
			footer={
				<div className="flex justify-end w-full">
					<button
						onClick={handleCopy}
						className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors"
						style={{
							backgroundColor: CUE_COLOR,
							color: theme.colors.accentForeground,
						}}
					>
						<Copy className="w-3.5 h-3.5" />
						Copy to Clipboard
					</button>
				</div>
			}
		>
			{/* Explanation */}
			<p className="text-xs leading-relaxed mb-3" style={{ color: theme.colors.textDim }}>
				{pattern.explanation}
			</p>

			{/* YAML preview */}
			<pre
				className="rounded border p-3 text-xs font-mono whitespace-pre-wrap overflow-x-auto"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
			>
				{pattern.yaml}
			</pre>
		</Modal>
	);
}
