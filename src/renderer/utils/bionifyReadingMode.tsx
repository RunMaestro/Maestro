import {
	Children,
	cloneElement,
	forwardRef,
	isValidElement,
	type CSSProperties,
	type ForwardedRef,
	type HTMLAttributes,
	type ReactNode,
} from 'react';
import type { Theme } from '../types';

const BIONIFY_WORD_PATTERN = /(\p{L}[\p{L}\p{M}'’-]*)/gu;
const BIONIFY_SKIPPED_TAGS = new Set([
	'a',
	'button',
	'code',
	'img',
	'input',
	'kbd',
	'option',
	'pre',
	'samp',
	'select',
	'svg',
	'textarea',
]);
const DEFAULT_BIONIFY_SCOPE_SELECTOR = '.bionify-text-block';
const DEFAULT_BIONIFY_REST_OPACITY = 0.96;
const BIONIFY_STYLE_ID = 'maestro-bionify-reading-mode-styles';
let hasInjectedBionifyStyles = false;

function resolveBionifyRestOpacity(theme?: Theme): number {
	return theme?.mode === 'light' ? 0.9 : DEFAULT_BIONIFY_REST_OPACITY;
}

function ensureBionifyStylesInjected(): void {
	if (hasInjectedBionifyStyles || typeof document === 'undefined') {
		return;
	}

	if (document.getElementById(BIONIFY_STYLE_ID)) {
		hasInjectedBionifyStyles = true;
		return;
	}

	const style = document.createElement('style');
	style.id = BIONIFY_STYLE_ID;
	style.textContent = getBionifyReadingModeStyles();
	document.head.appendChild(style);
	hasInjectedBionifyStyles = true;
}

function getEmphasisLength(word: string): number {
	if (word.length <= 3) return 1;
	if (word.length <= 6) return 2;
	if (word.length <= 9) return 3;
	return 4;
}

function renderBionifyWord(word: string, key: string): ReactNode {
	const emphasisLength = Math.min(getEmphasisLength(word), word.length);
	const emphasis = word.slice(0, emphasisLength);
	const rest = word.slice(emphasisLength);

	return (
		<span key={key} className="bionify-word">
			<span className="bionify-word-emphasis">{emphasis}</span>
			{rest ? <span className="bionify-word-rest">{rest}</span> : null}
		</span>
	);
}

export function renderBionifyText(content: string, enabled: boolean): ReactNode {
	if (!enabled || !content) {
		return content;
	}

	const parts: ReactNode[] = [];
	let lastIndex = 0;

	for (const match of content.matchAll(BIONIFY_WORD_PATTERN)) {
		const index = match.index ?? 0;
		const word = match[0];

		if (index > lastIndex) {
			parts.push(content.slice(lastIndex, index));
		}

		parts.push(renderBionifyWord(word, `bionify-${index}`));
		lastIndex = index + word.length;
	}

	if (parts.length === 0) {
		return content;
	}

	if (lastIndex < content.length) {
		parts.push(content.slice(lastIndex));
	}

	return parts;
}

function transformBionifyNode(node: ReactNode, enabled: boolean, index: number): ReactNode {
	if (typeof node === 'string') {
		return renderBionifyText(node, enabled);
	}

	if (!isValidElement(node)) {
		return node;
	}

	const nodeProps = node.props as { children?: ReactNode; node?: { tagName?: string } };
	const tagName = typeof node.type === 'string' ? node.type : nodeProps.node?.tagName;
	if (tagName && BIONIFY_SKIPPED_TAGS.has(tagName)) {
		return node;
	}

	const children = nodeProps.children;
	if (children === undefined) {
		return node;
	}

	return cloneElement(node, { key: node.key ?? index }, renderBionifyChildren(children, enabled));
}

export function renderBionifyChildren(children: ReactNode, enabled: boolean): ReactNode {
	if (!enabled) {
		return children;
	}

	return Children.map(children, (child, index) => transformBionifyNode(child, enabled, index));
}

export function getBionifyReadingModeStyles(
	scopeSelector: string = DEFAULT_BIONIFY_SCOPE_SELECTOR,
	theme?: Theme
): string {
	const restOpacity = theme
		? String(resolveBionifyRestOpacity(theme))
		: `var(--bionify-rest-opacity, ${DEFAULT_BIONIFY_REST_OPACITY})`;

	return `
		${scopeSelector} .bionify-word { display: inline; color: inherit; }
		${scopeSelector} .bionify-word-emphasis { font-weight: 600; color: inherit; }
		${scopeSelector} .bionify-word-rest { font-weight: 400; color: inherit; opacity: ${restOpacity}; }
	`;
}

interface BionifyTextProps {
	children: ReactNode;
	enabled: boolean;
}

export function BionifyText({ children, enabled }: BionifyTextProps) {
	return <>{renderBionifyChildren(children, enabled)}</>;
}

interface BionifyTextBlockProps extends HTMLAttributes<HTMLDivElement> {
	enabled: boolean;
	children: ReactNode;
	restOpacity?: number;
	style?: CSSProperties;
}

export const BionifyTextBlock = forwardRef<HTMLDivElement, BionifyTextBlockProps>(
	function BionifyTextBlock(
		{ children, enabled, className = '', restOpacity, style, ...props },
		ref: ForwardedRef<HTMLDivElement>
	) {
		ensureBionifyStylesInjected();
		const blockClassName = ['bionify-text-block', className].filter(Boolean).join(' ');
		const blockStyle = {
			...style,
			['--bionify-rest-opacity' as const]: restOpacity ?? DEFAULT_BIONIFY_REST_OPACITY,
		} as CSSProperties;

		return (
			<div ref={ref} className={blockClassName} style={blockStyle} {...props}>
				<BionifyText enabled={enabled}>{children}</BionifyText>
			</div>
		);
	}
);
