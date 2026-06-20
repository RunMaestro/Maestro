import { defaultUrlTransform } from 'react-markdown';

/**
 * react-markdown's default urlTransform strips href schemes outside of
 * https/http/ircs/mailto/xmpp. Allow our internal protocols and image data URLs
 * through so the click/image handlers receive them. Without this, `maestro://`,
 * `maestro-file://`, `tel:`, `file:`, and `data:image/` values arrive as empty
 * strings. Git SSH remotes (`git@host:org/repo.git`) are also allowed through
 * so MarkdownLink can normalize them to browser URLs.
 */
export function urlTransformAllowingMaestro(value: string): string {
	if (
		value.startsWith('maestro://') ||
		value.startsWith('maestro-file://') ||
		value.startsWith('file://') ||
		value.startsWith('git@') ||
		value.startsWith('data:image/') ||
		value.startsWith('tel:')
	) {
		return value;
	}
	return defaultUrlTransform(value);
}
