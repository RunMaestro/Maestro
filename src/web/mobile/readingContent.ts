export interface WebReaderTextSegment {
	type: 'text' | 'code';
	content: string;
	language?: string;
}

export type WebReaderContent = string | WebReaderTextSegment[];

export type WebReaderContentKind = 'markdown' | 'structured';

export interface NormalizedWebReaderContent {
	kind: WebReaderContentKind;
	markdown?: string;
	segments?: WebReaderTextSegment[];
}

const LANGUAGE_MAP: Record<string, string> = {
	ts: 'typescript',
	tsx: 'tsx',
	js: 'javascript',
	jsx: 'jsx',
	json: 'json',
	md: 'markdown',
	py: 'python',
	python: 'python',
	rb: 'ruby',
	ruby: 'ruby',
	go: 'go',
	golang: 'go',
	rs: 'rust',
	rust: 'rust',
	java: 'java',
	c: 'c',
	cpp: 'cpp',
	'c++': 'cpp',
	cs: 'csharp',
	csharp: 'csharp',
	php: 'php',
	html: 'html',
	css: 'css',
	scss: 'scss',
	sass: 'sass',
	sql: 'sql',
	sh: 'bash',
	bash: 'bash',
	shell: 'bash',
	zsh: 'bash',
	yaml: 'yaml',
	yml: 'yaml',
	toml: 'toml',
	xml: 'xml',
	swift: 'swift',
	kotlin: 'kotlin',
	kt: 'kotlin',
	scala: 'scala',
	r: 'r',
	lua: 'lua',
	perl: 'perl',
	dockerfile: 'dockerfile',
	docker: 'dockerfile',
	makefile: 'makefile',
	make: 'makefile',
	graphql: 'graphql',
	gql: 'graphql',
	diff: 'diff',
	patch: 'diff',
};

export function normalizeReaderLanguage(lang: string | undefined): string {
	if (!lang) return 'text';
	const normalized = lang.toLowerCase().trim();
	return LANGUAGE_MAP[normalized] || normalized || 'text';
}

export function parseTextWithCodeBlocks(text: string): WebReaderTextSegment[] {
	const segments: WebReaderTextSegment[] = [];
	const codeBlockRegex = /(`{3,})([^\n\r`]*)\n?([\s\S]*?)\1/g;

	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = codeBlockRegex.exec(text)) !== null) {
		if (match.index > lastIndex) {
			const textContent = text.slice(lastIndex, match.index);
			if (textContent.trim()) {
				segments.push({
					type: 'text',
					content: textContent,
				});
			}
		}

		let language = (match[2] || '').trim();
		let code = match[3] || '';

		if (!code.trim() && language.includes(' ')) {
			const [languageToken, ...inlineCodeParts] = language.split(/\s+/);
			const inlineCode = inlineCodeParts.join(' ');
			if (inlineCode.trim()) {
				language = languageToken;
				code = inlineCode;
			}
		}

		if (code.trim()) {
			segments.push({
				type: 'code',
				content: code.trimEnd(),
				language: normalizeReaderLanguage(language),
			});
		}

		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < text.length) {
		const remainingText = text.slice(lastIndex);
		if (remainingText.trim()) {
			segments.push({
				type: 'text',
				content: remainingText,
			});
		}
	}

	if (segments.length === 0 && text.trim()) {
		segments.push({
			type: 'text',
			content: text,
		});
	}

	return segments;
}

function isMarkdownPreviewable(content: string): boolean {
	// This deliberately checks only fence-marker parity. It does not validate full
	// fence structure, and should stay aligned with the lighter-weight parser above.
	const codeBlockMatches = content.match(/```/g);
	if (codeBlockMatches && codeBlockMatches.length % 2 !== 0) {
		return false;
	}
	return true;
}

function looksLikeMarkdown(content: string): boolean {
	return (
		/^\s{0,3}#{1,6}\s+\S/m.test(content) ||
		/^\s{0,3}(?:[-*+]\s|\d+\.\s)\S/m.test(content) ||
		/^\s{0,3}>\s+\S/m.test(content) ||
		/\[[^\]]+\]\([^)]+\)/.test(content) ||
		/^\s*\|.+\|\s*$/m.test(content) ||
		/^\s{0,3}[-*_]{3,}\s*$/m.test(content)
	);
}

export function normalizeWebReaderContent(content: WebReaderContent): NormalizedWebReaderContent {
	if (Array.isArray(content)) {
		return {
			kind: 'structured',
			segments: content,
		};
	}

	if (looksLikeMarkdown(content) && isMarkdownPreviewable(content)) {
		return {
			kind: 'markdown',
			markdown: content,
		};
	}

	return {
		kind: 'structured',
		segments: parseTextWithCodeBlocks(content),
	};
}
