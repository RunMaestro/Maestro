/**
 * GraphLegend - Component explaining node types, edge types, and keyboard shortcuts in the Mind Map.
 *
 * Displays a collapsible legend panel showing:
 * - Document nodes: Card-style nodes with title and description
 * - External link nodes: Smaller pill-shaped nodes with domain
 * - Internal edges: Solid lines connecting markdown documents
 * - External edges: Dashed lines connecting to external domains
 * - Keyboard shortcuts: Arrow keys to navigate, Enter to recenter, O to open
 *
 * The legend is theme-aware and uses the same colors as the actual mind map elements.
 */

import React, { useState, memo, useCallback } from 'react';
import { ChevronDown, ChevronUp, AlertTriangle, ExternalLink } from 'lucide-react';
import type { Theme } from '../../types';

/**
 * Props for the GraphLegend component
 */
export interface GraphLegendProps {
  /** Current theme */
  theme: Theme;
  /** Whether external links are currently shown in the graph */
  showExternalLinks: boolean;
  /** Controlled expanded state (if provided, component is controlled) */
  isExpanded?: boolean;
  /** Callback when expanded state changes (required for controlled mode) */
  onExpandedChange?: (expanded: boolean) => void;
  /** Initial expanded state for uncontrolled mode (default: false) */
  defaultExpanded?: boolean;
}

/**
 * Legend item for a node type
 */
interface NodeLegendItem {
  type: 'document' | 'external';
  label: string;
  description: string;
}

/**
 * Legend item for an edge type
 */
interface EdgeLegendItem {
  type: 'internal' | 'external';
  label: string;
  description: string;
}

/**
 * Legend item for a keyboard shortcut
 */
interface KeyboardShortcutItem {
  keys: string;
  description: string;
}

const NODE_ITEMS: NodeLegendItem[] = [
  {
    type: 'document',
    label: 'Document',
    description: 'Card with title and description',
  },
  {
    type: 'external',
    label: 'External Link',
    description: 'Pill showing domain name',
  },
];

const EDGE_ITEMS: EdgeLegendItem[] = [
  {
    type: 'internal',
    label: 'Internal Link',
    description: 'Connection between markdown files',
  },
  {
    type: 'external',
    label: 'External Link',
    description: 'Connection to external domain',
  },
];

const KEYBOARD_SHORTCUTS: KeyboardShortcutItem[] = [
  {
    keys: '↑ ↓ ← →',
    description: 'Navigate between nodes',
  },
  {
    keys: 'Enter',
    description: 'Recenter on focused node',
  },
  {
    keys: 'O',
    description: 'Open file in preview',
  },
];

/**
 * Mini preview of a document node card for the legend (mind map style)
 */
const DocumentNodePreview = memo(function DocumentNodePreview({
  theme,
  selected = false,
}: {
  theme: Theme;
  selected?: boolean;
}) {
  return (
    <svg
      width={36}
      height={24}
      viewBox="0 0 36 24"
      role="img"
      aria-label={`Document node card${selected ? ' (selected)' : ''}`}
    >
      {/* Card background */}
      <rect
        x={1}
        y={1}
        width={34}
        height={22}
        rx={4}
        fill={selected ? `${theme.colors.accent}30` : theme.colors.bgActivity}
        stroke={selected ? theme.colors.accent : theme.colors.border}
        strokeWidth={selected ? 1.5 : 1}
      />
      {/* Title line */}
      <rect
        x={5}
        y={6}
        width={18}
        height={3}
        rx={1}
        fill={theme.colors.textMain}
      />
      {/* Description line */}
      <rect
        x={5}
        y={12}
        width={22}
        height={2}
        rx={0.5}
        fill={theme.colors.textDim}
        opacity={0.6}
      />
      {/* Description line 2 */}
      <rect
        x={5}
        y={16}
        width={14}
        height={2}
        rx={0.5}
        fill={theme.colors.textDim}
        opacity={0.4}
      />
      {/* Open icon */}
      <g transform="translate(28, 4)">
        <ExternalLink size={6} style={{ color: theme.colors.textDim }} />
      </g>
    </svg>
  );
});

/**
 * Mini preview of an external link node pill for the legend (mind map style)
 */
const ExternalNodePreview = memo(function ExternalNodePreview({
  theme,
  selected = false,
}: {
  theme: Theme;
  selected?: boolean;
}) {
  return (
    <svg
      width={36}
      height={18}
      viewBox="0 0 36 18"
      role="img"
      aria-label={`External link node pill${selected ? ' (selected)' : ''}`}
    >
      {/* Pill background */}
      <rect
        x={1}
        y={2}
        width={34}
        height={14}
        rx={7}
        fill={theme.colors.bgMain}
        stroke={selected ? theme.colors.accent : `${theme.colors.border}80`}
        strokeWidth={1}
      />
      {/* Domain text representation */}
      <rect
        x={8}
        y={7}
        width={20}
        height={4}
        rx={1}
        fill={theme.colors.textDim}
        opacity={0.8}
      />
    </svg>
  );
});

