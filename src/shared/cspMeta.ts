/**
 * The Content-Security-Policy meta tag of a document a host serves into an isolated guest (plugin panels,
 * the DataviewJS sandbox). Those hosts send the same policy as a response header too; the meta tag keeps the
 * policy on the document if a path that drops response headers ever renders it.
 */

/** `html` with a CSP meta tag for `csp` first in its `<head>` (one is made when the document has none). */
export function withCspMetaTag(html: string, csp: string): string {
	const content = csp.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
	const meta = `<meta http-equiv="Content-Security-Policy" content="${content}">`;
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
	}
	if (/<html[^>]*>/i.test(html)) {
		return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
	}
	return `${meta}${html}`;
}
