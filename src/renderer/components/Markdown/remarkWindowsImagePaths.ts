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
 * change.
 */

import { visit } from 'unist-util-visit';
import type { Root, Image } from 'mdast';
import { windowsDrivePathToFileUrl } from '../../utils/openFileUrl';

export function remarkWindowsImagePaths() {
	return (tree: Root) => {
		visit(tree, 'image', (node: Image) => {
			const fileUrl = windowsDrivePathToFileUrl(node.url);
			if (fileUrl) node.url = fileUrl;
		});
	};
}
