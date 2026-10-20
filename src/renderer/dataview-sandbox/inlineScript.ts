/**
 * How the DataviewJS guest turns script text into a function (DEV-6 in docs/agent-guides/DATAVIEW.md).
 *
 * The guest's CSP (D4) has no `'unsafe-eval'`, so `eval`, `new Function`, and `AsyncFunction` all throw.
 * Its `'unsafe-inline'` does let an inline `<script>` element run, so each script becomes one: the element
 * only DEFINES a function and hands it back on `document.currentScript`, and nothing in the note's code
 * runs until the caller calls that function. Errors thrown by the code then reach the caller with their
 * stack, as upstream's `eval` gives them.
 *
 * This is the only place the guest compiles code, and it never parses HTML: the source travels as the
 * element's `textContent`.
 */

/** The property of the script element an injected script hands its function back on. */
const SCRIPT_SLOT = 'maestroDataviewScript';

export interface InlineScript {
	/** Parameter names of the function the body runs in. */
	params: readonly string[];
	/** The function body. */
	body: string;
	/**
	 * Run the body in strict mode. Upstream evaluates a block with a direct `eval` inside its strict bundle
	 * (strict), and a view with `new Function` (sloppy).
	 */
	strict: boolean;
	/** A name for stack traces (`//# sourceURL`). */
	sourceUrl?: string;
}

export type CompiledScript = (this: unknown, ...args: unknown[]) => unknown;

/** A `//# sourceURL` value kept to one line, so a file name cannot end the comment and add code. */
function sourceUrlComment(sourceUrl: string | undefined): string {
	if (!sourceUrl) return '';
	return `\n//# sourceURL=${sourceUrl.replace(/[\r\n\u2028\u2029]/g, ' ')}`;
}

/**
 * Compile `script` into a function by running it as an inline `<script>` in `doc`. Throws the error the
 * browser reported when the code does not compile (a `SyntaxError`).
 */
export function compileInlineScript(doc: Document, script: InlineScript): CompiledScript {
	for (const param of script.params) {
		if (!/^[A-Za-z_$][\w$]*$/.test(param)) throw new Error(`Not a parameter name: ${param}`);
	}
	const element = doc.createElement('script');
	// The body starts on the first line, so line numbers in a stack match the script's own, as with `eval`.
	// The newline after it keeps a trailing `//` comment from swallowing the closing brace.
	element.textContent =
		`document.currentScript.${SCRIPT_SLOT} = function (${script.params.join(', ')}) {` +
		(script.strict ? '"use strict";' : '') +
		`${script.body}\n};` +
		sourceUrlComment(script.sourceUrl);

	// A script that does not compile never runs; the browser reports the error to the window instead.
	let failed = false;
	let reported: unknown;
	const onError = (event: ErrorEvent) => {
		failed = true;
		reported = event.error ?? new SyntaxError(event.message);
		event.preventDefault();
	};
	const view = doc.defaultView;
	view?.addEventListener('error', onError);
	try {
		(doc.head ?? doc.documentElement).appendChild(element);
	} finally {
		view?.removeEventListener('error', onError);
		element.remove();
	}

	if (failed) throw reported;
	const compiled = (element as unknown as Record<string, unknown>)[SCRIPT_SLOT];
	if (typeof compiled !== 'function') throw new Error('The script did not compile.');
	return compiled as CompiledScript;
}
