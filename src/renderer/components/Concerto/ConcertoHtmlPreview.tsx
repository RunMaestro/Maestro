/**
 * ConcertoHtmlPreview renders an agent-authored, single-page HTML mockup in an
 * isolated iframe. Main serves the document from a dedicated protocol with a
 * restrictive CSP, so inline CSS and JavaScript work without weakening the
 * parent renderer's policy.
 */

import { memo, useLayoutEffect, useRef } from 'react';
import { buildConcertoHtmlUrl, type ConcertoHtmlSurface } from '../../../shared/concerto-html';
import {
	handleConcertoDesignerMessage,
	registerConcertoDesignerFrame,
	unregisterConcertoDesignerFrame,
} from './concertoDesignerBridge';

interface ConcertoHtmlPreviewProps {
	surface: ConcertoHtmlSurface;
	id: string;
	revision: number;
	title: string;
	minHeight?: number;
}

export const ConcertoHtmlPreview = memo(function ConcertoHtmlPreview({
	surface,
	id,
	revision,
	title,
	minHeight = 320,
}: ConcertoHtmlPreviewProps) {
	const frameRef = useRef<HTMLIFrameElement>(null);

	useLayoutEffect(() => {
		const frame = frameRef.current;
		if (!frame) return;
		registerConcertoDesignerFrame(surface, id, revision, frame);
		const handleMessage = (event: MessageEvent) =>
			handleConcertoDesignerMessage(surface, id, event);
		window.addEventListener('message', handleMessage);
		return () => {
			window.removeEventListener('message', handleMessage);
			unregisterConcertoDesignerFrame(surface, id, frame);
		};
	}, [id, revision, surface]);

	return (
		<iframe
			key={revision}
			ref={frameRef}
			title={title}
			src={buildConcertoHtmlUrl(surface, id, revision)}
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			data-testid="concerto-html-iframe"
			data-concerto-surface={surface}
			data-concerto-id={id}
			style={{
				display: 'block',
				width: '100%',
				height: '100%',
				minHeight,
				border: 'none',
				backgroundColor: '#fff',
			}}
		/>
	);
});
