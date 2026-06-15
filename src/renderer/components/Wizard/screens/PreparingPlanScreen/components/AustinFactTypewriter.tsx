import { useEffect, useState } from 'react';
import type { Theme } from '../../../../../types';
import {
	getNextAustinFact,
	parseFactWithLinks,
	type FactSegment,
} from '../../../services/austinFacts';
import { getFactPlainText } from '../utils/austinFacts';
import { TexasFlag } from './TexasFlag';

function FactContent({
	segments,
	displayLength,
	theme,
}: {
	segments: FactSegment[];
	displayLength: number;
	theme: Theme;
}): JSX.Element {
	let charCount = 0;
	const elements: JSX.Element[] = [];

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];

		if (segment.type === 'text') {
			const segmentLength = segment.content.length;
			const startChar = charCount;
			const endChar = charCount + segmentLength;

			if (displayLength > startChar) {
				const visibleChars = Math.min(displayLength - startChar, segmentLength);
				elements.push(<span key={i}>{segment.content.slice(0, visibleChars)}</span>);
			}
			charCount = endChar;
		} else if (segment.type === 'link') {
			const segmentLength = segment.text.length;
			const startChar = charCount;
			const endChar = charCount + segmentLength;

			if (displayLength > startChar) {
				const visibleChars = Math.min(displayLength - startChar, segmentLength);
				const isFullyVisible = visibleChars === segmentLength;

				if (isFullyVisible) {
					elements.push(
						<a
							key={i}
							href={segment.url}
							onClick={(e) => {
								e.preventDefault();
								if (!window.maestro?.shell?.openExternal?.(segment.url)) {
									window.open(segment.url, '_blank');
								}
							}}
							className="underline hover:opacity-80 cursor-pointer transition-opacity"
							style={{ color: theme.colors.accent }}
						>
							{segment.text}
						</a>
					);
				} else {
					elements.push(
						<span key={i} style={{ color: theme.colors.accent }}>
							{segment.text.slice(0, visibleChars)}
						</span>
					);
				}
			}
			charCount = endChar;
		}
	}

	return <>{elements}</>;
}

export function AustinFactTypewriter({ theme }: { theme: Theme }): JSX.Element {
	const [currentFact, setCurrentFact] = useState(() => getNextAustinFact());
	const [displayLength, setDisplayLength] = useState(0);
	const [isTypingComplete, setIsTypingComplete] = useState(false);

	const segments = parseFactWithLinks(currentFact);
	const plainText = getFactPlainText(currentFact);

	useEffect(() => {
		let currentIndex = 0;
		setDisplayLength(0);
		setIsTypingComplete(false);

		const typeInterval = setInterval(() => {
			if (currentIndex < plainText.length) {
				currentIndex++;
				setDisplayLength(currentIndex);
			} else {
				setIsTypingComplete(true);
				clearInterval(typeInterval);
			}
		}, 25);

		return () => clearInterval(typeInterval);
	}, [currentFact, plainText.length]);

	useEffect(() => {
		if (!isTypingComplete) return;

		const rotateTimer = setTimeout(() => {
			setCurrentFact(getNextAustinFact());
		}, 20000);

		return () => clearTimeout(rotateTimer);
	}, [isTypingComplete]);

	return (
		<div
			className="mt-8 mx-auto px-4 py-4 rounded-lg"
			style={{
				backgroundColor: `${theme.colors.accent}10`,
				border: `1px solid ${theme.colors.accent}30`,
				width: '600px',
				maxWidth: '100%',
			}}
		>
			<div className="flex items-center gap-4">
				<TexasFlag className="w-10 h-7 shrink-0" style={{ opacity: 0.85 }} />
				<div className="flex-1 min-w-0">
					<p
						className="text-xs font-medium uppercase tracking-wide mb-1"
						style={{ color: theme.colors.accent }}
					>
						Austin Facts
					</p>
					<p
						className="text-sm leading-relaxed"
						style={{ color: theme.colors.textMain, minHeight: '3em' }}
					>
						<FactContent segments={segments} displayLength={displayLength} theme={theme} />
						{!isTypingComplete && (
							<span
								className="inline-block w-0.5 h-4 ml-0.5 animate-pulse"
								style={{ backgroundColor: theme.colors.accent }}
							/>
						)}
					</p>
				</div>
			</div>
		</div>
	);
}
