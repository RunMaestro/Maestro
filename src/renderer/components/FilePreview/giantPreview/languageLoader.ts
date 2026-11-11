import type { Extension } from '@codemirror/state';
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import type { StreamParser } from '@codemirror/language';
import { DATAVIEW_JS_LANGUAGE_IDS } from '../../../../shared/dataview/syntax';
import { captureException } from '../../../utils/sentry';

/**
 * Lazy per-language extension loader for the CodeMirror editor (Giant tier
 * preview AND the inline file/markdown editor).
 *
 * Each `@codemirror/lang-*` package weighs 10-30 KB gz. Dynamic `import()`
 * means the only language pack that ever enters the bundle is the one the
 * user actually opens. Unknown languages get plain text - still useful since
 * CM6 handles them with line numbers and search.
 *
 * The language ids here mirror what `getLanguageFromFilename()` (see
 * `filePreviewUtils.ts`) emits, so anything the read-only Prism view
 * highlights also highlights while editing. Dedicated Lezer packs are used
 * where they exist; the long tail (ruby, shell, toml, scss, csharp) rides on
 * `@codemirror/legacy-modes` via `StreamLanguage`.
 *
 * The same table colors fenced code INSIDE a markdown file: the markdown
 * grammar is built with `codeLanguages: fenceLanguage`, which resolves a
 * fence's tag (` ```ts `, ` ```dataview `) through {@link ALIASES} and these
 * loaders. So every language the editor highlights as a file it also
 * highlights as a fence, and a grammar added here reaches both at once.
 */

type LanguageLoader = () => Promise<LanguageSupport>;

/** A legacy stream parser as full language support (what a fence description has to load). */
const streamSupport = (parser: StreamParser<unknown>) =>
	new LanguageSupport(StreamLanguage.define(parser));

/**
 * Canonical language id → lazy loader. Aliases are resolved to a canonical id
 * by {@link ALIASES} before lookup, so each grammar is declared exactly once.
 * This map is the single source of truth: {@link hasLanguageSupport} derives
 * its answer from it, so the two can never drift.
 */
const LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
	markdown: async () =>
		(await import('@codemirror/lang-markdown')).markdown({ codeLanguages: fenceLanguage }),
	dataview: async () =>
		streamSupport((await import('../../../utils/dataviewSyntax')).DQL_STREAM_PARSER),
	javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
	jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
	typescript: async () =>
		(await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
	tsx: async () =>
		(await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
	python: async () => (await import('@codemirror/lang-python')).python(),
	json: async () => (await import('@codemirror/lang-json')).json(),
	yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
	go: async () => (await import('@codemirror/lang-go')).go(),
	rust: async () => (await import('@codemirror/lang-rust')).rust(),
	java: async () => (await import('@codemirror/lang-java')).java(),
	cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
	php: async () => (await import('@codemirror/lang-php')).php(),
	html: async () => (await import('@codemirror/lang-html')).html(),
	css: async () => (await import('@codemirror/lang-css')).css(),
	sql: async () => (await import('@codemirror/lang-sql')).sql(),
	xml: async () => (await import('@codemirror/lang-xml')).xml(),
	ruby: async () => streamSupport((await import('@codemirror/legacy-modes/mode/ruby')).ruby),
	shell: async () => streamSupport((await import('@codemirror/legacy-modes/mode/shell')).shell),
	toml: async () => streamSupport((await import('@codemirror/legacy-modes/mode/toml')).toml),
	scss: async () => streamSupport((await import('@codemirror/legacy-modes/mode/css')).sCSS),
	csharp: async () => streamSupport((await import('@codemirror/legacy-modes/mode/clike')).csharp),
};

/** Alias → canonical id. Keeps the loader map declared once per grammar. */
const ALIASES: Record<string, string> = {
	md: 'markdown',
	mdx: 'markdown',
	js: 'javascript',
	ts: 'typescript',
	py: 'python',
	jsonl: 'json',
	ndjson: 'json',
	yml: 'yaml',
	c: 'cpp',
	bash: 'shell',
	sh: 'shell',
	zsh: 'shell',
	...Object.fromEntries(DATAVIEW_JS_LANGUAGE_IDS.map((id) => [id, 'javascript'])),
};

function resolveLanguageId(language: string): string {
	const normalized = language.trim().toLowerCase();
	return ALIASES[normalized] ?? normalized;
}

/** Plain text, for a fence whose grammar failed to load: the fence stays editable, just uncolored. */
const plainTextSupport = () =>
	streamSupport({
		token: (stream) => {
			stream.skipToEnd();
			return null;
		},
	});

/** One description per canonical language, so a grammar is loaded once however many fences use it. */
const fenceDescriptions = new Map<string, LanguageDescription>();

/**
 * The grammar for a markdown fence's tag, or null for a tag we have no grammar for (the fence stays plain
 * text). Handed to `markdown({ codeLanguages })`; the grammar loads on first use, through the same loaders
 * a file of that language uses.
 */
export function fenceLanguage(info: string): LanguageDescription | null {
	const id = resolveLanguageId(info);
	const loader = LANGUAGE_LOADERS[id];
	if (!loader) return null;
	let description = fenceDescriptions.get(id);
	if (!description) {
		description = LanguageDescription.of({
			name: id,
			load: async () => {
				try {
					return await loader();
				} catch (err) {
					captureException(err, {
						extra: { component: 'giantPreview/languageLoader', language: id, fence: true },
					});
					return plainTextSupport();
				}
			},
		});
		fenceDescriptions.set(id, description);
	}
	return description;
}

/**
 * Returns `null` when the language is unrecognized OR when the dynamic
 * import fails (network / packaging issue). Import failures are reported to
 * Sentry with context so we hear about packaging regressions in field data,
 * but the promise still resolves to null so the caller can mount the editor
 * without syntax highlighting - degraded UX is better than no preview.
 */
export async function loadLanguageExtension(language: string): Promise<Extension | null> {
	const id = resolveLanguageId(language);
	const loader = LANGUAGE_LOADERS[id];
	if (!loader) return null;

	try {
		return await loader();
	} catch (err) {
		// Dynamic import failed (offline, packaging error, bad chunk URL).
		// Report so we hear about it, then fall through to the plain-text
		// editor so the user still gets a preview.
		captureException(err, {
			extra: { component: 'giantPreview/languageLoader', language: id },
		});
		return null;
	}
}

/**
 * Predicate companion to `loadLanguageExtension`: true when we have a
 * dedicated CM6 grammar for the given identifier. Used by the component to
 * decide whether to await the loader at all (skipping it for plain text saves
 * a microtask).
 */
export function hasLanguageSupport(language: string): boolean {
	return resolveLanguageId(language) in LANGUAGE_LOADERS;
}
