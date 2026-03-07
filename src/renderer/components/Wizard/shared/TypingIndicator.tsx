/**
 * TypingIndicator - Shows when agent is "thinking" with a typewriter effect filler phrase.
 * Rotates to a new phrase every 5 seconds after typing completes.
 *
 * Uses requestAnimationFrame for smoother animation timing.
 */

import { useEffect, useState } from 'react';
import type { Theme } from '../../../types';
import { formatAgentName } from './wizardHelpers';

export interface TypingIndicatorProps {
	theme: Theme;
	agentName: string;
	fillerPhrase: string;
	onRequestNewPhrase: () => void;
}

export function TypingIndicator({
	theme,
	agentName,
	fillerPhrase,
	onRequestNewPhrase,
}: TypingIndicatorProps): JSX.Element {
	const [displayedText, setDisplayedText] = useState('');
	const [isTypingComplete, setIsTypingComplete] = useState(false);

	// Typewriter effect using requestAnimationFrame for smoother animation
	useEffect(() => {
		const text = fillerPhrase || 'Thinking...';
		let currentIndex = 0;
		let lastTime = 0;
		const charDelay = 30; // 30ms per character for a natural typing speed
		let rafId: number;

		setDisplayedText('');
		setIsTypingComplete(false);

		function tick(timestamp: number) {
			if (!lastTime) lastTime = timestamp;
			const elapsed = timestamp - lastTime;

			if (elapsed >= charDelay) {
				if (currentIndex < text.length) {
					currentIndex++;
					setDisplayedText(text.slice(0, currentIndex));
					lastTime = timestamp;
					rafId = requestAnimationFrame(tick);
				} else {
					setIsTypingComplete(true);
				}
			} else {
				rafId = requestAnimationFrame(tick);
			}
		}

		rafId = requestAnimationFrame(tick);

		return () => cancelAnimationFrame(rafId);
	}, [fillerPhrase]);

	// Rotate to new phrase 5 seconds after typing completes
	useEffect(() => {
		if (!isTypingComplete) return;

		const rotateTimer = setTimeout(() => {
			onRequestNewPhrase();
		}, 5000);

		return () => clearTimeout(rotateTimer);
	}, [isTypingComplete, onRequestNewPhrase]);

	return (
		<div className="flex justify-start mb-4" data-testid="wizard-typing-indicator">
			<div
				className="max-w-[80%] rounded-lg rounded-bl-none px-4 py-3"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<div className="text-xs font-medium mb-2" style={{ color: theme.colors.accent }}>
					{formatAgentName(agentName)}
				</div>
				<div className="text-sm" style={{ color: theme.colors.textMain }}>
					<span
						className="italic"
						style={{ color: theme.colors.textDim }}
						data-testid="typing-indicator-text"
					>
						{displayedText}
					</span>
					<span
						className={`ml-1 inline-flex items-center gap-0.5 ${isTypingComplete ? 'opacity-100' : 'opacity-50'}`}
						data-testid="typing-indicator-dots"
					>
						<span
							className="w-1.5 h-1.5 rounded-full inline-block"
							style={{
								backgroundColor: theme.colors.accent,
								animation: 'wizard-typing-bounce 0.6s infinite',
								animationDelay: '0ms',
							}}
						/>
						<span
							className="w-1.5 h-1.5 rounded-full inline-block"
							style={{
								backgroundColor: theme.colors.accent,
								animation: 'wizard-typing-bounce 0.6s infinite',
								animationDelay: '150ms',
							}}
						/>
						<span
							className="w-1.5 h-1.5 rounded-full inline-block"
							style={{
								backgroundColor: theme.colors.accent,
								animation: 'wizard-typing-bounce 0.6s infinite',
								animationDelay: '300ms',
							}}
						/>
					</span>
				</div>
			</div>

			{/* Bounce animation keyframes */}
			<style>{`
				@keyframes wizard-typing-bounce {
					0%, 100% { transform: translateY(0); }
					50% { transform: translateY(-4px); }
				}
			`}</style>
		</div>
	);
}
