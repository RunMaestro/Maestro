/**
 * AustinFactsDisplay.tsx
 *
 * Fun loading content display showing rotating Austin, TX facts.
 * Rotates facts every 4-5 seconds with fade transition.
 * Position in bottom-right corner of the generation view.
 * Show only while `isVisible` is true.
 *
 * Uses existing Austin facts from the wizard services module.
 */

import { useState, useEffect } from 'react';
import type { Theme } from '../../types';
import {
  getNextAustinFact,
  parseFactWithLinks,
  type FactSegment,
} from '../Wizard/services/austinFacts';

/**
 * Props for AustinFactsDisplay
 */
export interface AustinFactsDisplayProps {
  /** Theme for styling */
  theme: Theme;
  /** Whether the facts display is visible (defaults to true) */
  isVisible?: boolean;
  /** Whether to center the display instead of bottom-right corner */
  centered?: boolean;
}

/**
 * Texas Flag SVG component
 */
function TexasFlag({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}): JSX.Element {
  return (
    <svg viewBox="0 0 150 100" className={className} style={style}>
      {/* Blue vertical stripe */}
      <rect x="0" y="0" width="50" height="100" fill="#002868" />
      {/* White horizontal stripe */}
      <rect x="50" y="0" width="100" height="50" fill="#FFFFFF" />
      {/* Red horizontal stripe */}
      <rect x="50" y="50" width="100" height="50" fill="#BF0A30" />
      {/* White five-pointed star */}
      <polygon
        points="25,15 29.5,30 45,30 32.5,40 37,55 25,45 13,55 17.5,40 5,30 20.5,30"
        fill="#FFFFFF"
      />
    </svg>
  );
}

/**
 * Get the plain text version of a fact (for typewriter character counting)
 * Strips markdown link syntax: [text](url) -> text
 */
function getFactPlainText(fact: string): string {
  return fact.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

/**
 * Render fact segments with proper link handling
 * Supports typewriter effect by only showing up to displayLength characters
 */
function FactContent({
  segments,
  displayLength,
  theme,
}: {
  segments: FactSegment[];
  displayLength: number;
  theme: Theme;
}): JSX.Element {
  let charCount = 0;
  const elements: JSX.Element[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (segment.type === 'text') {
      const segmentLength = segment.content.length;
      const startChar = charCount;
      const endChar = charCount + segmentLength;

      if (displayLength > startChar) {
        const visibleChars = Math.min(displayLength - startChar, segmentLength);
        elements.push(
          <span key={i}>{segment.content.slice(0, visibleChars)}</span>
        );
      }
      charCount = endChar;
    } else if (segment.type === 'link') {
      const segmentLength = segment.text.length;
      const startChar = charCount;
      const endChar = charCount + segmentLength;

      if (displayLength > startChar) {
        const visibleChars = Math.min(displayLength - startChar, segmentLength);
        const isFullyVisible = visibleChars === segmentLength;

        if (isFullyVisible) {
          // Render as clickable link once fully typed
          elements.push(
            <a
              key={i}
              href={segment.url}
              onClick={(e) => {
                e.preventDefault();
                // Open in system browser
                if (!window.maestro?.shell?.openExternal?.(segment.url)) {
                  window.open(segment.url, '_blank');
                }
              }}
              className="underline hover:opacity-80 cursor-pointer transition-opacity"
              style={{ color: theme.colors.accent }}
            >
              {segment.text}
            </a>
          );
        } else {
          // Still typing - show as regular text with accent color
          elements.push(
            <span key={i} style={{ color: theme.colors.accent }}>
              {segment.text.slice(0, visibleChars)}
            </span>
          );
        }
      }
      charCount = endChar;
    }
  }

  return <>{elements}</>;
}

/**
 * AustinFactsDisplay - Shows rotating Austin, TX facts during document generation
 *
 * Features:
 * - Typewriter effect for displaying facts
 * - Rotates to new fact 4-5 seconds after typing completes
 * - Fade transition between facts
 * - Positioned in bottom-right corner
 * - Supports markdown-style links that open in system browser
 * - Only visible when isVisible prop is true
 */
export function AustinFactsDisplay({
  theme,
  isVisible = true,
  centered = false,
}: AustinFactsDisplayProps): JSX.Element | null {
  const [currentFact, setCurrentFact] = useState(() => getNextAustinFact());
  const [displayLength, setDisplayLength] = useState(0);
  const [isTypingComplete, setIsTypingComplete] = useState(false);
  const [isFading, setIsFading] = useState(false);

  // Parse the fact into segments (text and links)
  const segments = parseFactWithLinks(currentFact);
  const plainText = getFactPlainText(currentFact);

  // Typewriter effect - types one character at a time
  useEffect(() => {
    let currentIndex = 0;
    setDisplayLength(0);
    setIsTypingComplete(false);
    setIsFading(false);

    const typeInterval = setInterval(() => {
      if (currentIndex < plainText.length) {
        currentIndex++;
        setDisplayLength(currentIndex);
      } else {
        setIsTypingComplete(true);
        clearInterval(typeInterval);
      }
    }, 25); // 25ms per character for readable typing speed

    return () => clearInterval(typeInterval);
  }, [currentFact, plainText.length]);

  // Rotate to new fact 4-5 seconds after typing completes (with fade)
  useEffect(() => {
    if (!isTypingComplete) return;

    const rotateTimer = setTimeout(() => {
      // Start fade out
      setIsFading(true);

      // After fade out, change fact and fade back in
      setTimeout(() => {
        setCurrentFact(getNextAustinFact());
      }, 300); // 300ms for fade out
    }, 4500); // 4.5 seconds display time

    return () => clearTimeout(rotateTimer);
  }, [isTypingComplete]);

  if (!isVisible) return null;

  return (
    <div
      className={centered
        ? "px-4 py-3 rounded-lg"
        : "absolute bottom-4 right-4 px-4 py-3 rounded-lg"}
      style={{
        backgroundColor: `${theme.colors.accent}10`,
        border: `1px solid ${theme.colors.accent}30`,
        maxWidth: '320px',
        opacity: isFading ? 0 : 1,
        transition: 'opacity 300ms ease-in-out',
      }}
    >
      <div className="flex items-start gap-3">
        <TexasFlag className="w-8 h-6 shrink-0 mt-0.5" style={{ opacity: 0.85 }} />
        <div className="flex-1 min-w-0">
          <p
            className="text-[10px] font-medium uppercase tracking-wide mb-1"
            style={{ color: theme.colors.accent }}
          >
            Austin Facts
          </p>
          <p
            className="text-xs leading-relaxed"
            style={{
              color: theme.colors.textMain,
              minHeight: '2.5em',
            }}
          >
            <FactContent
              segments={segments}
              displayLength={displayLength}
              theme={theme}
            />
            {!isTypingComplete && (
              <span
                className="inline-block w-0.5 h-3 ml-0.5 animate-pulse"
                style={{ backgroundColor: theme.colors.accent }}
              />
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

export default AustinFactsDisplay;
