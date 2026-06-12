/**
 * Escape HTML special characters so a user-supplied string can be safely
 * embedded inside an HTML document fragment.
 *
 * Defense-in-depth: callers typically also run the final HTML through
 * DOMPurify, but escaping at insertion sites is the more precise tool when we
 * KNOW a substring is untrusted text (e.g. frontmatter values, attribute
 * payloads).
 */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
