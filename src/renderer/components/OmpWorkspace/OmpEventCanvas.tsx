import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, FileCode2, Wrench, X } from 'lucide-react';
import type { OmpWorkspaceEvent } from './types';

interface OmpEventCanvasProps {
	events: OmpWorkspaceEvent[];
	accent: string;
	border: string;
	background: string;
	text: string;
	textDim: string;
	onResolveApproval: (requestId: string, approved: boolean) => void;
}

export function OmpEventCanvas({
	events,
	accent,
	border,
	background,
	text,
	textDim,
	onResolveApproval,
}: OmpEventCanvasProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [expandedThinking, setExpandedThinking] = useState<Set<string>>(() => new Set());
	const virtualizer = useVirtualizer({
		count: events.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: (index) => (events[index]?.kind === 'thinking' ? 52 : 96),
		overscan: 8,
		initialRect: { width: 1, height: 720 },
	});

	if (events.length === 0) {
		return (
			<section
				className="flex flex-1 items-center justify-center p-8"
				aria-label="OMP conversation"
			>
				<p className="max-w-sm text-center text-sm" style={{ color: textDim }}>
					This session is ready. Give OMP a precise next operation, attach context, or choose a
					mode.
				</p>
			</section>
		);
	}

	return (
		<section className="relative flex-1 min-h-0" aria-label="OMP conversation">
			<div ref={scrollRef} className="absolute inset-0 overflow-auto px-4 py-5" tabIndex={0}>
				<div
					style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}
				>
					{virtualizer.getVirtualItems().map((virtualRow) => {
						const event = events[virtualRow.index];
						if (!event) return null;
						return (
							<div
								key={event.id}
								ref={virtualizer.measureElement}
								data-index={virtualRow.index}
								className="absolute left-0 w-full pb-3"
								style={{ transform: `translateY(${virtualRow.start}px)` }}
							>
								<EventCard
									event={event}
									accent={accent}
									border={border}
									background={background}
									text={text}
									textDim={textDim}
									thinkingExpanded={expandedThinking.has(event.id)}
									onToggleThinking={() =>
										setExpandedThinking((current) => {
											const next = new Set(current);
											if (next.has(event.id)) next.delete(event.id);
											else next.add(event.id);
											return next;
										})
									}
									onResolveApproval={onResolveApproval}
								/>
							</div>
						);
					})}
				</div>
			</div>
		</section>
	);
}

interface EventCardProps extends Omit<OmpEventCanvasProps, 'events'> {
	event: OmpWorkspaceEvent;
	thinkingExpanded: boolean;
	onToggleThinking: () => void;
}

function EventCard({
	event,
	accent,
	border,
	background,
	text,
	textDim,
	thinkingExpanded,
	onToggleThinking,
	onResolveApproval,
}: EventCardProps) {
	const cardStyle = { borderColor: border, backgroundColor: background, color: text };
	if (event.kind === 'thinking') {
		return (
			<article className="border border-dashed" style={cardStyle}>
				<button
					type="button"
					onClick={onToggleThinking}
					className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs uppercase tracking-wider"
					style={{ color: textDim }}
					aria-expanded={thinkingExpanded}
					aria-label={thinkingExpanded ? 'Hide thinking' : 'Show thinking'}
				>
					{thinkingExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
					Thinking
				</button>
				{thinkingExpanded && <p className="px-3 pb-3 text-sm leading-6">{event.text}</p>}
			</article>
		);
	}
	if (event.kind === 'tool') {
		return (
			<article className="border-l-2 px-3 py-2" style={{ ...cardStyle, borderLeftColor: accent }}>
				<div
					className="flex items-center gap-2 text-xs uppercase tracking-wider"
					style={{ color: textDim }}
				>
					<Wrench size={14} /> {event.name} · {event.status}
				</div>
				{event.input && (
					<pre className="mt-2 overflow-auto text-xs" style={{ color: textDim }}>
						{event.input}
					</pre>
				)}
				{event.output && <p className="mt-2 text-sm">{event.output}</p>}
			</article>
		);
	}
	if (event.kind === 'approval') {
		return (
			<article className="border p-3" style={cardStyle}>
				<p className="text-sm">{event.description}</p>
				<div className="mt-3 flex gap-2">
					<button
						type="button"
						className="rounded px-3 py-1.5 text-xs font-semibold"
						style={{ backgroundColor: accent, color: background }}
						onClick={() => onResolveApproval(event.requestId, true)}
					>
						<Check className="mr-1 inline" size={13} /> Approve request
					</button>
					<button
						type="button"
						className="rounded border px-3 py-1.5 text-xs"
						style={{ borderColor: border, color: text }}
						onClick={() => onResolveApproval(event.requestId, false)}
					>
						<X className="mr-1 inline" size={13} /> Reject request
					</button>
				</div>
			</article>
		);
	}
	if (event.kind === 'artifact') {
		return (
			<article className="flex items-center gap-2 border p-3 text-sm" style={cardStyle}>
				<FileCode2 size={16} style={{ color: accent }} />
				<div>
					<span>{event.name}</span>
					<span className="ml-2 text-xs uppercase" style={{ color: textDim }}>
						{event.artifactType}
					</span>
				</div>
			</article>
		);
	}
	if (event.kind === 'usage') {
		return (
			<p className="px-1 text-xs" style={{ color: textDim }}>
				{event.inputTokens} in / {event.outputTokens} out
				{event.costUsd === undefined ? '' : ` · $${event.costUsd.toFixed(2)}`}
			</p>
		);
	}
	if (event.kind === 'error') {
		return (
			<article
				role="alert"
				className="border p-3 text-sm"
				style={{ borderColor: '#d86464', color: text }}
			>
				{event.message}
			</article>
		);
	}
	return (
		<article
			className={`border p-3 text-sm leading-6 ${event.kind === 'user' ? 'ml-auto max-w-[85%]' : 'mr-auto max-w-[92%]'}`}
			style={cardStyle}
		>
			<p className="mb-1 text-[10px] uppercase tracking-widest" style={{ color: textDim }}>
				{event.kind === 'user' ? 'Operator' : 'OMP'}
			</p>
			{event.text}
		</article>
	);
}
