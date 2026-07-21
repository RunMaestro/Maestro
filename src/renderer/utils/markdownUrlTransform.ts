import { defaultUrlTransform } from 'react-markdown';

/**
 * react-markdown's default urlTransform strips href schemes outside of
 * https/http/ircs/mailto/xmpp. Allow our internal protocols through so the
 * click handler receives them - without this, `maestro://`, `maestro-file://`,
 * `tel:`, and `file:` hrefs would arrive as empty strings.
 */
export function urlTransformAllowingMaestro(value: string): string {
	if (
		value.startsWith('maestro://') ||
		value.startsWith('maestro-file://') ||
		value.startsWith('file://') ||
		value.startsWith('tel:')
	) {
		return value;
	}
	return defaultUrlTransform(value);
}
