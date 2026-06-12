/**
 * PatternPreviewModal — Shows pattern YAML with explanation and copy button.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import type { CuePattern } from '../../constants/cuePatterns';
import { Modal } from '../ui/Modal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import type { Theme } from '../../types';

interface PatternPreviewModalProps {
	pattern: CuePattern;
	theme: Theme;
	onClose: () => void;
}

export function PatternPreviewModal({ pattern, theme, onClose }: PatternPreviewModalProps) {
	const [copied, setCopied] = useState(false);
	const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

	useEffect(() => {
		return () => {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
		};
	}, []);

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(pattern.yaml);
			setCopied(true);
			copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard API may fail in some contexts — non-fatal
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
							backgroundColor: copied ? theme.colors.success : CUE_COLOR,
							color: theme.colors.accentForeground,
						}}
					>
						{copied ? (
							<>
								<Check className="w-3.5 h-3.5" />
								Copied
							</>
						) : (
							<>
								<Copy className="w-3.5 h-3.5" />
								Copy to Clipboard
							</>
						)}
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
