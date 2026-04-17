import React, { Children, cloneElement, isValidElement, type ReactNode } from 'react';

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

interface BionifyTextProps {
	children: ReactNode;
	enabled: boolean;
}

export function BionifyText({ children, enabled }: BionifyTextProps) {
	return <>{renderBionifyChildren(children, enabled)}</>;
}