/**
 * Mini preview of an edge for the legend
 */
const EdgePreview = memo(function EdgePreview({
  theme,
  type,
  highlighted = false,
}: {
  theme: Theme;
  type: 'internal' | 'external';
  highlighted?: boolean;
}) {
  const strokeColor = highlighted ? theme.colors.accent : theme.colors.textDim;
  const strokeWidth = highlighted ? 2 : 1.5;
  const isDashed = type === 'external';
  const opacity = type === 'external' && !highlighted ? 0.5 : 0.8;

  return (
    <svg
      width={40}
      height={16}
      viewBox="0 0 40 16"
      role="img"
      aria-label={`${type === 'internal' ? 'Internal' : 'External'} link edge${highlighted ? ' (highlighted)' : ''}`}
    >
      {/* Curved bezier path to match mind map style */}
      <path
        d={isDashed ? 'M4,8 C15,8 25,8 36,8' : 'M4,8 C12,3 28,13 36,8'}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={isDashed ? '4 3' : undefined}
        opacity={opacity}
        strokeLinecap="round"
      />
    </svg>
  );
});

/**
 * Keyboard shortcut badge
 */
const KeyboardBadge = memo(function KeyboardBadge({
  keys,
  theme,
}: {
  keys: string;
  theme: Theme;
}) {
  return (
    <span
      className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-mono"
      style={{
        backgroundColor: `${theme.colors.textDim}15`,
        color: theme.colors.textMain,
        border: `1px solid ${theme.colors.border}`,
        minWidth: 24,
      }}
    >
      {keys}
    </span>
  );
});

/**
 * GraphLegend component - Displays an explanation of mind map elements
 */
