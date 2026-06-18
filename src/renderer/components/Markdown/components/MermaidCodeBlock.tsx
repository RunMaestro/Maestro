/**
 * MermaidCodeBlock - the chat surface's renderer for ```mermaid fences. The
 * shared ShikiCodeBlock can only syntax-highlight a fence, so mermaid diagrams
 * used to leak through as plain source. This wraps MermaidRenderer with a
 * Diagram/Source toggle so the diagram renders inline by default while the raw
 * source is always one click away (and a copy button for the source).
 *
 * The document surface gets the same capability through customLanguageRenderers
 * (see PrismCodeBlock); this is the chat-only equivalent.
 */

import { useState } from 'react';
import { Clipboard, Code2, Workflow } from 'lucide-react';
import type { Theme } from '../../../types';
import { MermaidRenderer } from '../../MermaidRenderer';

interface MermaidCodeBlockProps {
	code: string;
	theme: Theme;
	onCopy: (text: string) => void;
}

export function MermaidCodeBlock({ code, theme, onCopy }: MermaidCodeBlockProps) {
	const [view, setView] = useState<'diagram' | 'source'>('diagram');

	const containerStyle = {
		margin: '0.5em 0',
		borderRadius: '6px',
		background: theme.colors.bgSidebar,
		border: `1px solid ${theme.colors.border}`,
		overflow: 'hidden' as const,
		fontSize: '0.9em',
	};

	const toggleBtnStyle = (active: boolean) => ({
		backgroundColor: active ? theme.colors.bgActivity : 'transparent',
		color: active ? theme.colors.textMain : theme.colors.textDim,
		border: `1px solid ${active ? theme.colors.border : 'transparent'}`,
	});

	return (
		<div className="mermaid-code-block" style={containerStyle}>
			<div
				className="flex items-center justify-between px-2 py-1.5"
				style={{ borderBottom: `1px solid ${theme.colors.border}` }}
			>
				<div className="flex items-center gap-1">
					<button
						onClick={() => setView('diagram')}
						className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors"
						style={toggleBtnStyle(view === 'diagram')}
						title="Show rendered diagram"
					>
						<Workflow className="w-3 h-3" />
						Diagram
					</button>
					<button
						onClick={() => setView('source')}
						className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors"
						style={toggleBtnStyle(view === 'source')}
						title="Show diagram source"
					>
						<Code2 className="w-3 h-3" />
						Source
					</button>
				</div>
				<button
					onClick={() => onCopy(code)}
					className="p-1 rounded opacity-70 hover:opacity-100 transition-opacity"
					style={{ color: theme.colors.textDim }}
					title="Copy source"
				>
					<Clipboard className="w-3.5 h-3.5" />
				</button>
			</div>
			{view === 'diagram' ? (
				<MermaidRenderer chart={code} theme={theme} />
			) : (
				<pre
					className="m-0 p-3 overflow-x-auto"
					style={{ background: 'transparent', color: theme.colors.textMain, whiteSpace: 'pre' }}
				>
					<code>{code}</code>
				</pre>
			)}
		</div>
	);
}
