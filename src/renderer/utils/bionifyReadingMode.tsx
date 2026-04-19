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
const BIONIFY_COMMON_WORDS = new Set([
	'a',
	'an',
	'and',
	'as',
	'at',
	'be',
	'by',
	'for',
	'from',
	'if',
	'in',
	'is',
	'it',
	'of',
	'on',
	'or',
	'the',
	'to',
	'with',
]);
const DEFAULT_BIONIFY_SCOPE_SELECTOR = '.bionify-text-block';
const DEFAULT_BIONIFY_REST_OPACITY = 0.65;
const DEFAULT_BIONIFY_INTENSITY = 1;
export const DEFAULT_BIONIFY_ALGORITHM = '- 0 1 1 2 0.4';
const BIONIFY_STYLE_ID = 'maestro-bionify-reading-mode-styles';
let hasInjectedBionifyStyles = false;

interface ParsedBionifyAlgorithm {
	highlightCommonWords: boolean;
	fixedLengths: [number, number, number, number];
	fallbackFraction: number;
}

export interface BionifyRenderConfig {
	enabled: boolean;
	intensity?: number;
	algorithm?: string;
}

const DEFAULT_PARSED_BIONIFY_ALGORITHM: ParsedBionifyAlgorithm = {
	highlightCommonWords: false,
	fixedLengths: [0, 1, 1, 2],
	fallbackFraction: 0.4,
};

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function parseBionifyAlgorithm(algorithm?: string): ParsedBionifyAlgorithm {
	if (!algorithm?.trim()) {
		return DEFAULT_PARSED_BIONIFY_ALGORITHM;
	}

	const parts = algorithm.trim().split(/\s+/);
	if (parts.length !== 6 || !['+', '-'].includes(parts[0])) {
		return DEFAULT_PARSED_BIONIFY_ALGORITHM;
	}

	const fixedLengths = parts.slice(1, 5).map((value) => Number.parseInt(value, 10));
	const fallbackFraction = Number.parseFloat(parts[5]);

	if (
		fixedLengths.some((value) => Number.isNaN(value) || value < 0) ||
		Number.isNaN(fallbackFraction) ||
		fallbackFraction < 0 ||
		fallbackFraction > 1
	) {
		return DEFAULT_PARSED_BIONIFY_ALGORITHM;
	}

	return {
		highlightCommonWords: parts[0] === '+',
		fixedLengths: fixedLengths as ParsedBionifyAlgorithm['fixedLengths'],
		fallbackFraction,
	};
}

function normalizeBionifyConfig(
	config: boolean | BionifyRenderConfig
): Required<BionifyRenderConfig> {
	if (typeof config === 'boolean') {
		return {
			enabled: config,
			intensity: DEFAULT_BIONIFY_INTENSITY,
			algorithm: DEFAULT_BIONIFY_ALGORITHM,
		};
	}

	return {
		enabled: config.enabled,
		intensity: clamp(config.intensity ?? DEFAULT_BIONIFY_INTENSITY, 0.6, 1.5),
		algorithm: config.algorithm?.trim() || DEFAULT_BIONIFY_ALGORITHM,
	};
}

function resolveBionifyRestOpacity(intensity: number, theme?: Theme): number {
	const baseOpacity = theme?.mode === 'light' ? 0.73 : DEFAULT_BIONIFY_REST_OPACITY;
	return Number(clamp(baseOpacity - (intensity - 1), 0.2, 0.9).toFixed(2));
}

function resolveBionifyEmphasisWeight(intensity: number): number {
	return Math.round(clamp(700 + (intensity - 1) * 260, 650, 820));
}

