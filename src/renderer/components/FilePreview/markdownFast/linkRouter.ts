import type { ClickModifiers, LinkAction, LinkDescriptor } from './types';

const MAESTRO_FILE_PROTOCOL = 'maestro-file://';
const MAESTRO_DEEP_LINK_PROTOCOL = 'maestro://';

/** External protocols we hand off to the parent's external-link handler.
 * Case-insensitive so `HTTPS://` and other uppercase variants still match. */
const EXTERNAL_PROTOCOL_RE = /^(?:https?|mailto|tel|file):/i;

/**
 * Decide what should happen when a markdown link is clicked.
 *
 * The Fast tier renders HTML via `innerHTML`, which means React event handlers
 * never reach the anchors inside. Instead, the component attaches a single
 * delegated click handler at the scroll container, extracts an anchor + the
 * event modifiers, and asks this function what to do.
 *
 * Pure - no DOM access, no side effects. The component is responsible for
 * wiring the returned action to the relevant callback.
 */
export function resolveLinkAction(link: LinkDescriptor, modifiers: ClickModifiers): LinkAction {
	const openInNewTab = modifiers.metaKey || modifiers.ctrlKey || modifiers.button === 1;

	// Internal file references emitted by remarkFileLinks pre-rewrite get
	// stamped with a data attribute. Prefer it over href because it survives
	// DOMPurify sanitization even when the URI scheme is exotic.
	if (link.dataMaestroFile) {
		return { kind: 'maestro-file', path: link.dataMaestroFile, openInNewTab };
	}

	const href = link.href || '';

	if (href.startsWith(MAESTRO_FILE_PROTOCOL)) {
		return {
			kind: 'maestro-file',
			path: href.slice(MAESTRO_FILE_PROTOCOL.length),
			openInNewTab,
		};
	}

	if (href.startsWith(MAESTRO_DEEP_LINK_PROTOCOL)) {
		return { kind: 'maestro-deep-link', href };
	}

	if (href.startsWith('#')) {
		return { kind: 'anchor', hash: href };
	}

	if (EXTERNAL_PROTOCOL_RE.test(href)) {
		return { kind: 'external', href, openInNewTab };
	}

	return { kind: 'none' };
}
