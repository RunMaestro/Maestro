/**
 * Syntax highlighting for fenced code in the terminal.
 *
 * Uses `highlight.js` (already a dependency; it runs in plain Node) through its
 * core build with a fixed set of common languages, so the TUI bundle does not
 * carry all 190. highlight.js emits HTML; this turns that HTML into colored
 * spans per line, which is what Ink draws. Anything the grammar cannot place,
 * or a language nobody registered, comes back as plain text: code is always
 * shown, never lost to a highlighter failure.
 */

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
	bash,
	c,
	cpp,
	css,
	diff,
	go,
	java,
	javascript,
	json,
	markdown,
	python,
	ruby,
	rust,
	sql,
	typescript,
	xml,
	yaml,
};
for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition);

/** Fence labels people write that highlight.js names differently or does not alias. */
const LANGUAGE_ALIASES: Record<string, string> = {
	sh: 'bash',
	shell: 'bash',
	zsh: 'bash',
	console: 'bash',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	ts: 'typescript',
	tsx: 'typescript',
	py: 'python',
	rb: 'ruby',
	rs: 'rust',
	yml: 'yaml',
	html: 'xml',
	htm: 'xml',
	svg: 'xml',
	'c++': 'cpp',
	jsonc: 'json',
	md: 'markdown',
	patch: 'diff',
};

/** A run of text with one style. Unstyled text has no color. */
export interface StyledSpan {
	text: string;
	color?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	dimColor?: boolean;
}

/** Terminal colors for highlight.js scopes. The first matching class wins. */
const SCOPE_COLORS: ReadonlyArray<readonly [string, Partial<StyledSpan>]> = [
	['hljs-comment', { color: 'gray', italic: true }],
	['hljs-quote', { color: 'gray', italic: true }],
	['hljs-keyword', { color: 'magenta' }],
	['hljs-selector-tag', { color: 'magenta' }],
	['hljs-literal', { color: 'magenta' }],
	['hljs-string', { color: 'green' }],
	['hljs-regexp', { color: 'green' }],
	['hljs-addition', { color: 'green' }],
	['hljs-number', { color: 'yellow' }],
	['hljs-symbol', { color: 'yellow' }],
	['hljs-bullet', { color: 'yellow' }],
	['hljs-built_in', { color: 'cyan' }],
	['hljs-type', { color: 'cyan' }],
	['hljs-title', { color: 'blue' }],
	['hljs-function', { color: 'blue' }],
	['hljs-class', { color: 'blue' }],
	['hljs-attr', { color: 'cyan' }],
	['hljs-attribute', { color: 'cyan' }],
	['hljs-variable', { color: 'cyan' }],
	['hljs-params', {}],
	['hljs-meta', { color: 'gray' }],
	['hljs-tag', { color: 'gray' }],
	['hljs-name', { color: 'blue' }],
	['hljs-section', { color: 'blue', bold: true }],
	['hljs-deletion', { color: 'red' }],
	['hljs-link', { color: 'blue', underline: true }],
	['hljs-emphasis', { italic: true }],
	['hljs-strong', { bold: true }],
];

const HTML_ENTITIES: Record<string, string> = {
	'&lt;': '<',
	'&gt;': '>',
	'&amp;': '&',
	'&quot;': '"',
	'&#x27;': "'",
	'&#39;': "'",
};

function decodeEntities(text: string): string {
	return text.replace(
		/&(?:lt|gt|amp|quot|#x27|#39);/g,
		(entity) => HTML_ENTITIES[entity] ?? entity
	);
}

function styleForClasses(classes: string): Partial<StyledSpan> {
	const present = classes.split(/\s+/);
	for (const [scope, style] of SCOPE_COLORS) {
		// `hljs-title function_` and `hljs-title class_` carry the base scope first.
		if (present.includes(scope) || present.some((name) => name.startsWith(`${scope}_`))) {
			return style;
		}
	}
	return {};
}

/**
 * Turn highlight.js HTML into lines of spans. A span that crosses a newline
 * (a block comment, a template string) is split so each line stands alone.
 */
export function htmlToStyledLines(html: string): StyledSpan[][] {
	const lines: StyledSpan[][] = [[]];
	const stack: Array<Partial<StyledSpan>> = [{}];
	const tagPattern = /<(\/?)span(?:\s+class="([^"]*)")?>|([^<]+)/g;

	const push = (text: string) => {
		const style = stack[stack.length - 1] ?? {};
		const parts = text.split('\n');
		parts.forEach((part, index) => {
			if (index > 0) lines.push([]);
			if (part) lines[lines.length - 1]!.push({ text: part, ...style });
		});
	};

	let match: RegExpExecArray | null;
	while ((match = tagPattern.exec(html)) !== null) {
		const [, closing, classes, text] = match;
		if (text !== undefined) {
			push(decodeEntities(text));
		} else if (closing) {
			if (stack.length > 1) stack.pop();
		} else {
			const inherited = stack[stack.length - 1] ?? {};
			stack.push({ ...inherited, ...styleForClasses(classes ?? '') });
		}
	}
	return lines;
}

/** The language highlight.js will use for a fence label, or undefined when it has no grammar. */
export function resolveHighlightLanguage(label: string | undefined): string | undefined {
	const name = (label ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
	if (!name) return undefined;
	const resolved = LANGUAGE_ALIASES[name] ?? name;
	return hljs.getLanguage(resolved) ? resolved : undefined;
}

/** Code as lines of styled spans. An unknown language, or a failure, yields plain lines. */
export function highlightCode(code: string, label: string | undefined): StyledSpan[][] {
	const plain = () => code.split('\n').map((line) => (line ? [{ text: line }] : []));
	const language = resolveHighlightLanguage(label);
	if (!language) return plain();
	try {
		const { value } = hljs.highlight(code, { language, ignoreIllegals: true });
		return htmlToStyledLines(value);
	} catch {
		return plain();
	}
}