function buildBionifyCssVars(intensity: number, theme?: Theme): CSSProperties {
	return {
		['--bionify-intensity' as const]: String(intensity),
		['--bionify-rest-opacity' as const]: String(resolveBionifyRestOpacity(intensity, theme)),
		['--bionify-emphasis-weight' as const]: String(resolveBionifyEmphasisWeight(intensity)),
	} as CSSProperties;
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

export function resetBionifyStylesForTests(): void {
	hasInjectedBionifyStyles = false;
	if (typeof document !== 'undefined') {
		document.getElementById(BIONIFY_STYLE_ID)?.remove();
	}
}

function getEmphasisLength(word: string, algorithm: ParsedBionifyAlgorithm): number {
	if (!algorithm.highlightCommonWords && BIONIFY_COMMON_WORDS.has(word.toLowerCase())) {
		return 0;
	}

	const directRule = algorithm.fixedLengths[word.length - 1];
	if (directRule !== undefined) {
		return Math.min(directRule, word.length);
	}

	return Math.min(Math.max(1, Math.ceil(word.length * algorithm.fallbackFraction)), word.length);
}

function renderBionifyWord(
	word: string,
	key: string,
	algorithm: ParsedBionifyAlgorithm
): ReactNode {
	const emphasisLength = getEmphasisLength(word, algorithm);
	if (emphasisLength <= 0) {
		return word;
	}

	const emphasis = word.slice(0, emphasisLength);
	const rest = word.slice(emphasisLength);

	return (
		<span key={key} className="bionify-word">
			<span className="bionify-word-emphasis">{emphasis}</span>
			{rest ? <span className="bionify-word-rest">{rest}</span> : null}
		</span>
	);
}

export function renderBionifyText(
	content: string,
	config: boolean | BionifyRenderConfig
): ReactNode {
	const normalizedConfig = normalizeBionifyConfig(config);
	if (!normalizedConfig.enabled || !content) {
		return content;
	}

	const algorithm = parseBionifyAlgorithm(normalizedConfig.algorithm);
	const parts: ReactNode[] = [];
	let lastIndex = 0;

	for (const match of content.matchAll(BIONIFY_WORD_PATTERN)) {
		const index = match.index ?? 0;
		const word = match[0];

		if (index > lastIndex) {
			parts.push(content.slice(lastIndex, index));
		}

		parts.push(renderBionifyWord(word, `bionify-${index}`, algorithm));
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

function transformBionifyNode(
	node: ReactNode,
	config: Required<BionifyRenderConfig>,
	index: number
): ReactNode {
	if (typeof node === 'string') {
		return renderBionifyText(node, config);
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

	return cloneElement(node, { key: node.key ?? index }, renderBionifyChildren(children, config));
}

export function renderBionifyChildren(
	children: ReactNode,
	config: boolean | BionifyRenderConfig
): ReactNode {
	const normalizedConfig = normalizeBionifyConfig(config);
	if (!normalizedConfig.enabled) {
		return children;
	}

	return Children.map(children, (child, index) =>
		transformBionifyNode(child, normalizedConfig, index)
	);
}

export function getBionifyReadingModeStyles(
	scopeSelector: string = DEFAULT_BIONIFY_SCOPE_SELECTOR,
	theme?: Theme
): string {
	const fallbackRestOpacity = theme
		? resolveBionifyRestOpacity(DEFAULT_BIONIFY_INTENSITY, theme)
		: DEFAULT_BIONIFY_REST_OPACITY;

	return `
		${scopeSelector} .bionify-word { display: inline; color: inherit; }
		${scopeSelector} .bionify-word-emphasis {
			font-weight: var(--bionify-emphasis-weight, 700) !important;
			color: inherit !important;
		}
		${scopeSelector} .bionify-word-rest {
			font-weight: 400 !important;
			color: inherit !important;
			opacity: var(--bionify-rest-opacity, ${fallbackRestOpacity}) !important;
		}
	`;
}

interface BionifyTextProps extends BionifyRenderConfig {
	children: ReactNode;
	theme?: Theme;
}

export function BionifyText({
	children,
	enabled,
	intensity = DEFAULT_BIONIFY_INTENSITY,
	algorithm = DEFAULT_BIONIFY_ALGORITHM,
	theme,
}: BionifyTextProps) {
	const normalizedConfig = normalizeBionifyConfig({ enabled, intensity, algorithm });
	if (!normalizedConfig.enabled) {
		return <>{children}</>;
	}
	ensureBionifyStylesInjected();

	return (
		<span
			className="bionify-text-block"
			style={buildBionifyCssVars(normalizedConfig.intensity, theme)}
		>
			{renderBionifyChildren(children, normalizedConfig)}
		</span>
	);
}

interface BionifyTextBlockProps extends HTMLAttributes<HTMLDivElement>, BionifyRenderConfig {
	children: ReactNode;
	restOpacity?: number;
	style?: CSSProperties;
	theme?: Theme;
}

export const BionifyTextBlock = forwardRef<HTMLDivElement, BionifyTextBlockProps>(
	function BionifyTextBlock(
		{
			children,
			enabled,
			className = '',
			intensity = DEFAULT_BIONIFY_INTENSITY,
			algorithm = DEFAULT_BIONIFY_ALGORITHM,
			restOpacity,
			style,
			theme,
			...props
		},
		ref: ForwardedRef<HTMLDivElement>
	) {
		ensureBionifyStylesInjected();
		const normalizedConfig = normalizeBionifyConfig({ enabled, intensity, algorithm });
		const blockClassName = ['bionify-text-block', className].filter(Boolean).join(' ');
		const blockStyle = {
			...style,
			...buildBionifyCssVars(normalizedConfig.intensity, theme),
			...(restOpacity !== undefined
				? { ['--bionify-rest-opacity' as const]: String(restOpacity) }
				: {}),
		} as CSSProperties;

		return (
			<div ref={ref} className={blockClassName} style={blockStyle} {...props}>
				{renderBionifyChildren(children, normalizedConfig)}
			</div>
		);
	}
);
