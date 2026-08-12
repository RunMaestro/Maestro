/**
 * ImageContextMenuHost - the single owner of the right-click image menu, mounted
 * once at the app root.
 *
 * Every image in the app gets Copy / Save from one delegated `contextmenu`
 * listener on the document: markdown embeds, transcript attachments, thumbnail
 * strips, the lightbox, agent-authored inline SVG, and Mermaid charts injected
 * imperatively (which never pass through React's tree at all). Surfaces wire up
 * nothing.
 *
 * That is deliberate. The menu previously hung off individual components, so
 * every new image surface silently shipped without it and the two long-lived
 * branches ended up wiring different subsets. A delegated listener cannot be
 * forgotten by a surface that does not know it exists.
 *
 * Three things are NOT images for this purpose:
 *  - anything inside `[data-no-image-menu]` (surfaces owning their own menu),
 *  - lucide icons, which are `<svg>` but carry the `lucide` class,
 *  - anything below ICON_SIZE_FLOOR px, i.e. favicons and inline badges.
 *
 * A menu that already handled the click (LinkContextMenu, FileContextMenu, the
 * terminal selection menu) calls preventDefault, so `defaultPrevented` is what
 * keeps two menus from opening on the same right-click.
 */

import { useCallback, useState } from 'react';
import type { Theme } from '../types';
import { ImageContextMenu, type ImageContextMenuState } from './ImageContextMenu';
import { ImageDestinationModal, type ImageDestination } from './ImageDestinationModal';
import { useEventListener } from '../hooks/utils/useEventListener';
import { useActiveSession } from '../hooks/session/useActiveSession';
import {
	isSvgElement,
	saveImageToProject,
	suggestImageFileName,
	defaultExtensionFor,
	type ExportableImage,
} from '../utils/imageExport';
import { DIAGRAMS_DIR } from '../../shared/maestro-paths';
import { notifyToast } from '../stores/notificationStore';

/**
 * Below this rendered size an image is chrome, not content. Favicons (16px) and
 * inline status badges fall under it; QR codes, avatars, and diagrams clear it.
 */
const ICON_SIZE_FLOOR = 32;

/** The image a right-click landed on, or null when it was not on one. */
export function resolveImageFromEvent(e: MouseEvent): ExportableImage | null {
	const target = e.target as Element | null;
	const el = target?.closest?.('svg, img') as ExportableImage | null;
	if (!el) return null;
	if (el.closest('[data-no-image-menu]')) return null;
	// Icons are <svg> too. lucide-react stamps every one with a `lucide` class.
	if (isSvgElement(el) && el.classList.contains('lucide')) return null;

	const rect = el.getBoundingClientRect();
	if (rect.width < ICON_SIZE_FLOOR || rect.height < ICON_SIZE_FLOOR) return null;
	return el;
}

interface ImageContextMenuHostProps {
	theme: Theme;
}

export function ImageContextMenuHost({ theme }: ImageContextMenuHostProps) {
	const [menu, setMenu] = useState<ImageContextMenuState | null>(null);
	const [saveTarget, setSaveTarget] = useState<ExportableImage | null>(null);
	const [isSaving, setIsSaving] = useState(false);
	const session = useActiveSession();
	// Images are saved into the project they were rendered in. Every surface that
	// shows one lives inside the active agent's view, so the active session is
	// the project - no host has to thread a path down to the menu.
	const projectRoot = session?.projectRoot || session?.cwd || '';

	useEventListener(
		'contextmenu',
		(event: Event) => {
			const e = event as MouseEvent;
			// Another menu already claimed this click.
			if (e.defaultPrevented) return;
			const el = resolveImageFromEvent(e);
			if (!el) return;
			e.preventDefault();
			setMenu({ x: e.clientX, y: e.clientY, target: el });
		},
		{ target: document }
	);

	const handleSave = useCallback(
		async (destination: ImageDestination) => {
			if (!saveTarget || !projectRoot) return;
			setIsSaving(true);
			try {
				const saved = await saveImageToProject(
					saveTarget,
					{
						projectRoot,
						sshRemoteId: session?.sshRemoteId,
						relativeDir: destination.relativeDir,
						fileName: destination.fileName,
					},
					destination.format
				);
				notifyToast({
					color: 'green',
					title: 'Image Saved',
					message: saved.relativePath,
					sessionId: session?.id,
					clickAction: session?.id
						? { kind: 'open-file', sessionId: session.id, path: saved.path }
						: undefined,
				});
				setSaveTarget(null);
			} catch (err) {
				notifyToast({
					color: 'red',
					title: 'Could Not Save Image',
					message: err instanceof Error ? err.message : String(err),
				});
			} finally {
				setIsSaving(false);
			}
		},
		[saveTarget, projectRoot, session?.sshRemoteId, session?.id]
	);

	return (
		<>
			{menu && (
				<ImageContextMenu
					menu={menu}
					theme={theme}
					onDismiss={() => setMenu(null)}
					// No project means nowhere to save into (e.g. the wizard before an
					// agent exists); the menu drops the entry rather than failing later.
					onSaveToProject={projectRoot ? () => setSaveTarget(menu.target) : undefined}
				/>
			)}
			{saveTarget && (
				<ImageDestinationModal
					theme={theme}
					projectRoot={projectRoot}
					isSvg={isSvgElement(saveTarget)}
					initialDir={DIAGRAMS_DIR}
					initialFileName={suggestImageFileName(saveTarget, defaultExtensionFor(saveTarget))}
					onSave={handleSave}
					onCancel={() => setSaveTarget(null)}
					isSaving={isSaving}
				/>
			)}
		</>
	);
}

export default ImageContextMenuHost;
