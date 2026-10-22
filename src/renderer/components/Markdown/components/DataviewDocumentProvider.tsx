/**
 * DataviewDocumentProvider - what a Dataview surface wraps its rendered markdown in (D7, DEV-5).
 *
 * It provides the note to `dataview` and `dataviewjs` blocks and to inline spans (`DataviewDocumentContext`), and
 * hosts the note's inline DataviewJS guest (`DataviewJsInlineHost`), which mounts nothing until an inline `$=`
 * span asks for it. With no note (`value` null: the Encore Feature off, an untitled buffer, no agent) it provides
 * null and mounts nothing, so every fence and span inside renders as plain code. The tree is the same either way,
 * so the markdown never remounts when the value comes or goes.
 */

import { DataviewDocumentContext, type DataviewDocumentScope } from './DataviewDocumentContext';
import { DataviewJsInlineHost } from './DataviewJsInlineHost';

export function DataviewDocumentProvider({
	value,
	children,
}: {
	value: DataviewDocumentScope | null;
	children: React.ReactNode;
}) {
	return (
		<DataviewDocumentContext.Provider value={value}>
			<DataviewJsInlineHost doc={value}>{children}</DataviewJsInlineHost>
		</DataviewDocumentContext.Provider>
	);
}
