/**
 * GitDiffViewer component for Maestro mobile web interface
 *
 * Displays a unified diff with line-by-line coloring, line numbers parsed
 * from @@ hunks, and horizontal scroll for long lines.
 */

import { useMemo } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';

export interface GitDiffViewerProps {
	diff: string;
	filePath: string;
	onBack: () => void;
}

interface DiffLine {
	content: string;
	type: 'add' | 'remove' | 'hunk' | 'context';
	oldNum: string;
	newNum: string;
}

/**
 * Parse a unified diff string into typed lines with line numbers.
 */
function parseDiffLines(diff: string): DiffLine[] {
	const rawLines = diff.split('\n');
	const result: DiffLine[] = [];

	let oldLine = 0;
	let newLine = 0;

	for (const line of rawLines) {
		if (line.startsWith('@@')) {
			// Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
			const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (match) {
				oldLine = parseInt(match[1], 10);
				newLine = parseInt(match[2], 10);
			}
			result.push({ content: line, type: 'hunk', oldNum: '', newNum: '' });
		} else if (line.startsWith('+')) {
			result.push({ content: line, type: 'add', oldNum: '', newNum: String(newLine) });
			newLine++;
		} else if (line.startsWith('-')) {
			result.push({ content: line, type: 'remove', oldNum: String(oldLine), newNum: '' });
			oldLine++;
		} else {
			// Context line (or diff header lines before first hunk)
			const isBeforeFirstHunk = oldLine === 0 && newLine === 0;
			if (isBeforeFirstHunk) {
				result.push({ content: line, type: 'context', oldNum: '', newNum: '' });
			} else {
				result.push({
					content: line,
					type: 'context',
					oldNum: String(oldLine),
					newNum: String(newLine),
				});
				oldLine++;
				newLine++;
			}
		}
	}

	return result;
}

export function GitDiffViewer({ diff, filePath, onBack }: GitDiffViewerProps) {
	const colors = useThemeColors();
	const lines = useMemo(() => parseDiffLines(diff), [diff]);

	// Determine max line number width for gutter sizing
	const maxNumWidth = useMemo(() => {
		let max = 0;
		for (const line of lines) {
			const oldLen = line.oldNum.length;
			const newLen = line.newNum.length;
			if (oldLen > max) max = oldLen;
			if (newLen > max) max = newLen;
		}
		return Math.max(max, 1);
	}, [lines]);

	const gutterWidth = `${maxNumWidth}ch`;

	function lineBackground(type: DiffLine['type']): string {
		switch (type) {
			case 'add':
				return `${colors.success}26`;
			case 'remove':
				return `${colors.error}26`;
			case 'hunk':
				return `${colors.accent}1a`;
			default:
				return 'transparent';
		}
	}

	function lineColor(type: DiffLine['type']): string {
		switch (type) {
			case 'hunk':
				return colors.accent;
			default:
				return colors.textMain;
		}
	}

	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				height: '100%',
				backgroundColor: colors.bgMain,
			}}
		>
			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					padding: '10px 12px',
					borderBottom: `1px solid ${colors.border}`,
					backgroundColor: colors.bgSidebar,
					flexShrink: 0,
				}}
			>
				<button
					onClick={() => {
						triggerHaptic(HAPTIC_PATTERNS.tap);
						onBack();
					}}
					style={{
						width: '36px',
						height: '36px',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						borderRadius: '8px',
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgMain,
						color: colors.textMain,
						cursor: 'pointer',
						touchAction: 'manipulation',
						WebkitTapHighlightColor: 'transparent',
						flexShrink: 0,
					}}
					aria-label="Back"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<polyline points="15 18 9 12 15 6" />
					</svg>
				</button>

				<span
					style={{
						fontSize: '13px',
						fontWeight: 600,
						color: colors.textMain,
						fontFamily: 'monospace',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
						flex: 1,
					}}
				>
					{filePath}
				</span>
			</div>

			{/* Diff content */}
			<div
				style={{
					flex: 1,
					overflow: 'auto',
					WebkitOverflowScrolling: 'touch',
				}}
			>
				{diff.trim() === '' ? (
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							padding: '40px 16px',
							color: colors.textDim,
							fontSize: '14px',
						}}
					>
						No diff available
					</div>
				) : (
					<pre
						style={{
							margin: 0,
							padding: 0,
							fontFamily: 'monospace',
							fontSize: '12px',
							lineHeight: '1.5',
							whiteSpace: 'pre',
						}}
					>
						{lines.map((line, i) => (
							<div
								key={i}
								style={{
									display: 'flex',
									backgroundColor: lineBackground(line.type),
									color: lineColor(line.type),
									minWidth: 'fit-content',
								}}
							>
								{/* Line number gutter */}
								<span
									style={{
										display: 'inline-block',
										width: gutterWidth,
										textAlign: 'right',
										padding: '0 4px',
										color: colors.textDim,
										userSelect: 'none',
										flexShrink: 0,
										borderRight: `1px solid ${colors.border}`,
										opacity: 0.6,
									}}
								>
									{line.oldNum}
								</span>
								<span
									style={{
										display: 'inline-block',
										width: gutterWidth,
										textAlign: 'right',
										padding: '0 4px',
										color: colors.textDim,
										userSelect: 'none',
										flexShrink: 0,
										borderRight: `1px solid ${colors.border}`,
										opacity: 0.6,
									}}
								>
									{line.newNum}
								</span>

								{/* Line content */}
								<span style={{ padding: '0 8px', flex: 1 }}>{line.content}</span>
							</div>
						))}
					</pre>
				)}
			</div>
		</div>
	);
}

export default GitDiffViewer;
