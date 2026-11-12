import { defaultUrlTransform } from 'react-markdown';
import { hasUrlRoutingHint } from '../../shared/urlRoutingHint';

/**
 * react-markdown's default urlTransform strips href schemes outside of
 * https/http/ircs/mailto/xmpp. Allow our internal protocols through so the
 * click handler receives them - without this, `maestro://`, `maestro-file://`,
 * `tel:`, and `file:` hrefs would arrive as empty strings.
 *
 * A routing-hinted http(s) URL (`maestro+https://`, `system+https://`) passes
 * too; a hint in front of any other scheme does not, so `maestro+javascript:`
 * is still blanked here.
 */
export function urlTransformAllowingMaestro(value: string): string {
	if (
		value.startsWith('maestro://') ||
		value.startsWith('maestro-file://') ||
		value.startsWith('file://') ||
		value.startsWith('tel:') ||
		hasUrlRoutingHint(value)
	) {
		return value;
	}
	return defaultUrlTransform(value);
}