export const GraphLegend = memo(function GraphLegend({
  theme,
  showExternalLinks,
  isExpanded: controlledExpanded,
  onExpandedChange,
  defaultExpanded = false,
}: GraphLegendProps) {
  // Support both controlled and uncontrolled modes
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const isControlled = controlledExpanded !== undefined;
  const isExpanded = isControlled ? controlledExpanded : uncontrolledExpanded;

  const toggleExpanded = useCallback(() => {
    const newValue = !isExpanded;
    if (onExpandedChange) {
      onExpandedChange(newValue);
    }
    if (!isControlled) {
      setUncontrolledExpanded(newValue);
    }
  }, [isExpanded, onExpandedChange, isControlled]);

  return (
    <div
      className="graph-legend absolute rounded-lg overflow-hidden shadow-lg"
      style={{
        backgroundColor: theme.colors.bgActivity,
        border: `1px solid ${theme.colors.border}`,
        maxWidth: 300,
        zIndex: 10,
        // Position at bottom center
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
      }}
      role="region"
      aria-label="Mind map legend"
    >
      {/* Header - Always visible */}
      <button
        onClick={toggleExpanded}
        className="w-full flex items-center justify-between px-3 py-2 transition-colors"
        style={{
          backgroundColor: `${theme.colors.accent}10`,
          color: theme.colors.textMain,
        }}
        aria-expanded={isExpanded}
        aria-controls="legend-content"
      >
        <span className="text-xs font-medium">Legend</span>
        {isExpanded ? (
          <ChevronDown size={14} style={{ color: theme.colors.textDim }} />
        ) : (
          <ChevronUp size={14} style={{ color: theme.colors.textDim }} />
        )}
      </button>

      {/* Content - Collapsible */}
      {isExpanded && (
        <div
          id="legend-content"
          className="px-3 py-2 space-y-3"
          style={{ borderTop: `1px solid ${theme.colors.border}` }}
        >
          {/* Node Types Section */}
          <div>
            <h4
              className="text-xs font-medium mb-2"
              style={{ color: theme.colors.textDim }}
            >
              Node Types
            </h4>
            <div className="space-y-2">
              {/* Document node */}
              <div className="flex items-center gap-2">
                <DocumentNodePreview theme={theme} />
                <div className="flex-1 min-w-0">
                  <span
                    className="text-xs font-medium block"
                    style={{ color: theme.colors.textMain }}
                  >
                    {NODE_ITEMS[0].label}
                  </span>
                  <span
                    className="text-xs block truncate"
                    style={{ color: theme.colors.textDim, opacity: 0.8 }}
                  >
                    {NODE_ITEMS[0].description}
                  </span>
                </div>
              </div>

              {/* External node - only show if external links are enabled */}
              {showExternalLinks && (
                <div className="flex items-center gap-2">
                  <ExternalNodePreview theme={theme} />
                  <div className="flex-1 min-w-0">
                    <span
                      className="text-xs font-medium block"
                      style={{ color: theme.colors.textMain }}
                    >
                      {NODE_ITEMS[1].label}
                    </span>
                    <span
                      className="text-xs block truncate"
                      style={{ color: theme.colors.textDim, opacity: 0.8 }}
                    >
                      {NODE_ITEMS[1].description}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Edge Types Section */}
          <div>
            <h4
              className="text-xs font-medium mb-2"
              style={{ color: theme.colors.textDim }}
            >
              Connection Types
            </h4>
            <div className="space-y-2">
              {/* Internal edge */}
              <div className="flex items-center gap-2">
                <EdgePreview theme={theme} type="internal" />
                <div className="flex-1 min-w-0">
                  <span
                    className="text-xs font-medium block"
                    style={{ color: theme.colors.textMain }}
                  >
                    {EDGE_ITEMS[0].label}
                  </span>
                  <span
                    className="text-xs block truncate"
                    style={{ color: theme.colors.textDim, opacity: 0.8 }}
                  >
                    {EDGE_ITEMS[0].description}
                  </span>
                </div>
              </div>

              {/* External edge - only show if external links are enabled */}
              {showExternalLinks && (
                <div className="flex items-center gap-2">
                  <EdgePreview theme={theme} type="external" />
                  <div className="flex-1 min-w-0">
                    <span
                      className="text-xs font-medium block"
                      style={{ color: theme.colors.textMain }}
                    >
                      {EDGE_ITEMS[1].label}
                    </span>
                    <span
                      className="text-xs block truncate"
                      style={{ color: theme.colors.textDim, opacity: 0.8 }}
                    >
                      {EDGE_ITEMS[1].description}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Selection State Section */}
          <div>
            <h4
              className="text-xs font-medium mb-2"
              style={{ color: theme.colors.textDim }}
            >
              Selection
            </h4>
            <div className="space-y-2">
              {/* Selected node preview */}
              <div className="flex items-center gap-2">
                <DocumentNodePreview theme={theme} selected />
                <div className="flex-1 min-w-0">
                  <span
                    className="text-xs font-medium block"
                    style={{ color: theme.colors.textMain }}
                  >
                    Selected Node
                  </span>
                  <span
                    className="text-xs block truncate"
                    style={{ color: theme.colors.textDim, opacity: 0.8 }}
                  >
                    Click or navigate to select
                  </span>
                </div>
              </div>

              {/* Highlighted edge preview */}
              <div className="flex items-center gap-2">
                <EdgePreview theme={theme} type="internal" highlighted />
                <div className="flex-1 min-w-0">
                  <span
                    className="text-xs font-medium block"
                    style={{ color: theme.colors.textMain }}
                  >
                    Connected Edge
                  </span>
                  <span
                    className="text-xs block truncate"
                    style={{ color: theme.colors.textDim, opacity: 0.8 }}
                  >
                    Edges to/from selected node
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Status Indicators Section */}
          <div>
            <h4
              className="text-xs font-medium mb-2"
              style={{ color: theme.colors.textDim }}
            >
              Status Indicators
            </h4>
            <div className="space-y-2">
              {/* Broken links warning */}
              <div className="flex items-center gap-2">
                <div
                  className="flex items-center justify-center rounded"
                  style={{
                    width: 36,
                    height: 24,
                    backgroundColor: '#f59e0b20',
                  }}
                  role="img"
                  aria-label="Broken links warning indicator"
                >
                  <AlertTriangle size={14} style={{ color: '#f59e0b' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <span
                    className="text-xs font-medium block"
                    style={{ color: theme.colors.textMain }}
                  >
                    Broken Links
                  </span>
                  <span
                    className="text-xs block truncate"
                    style={{ color: theme.colors.textDim, opacity: 0.8 }}
                  >
                    Links to non-existent files
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Keyboard shortcuts */}
          <div
            className="pt-2"
            style={{
              borderTop: `1px solid ${theme.colors.border}`,
            }}
          >
            <h4
              className="text-xs font-medium mb-2"
              style={{ color: theme.colors.textDim }}
            >
              Keyboard Shortcuts
            </h4>
            <div className="space-y-1.5">
              {KEYBOARD_SHORTCUTS.map((shortcut) => (
                <div
                  key={shortcut.keys}
                  className="flex items-center justify-between gap-2"
                >
                  <KeyboardBadge keys={shortcut.keys} theme={theme} />
                  <span
                    className="text-xs flex-1 text-right"
                    style={{ color: theme.colors.textDim, opacity: 0.8 }}
                  >
                    {shortcut.description}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Mouse interaction hints */}
          <div
            className="pt-2 text-xs"
            style={{
              color: theme.colors.textDim,
              borderTop: `1px solid ${theme.colors.border}`,
              opacity: 0.7,
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="font-medium">Click</span>
              <span>Select node</span>
            </div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-medium">Double-click</span>
              <span>Recenter view</span>
            </div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-medium">Right-click</span>
              <span>Context menu</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-medium">Scroll</span>
              <span>Zoom in/out</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default GraphLegend;
