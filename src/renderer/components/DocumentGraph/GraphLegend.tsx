/**
 * GraphLegend - Component explaining node types, edge types, and colors in the Document Graph.
 *
 * Displays a collapsible legend panel showing:
 * - Document nodes: Markdown files with their distinctive styling
 * - External link nodes: Aggregated external URLs by domain
 * - Internal edges: Solid lines connecting markdown documents
 * - External edges: Dashed lines connecting to external domains
 * - Selection state: Highlighted appearance when selected
 *
 * The legend is theme-aware and uses the same colors as the actual graph elements.
 */

import React, { useState, memo, useCallback } from 'react';
import { ChevronDown, ChevronUp, ArrowRight, AlertTriangle } from 'lucide-react';
import type { Theme } from '../../types';

/**
 * Props for the GraphLegend component
 */
export interface GraphLegendProps {
  /** Current theme */
  theme: Theme;
  /** Whether external links are currently shown in the graph */
  showExternalLinks: boolean;
  /** Initial expanded state (default: false) */
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

const NODE_ITEMS: NodeLegendItem[] = [
  {
    type: 'document',
    label: 'Document',
    description: 'Markdown file (size = connections)',
  },
  {
    type: 'external',
    label: 'External Link',
    description: 'External domain (smaller, dimmer)',
  },
];

const EDGE_ITEMS: EdgeLegendItem[] = [
  {
    type: 'internal',
    label: 'Internal Link',
    description: 'Connection between markdown documents',
  },
  {
    type: 'external',
    label: 'External Link',
    description: 'Connection to external domain',
  },
];

/**
 * Mini preview of a document node for the legend (force graph style)
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
      width={24}
      height={24}
      viewBox="0 0 24 24"
      role="img"
      aria-label={`Document node${selected ? ' (selected)' : ''}`}
    >
      <circle
        cx={12}
        cy={12}
        r={selected ? 9 : 8}
        fill={`${theme.colors.accent}BB`}
        stroke={selected ? theme.colors.accent : 'none'}
        strokeWidth={selected ? 2 : 0}
      />
    </svg>
  );
});

/**
 * Mini preview of an external link node for the legend (force graph style)
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
      width={24}
      height={24}
      viewBox="0 0 24 24"
      role="img"
      aria-label={`External link node${selected ? ' (selected)' : ''}`}
    >
      <circle
        cx={12}
        cy={12}
        r={selected ? 6 : 5}
        fill={`${theme.colors.textDim}88`}
        stroke={selected ? theme.colors.accent : 'none'}
        strokeWidth={selected ? 2 : 0}
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
  const strokeWidth = highlighted ? 2.5 : 1.5;
  const isDashed = type === 'external';

  return (
    <svg
      width={40}
      height={16}
      viewBox="0 0 40 16"
      role="img"
      aria-label={`${type === 'internal' ? 'Internal' : 'External'} link edge${highlighted ? ' (highlighted)' : ''}`}
    >
      <line
        x1={4}
        y1={8}
        x2={36}
        y2={8}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={isDashed ? '4 4' : undefined}
      />
      {/* Arrow head */}
      <path
        d="M32 4 L38 8 L32 12"
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
});

/**
 * GraphLegend component - Displays an explanation of graph elements
 */
export const GraphLegend = memo(function GraphLegend({
  theme,
  showExternalLinks,
  defaultExpanded = false,
}: GraphLegendProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  return (
    <div
      className="graph-legend absolute rounded-lg overflow-hidden shadow-lg"
      style={{
        backgroundColor: theme.colors.bgActivity,
        border: `1px solid ${theme.colors.border}`,
        maxWidth: 280,
        zIndex: 10,
        // Position at bottom center
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
      }}
      role="region"
      aria-label="Graph legend"
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
                    Click to select, highlights connections
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
                    width: 24,
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

          {/* Interaction hints */}
          <div
            className="pt-2 text-xs"
            style={{
              color: theme.colors.textDim,
              borderTop: `1px solid ${theme.colors.border}`,
              opacity: 0.7,
            }}
          >
            <div className="flex items-center gap-1">
              <ArrowRight size={10} />
              <span>Double-click to open</span>
            </div>
            <div className="flex items-center gap-1">
              <ArrowRight size={10} />
              <span>Right-click for context menu</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default GraphLegend;
