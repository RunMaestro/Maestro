/**
 * remarkWindowsImagePaths - let an image written with a Windows drive path
 * reach the image loader.
 *
 * `![shot](D:/work/a.png)` never rendered (#2067). Both URL gates read `D:` as
 * a URL scheme: react-markdown's `defaultUrlTransform` blanks any scheme it
 * does not allow, and rehype-sanitize drops a `src` whose scheme is not in its
 * list. The image arrived with an empty `src` and drew nothing.
 *
 * Rewriting the destination to `file:///D:/work/a.png` here, before either
 * gate runs, uses the scheme both already allow. `resolveLocalImagePath` turns
 * it back into `D:/work/a.png` for the read.
 *
 * Image nodes only: a link keeps its destination, so link routing does not
 * change. A reference image (`![x][shot]` with `[shot]: D:/a.png`) becomes an
 * inline image with the rewritten URL. The definition stays as written,
 * because a link can share it.
 */

import { visit, SKIP } from 'unist-util-visit';
import type { Root, Image, Definition } from 'mdast';
import { windowsDrivePathToFileUrl } from '../../utils/openFileUrl';

export function remarkWindowsImagePaths() {
	return (tree: Root) => {
		const definitions = new Map<string, Definition>();
		visit(tree, 'definition', (node: Definition) => {
			// The first definition of a label wins, as in CommonMark.
			if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
		});

		visit(tree, (node, index, parent) => {
			if (node.type === 'image') {
				const fileUrl = windowsDrivePathToFileUrl(node.url);
				if (fileUrl) node.url = fileUrl;
				return;
			}
			if (node.type !== 'imageReference' || !parent || index === undefined) return;
			const definition = definitions.get(node.identifier);
			const fileUrl = definition ? windowsDrivePathToFileUrl(definition.url) : null;
			if (!definition || !fileUrl) return;
			const image: Image = {
				type: 'image',
				url: fileUrl,
				title: definition.title,
				alt: node.alt,
				position: node.position,
			};
			parent.children.splice(index, 1, image);
			return SKIP;
		});
	};
}
