import { memo, useCallback, useMemo, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { BionifyTextBlock } from '../../renderer/utils/bionifyReadingMode';
import { useTheme, useThemeColors } from '../components/ThemeProvider';
import { webLogger } from '../utils/logger';
import { HAPTIC_PATTERNS, triggerHaptic } from './constants';
import { MobileMarkdownRenderer } from './MobileMarkdownRenderer';
import {
	normalizeWebReaderContent,
	type WebReaderContent,
	type WebReaderTextSegment,
} from './readingContent';

export interface WebReadingContentProps {
	content: WebReaderContent;
	enableBionifyReadingMode?: boolean;
	fontSize?: number;
	textColor?: string;
	codeBackgroundColor?: string;
	codeBorderColor?: string;
	codeSuccessColor?: string;
	gap?: string;
	logContext?: string;
}

interface MobileCodeBlockProps {
	segment: WebReaderTextSegment;
	codeBackgroundColor: string;
	codeBorderColor: string;
	codeSuccessColor: string;
	logContext: string;
}

const MobileCodeBlock = memo(
	({
		segment,
		codeBackgroundColor,
		codeBorderColor,
		codeSuccessColor,
		logContext,
	}: MobileCodeBlockProps) => {
		const colors = useThemeColors();
		const { isDark } = useTheme();
		const syntaxStyle = isDark ? vscDarkPlus : vs;
		const [copied, setCopied] = useState(false);
		const displayLanguage =
			segment.language && segment.language !== 'text' ? segment.language : 'code';

		const handleCopy = useCallback(async () => {
			try {
				await navigator.clipboard.writeText(segment.content);
				setCopied(true);
				triggerHaptic(HAPTIC_PATTERNS.success);
				setTimeout(() => setCopied(false), 2000);
			} catch (error) {
				webLogger.error('Failed to copy code', logContext, error);
				triggerHaptic(HAPTIC_PATTERNS.error);
			}
		}, [logContext, segment.content]);

		return (
			<div
				style={{
					borderRadius: '8px',
					overflow: 'hidden',
					border: `1px solid ${codeBorderColor}`,
				}}
			>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						padding: '4px 8px 4px 12px',
						backgroundColor: codeBackgroundColor,
						borderBottom: `1px solid ${codeBorderColor}`,
						minHeight: '28px',
					}}
				>
					<span
						style={{
							fontSize: '11px',
							fontWeight: 500,
							color: colors.textDim,
							textTransform: 'uppercase',
							letterSpacing: '0.5px',
						}}
					>
						{displayLanguage}
					</span>
					<button
						onClick={handleCopy}
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: '4px',
							padding: '4px 8px',
							borderRadius: '4px',
							border: 'none',
							backgroundColor: copied ? `${codeSuccessColor}20` : 'transparent',
							color: copied ? codeSuccessColor : colors.textDim,
							fontSize: '11px',
							fontWeight: 500,
							cursor: 'pointer',
							transition: 'all 0.2s ease',
						}}
						aria-label={copied ? 'Copied!' : 'Copy code'}
					>
						{copied ? (
							<>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<polyline points="20 6 9 17 4 12" />
								</svg>
								Copied
							</>
						) : (
							<>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
									<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
								</svg>
								Copy
							</>
						)}
					</button>
				</div>
				<SyntaxHighlighter
					language={segment.language || 'text'}
					style={syntaxStyle}
					customStyle={{
						margin: 0,
						padding: '12px',
						fontSize: '12px',
						lineHeight: 1.5,
						backgroundColor: codeBackgroundColor,
						borderRadius: 0,
					}}
					wrapLongLines={true}
					showLineNumbers={false}
				>
					{segment.content}
				</SyntaxHighlighter>
			</div>
		);
	}
);

MobileCodeBlock.displayName = 'MobileCodeBlock';

export const WebReadingContent = memo(
	({
		content,
		enableBionifyReadingMode = false,
		fontSize = 13,
		textColor,
		codeBackgroundColor,
		codeBorderColor,
		codeSuccessColor,
		gap = '12px',
		logContext = 'WebReadingContent',
	}: WebReadingContentProps) => {
		const colors = useThemeColors();
		const { isDark } = useTheme();
		const normalizedContent = useMemo(() => normalizeWebReaderContent(content), [content]);

		if (normalizedContent.kind === 'markdown' && normalizedContent.markdown) {
			return (
				<MobileMarkdownRenderer
					content={normalizedContent.markdown}
					fontSize={fontSize}
					enableBionifyReadingMode={enableBionifyReadingMode}
				/>
			);
		}

		return (
			<div
				style={{
					display: 'flex',
					flexDirection: 'column',
					gap,
				}}
			>
				{normalizedContent.segments?.map((segment, index) =>
					segment.type === 'code' ? (
						<MobileCodeBlock
							key={`${segment.type}-${index}`}
							segment={segment}
							codeBackgroundColor={codeBackgroundColor || colors.bgActivity}
							codeBorderColor={codeBorderColor || colors.border}
							codeSuccessColor={codeSuccessColor || colors.success}
							logContext={logContext}
						/>
					) : (
						<BionifyTextBlock
							key={`${segment.type}-${index}`}
							enabled={enableBionifyReadingMode}
							restOpacity={isDark ? 0.96 : 0.9}
							style={{
								fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
								fontSize: `${fontSize}px`,
								lineHeight: 1.6,
								color: textColor || colors.textMain,
								whiteSpace: 'pre-wrap',
								wordBreak: 'break-word',
							}}
						>
							{segment.content}
						</BionifyTextBlock>
					)
				)}
			</div>
		);
	}
);

WebReadingContent.displayName = 'WebReadingContent';

export default WebReadingContent;
