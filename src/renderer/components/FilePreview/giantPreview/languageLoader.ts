import type { Extension } from '@codemirror/state';
import { captureException } from '../../../utils/sentry';

/**
 * Lazy per-language extension loader for the Giant tier.
 *
 * Each `@codemirror/lang-*` package weighs 10-30 KB gz. Dynamic `import()`
 * means the only language pack that ever enters the bundle is the one the
 * user actually opens. Unknown languages get plain text — still useful for
 * huge files since CM6 handles them with line numbers and search.
 *
 * Returns `null` when the language is unrecognized OR when the dynamic
 * import fails (network / packaging issue). Import failures are reported to
 * Sentry with context so we hear about packaging regressions in field data,
 * but the promise still resolves to null so the caller can mount the editor
 * without syntax highlighting — degraded UX is better than no preview.
 */
export async function loadLanguageExtension(language: string): Promise<Extension | null> {
	const normalized = language.toLowerCase();

	try {
		switch (normalized) {
			case 'markdown':
			case 'md':
			case 'mdx': {
				const { markdown } = await import('@codemirror/lang-markdown');
				return markdown();
			}
			case 'javascript':
			case 'js':
			case 'jsx': {
				const { javascript } = await import('@codemirror/lang-javascript');
				return javascript({ jsx: normalized === 'jsx' });
			}
			case 'typescript':
			case 'ts':
			case 'tsx': {
				const { javascript } = await import('@codemirror/lang-javascript');
				return javascript({ typescript: true, jsx: normalized === 'tsx' });
			}
			case 'python':
			case 'py': {
				const { python } = await import('@codemirror/lang-python');
				return python();
			}
			case 'json':
			case 'jsonl':
			case 'ndjson': {
				const { json } = await import('@codemirror/lang-json');
				return json();
			}
			case 'yaml':
			case 'yml': {
				const { yaml } = await import('@codemirror/lang-yaml');
				return yaml();
			}
			default:
				return null;
		}
	} catch (err) {
		// Dynamic import failed (offline, packaging error, bad chunk URL).
		// Report so we hear about it, then fall through to the plain-text
		// editor so the user still gets a preview.
		captureException(err, {
			extra: { component: 'giantPreview/languageLoader', language: normalized },
		});
		return null;
	}
}

/**
 * Predicate companion to `loadLanguageExtension`: true when we have a
 * dedicated CM6 language pack for the given identifier. Used by the
 * component to decide whether to await the loader at all (skipping it for
 * plain text saves a microtask).
 */
export function hasLanguageSupport(language: string): boolean {
	const normalized = language.toLowerCase();
	return (
		[
			'markdown',
			'md',
			'mdx',
			'javascript',
			'js',
			'jsx',
			'typescript',
			'ts',
			'tsx',
			'python',
			'py',
			'json',
			'jsonl',
			'ndjson',
			'yaml',
			'yml',
		].indexOf(normalized) !== -1
	);
}
