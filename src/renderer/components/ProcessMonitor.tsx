import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronRight, ChevronDown, ChevronUp, X, Activity, RefreshCw } from 'lucide-react';
import type { Session, Group, Theme } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

interface ProcessMonitorProps {
  theme: Theme;
  sessions: Session[];
  groups: Group[];
  onClose: () => void;
  onNavigateToSession?: (sessionId: string, tabId?: string) => void;
}

interface ActiveProcess {
  sessionId: string;
  toolType: string;
  pid: number;
  cwd: string;
  isTerminal: boolean;
  isBatchMode: boolean;
}

interface ProcessNode {
  id: string;
  type: 'group' | 'session' | 'process';
  label: string;
  emoji?: string;
  sessionId?: string;
  pid?: number;
  processType?: 'ai' | 'terminal' | 'batch' | 'synopsis';
  isAlive?: boolean;
  expanded?: boolean;
  children?: ProcessNode[];
  toolType?: string;
  cwd?: string;
  claudeSessionId?: string; // UUID octet from the Claude session (for AI processes)
  tabId?: string; // Tab ID for navigation to specific AI tab
}

export function ProcessMonitor(props: ProcessMonitorProps) {
  const { theme, sessions, groups, onClose, onNavigateToSession } = props;
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeProcesses, setActiveProcesses] = useState<ActiveProcess[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasExpandedInitially, setHasExpandedInitially] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedNodeRef = useRef<HTMLButtonElement | HTMLDivElement>(null);
  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
  const layerIdRef = useRef<string>();

  // Fetch active processes from ProcessManager
  const fetchActiveProcesses = useCallback(async (showRefresh = false) => {
    if (showRefresh) {
      setIsRefreshing(true);
    }
    try {
      const processes = await window.maestro.process.getActiveProcesses();
      setActiveProcesses(processes);
    } catch (error) {
      console.error('Failed to fetch active processes:', error);
    } finally {
      setIsLoading(false);
      // Keep refresh spinner visible for at least 500ms for visual feedback
      if (showRefresh) {
        setTimeout(() => setIsRefreshing(false), 500);
      }
    }
  }, []);

  // Register layer on mount
  useEffect(() => {
    const layerId = registerLayer({
      id: 'process-monitor',
      type: 'modal',
      priority: MODAL_PRIORITIES.PROCESS_MONITOR,
      blocksLowerLayers: true,
      capturesFocus: true,
      focusTrap: 'strict',
      ariaLabel: 'System Processes',
      onEscape: () => {}
    });
    layerIdRef.current = layerId;
    return () => unregisterLayer(layerId);
  }, [registerLayer, unregisterLayer]);

  // Update handler when onClose changes
  useEffect(() => {
    if (layerIdRef.current) {
      updateLayerHandler(layerIdRef.current, onClose);
    }
  }, [onClose, updateLayerHandler]);

  // Fetch processes on mount and poll for updates
  useEffect(() => {
    fetchActiveProcesses();

    // Poll every 2 seconds to keep process list updated
    const interval = setInterval(fetchActiveProcesses, 2000);
    return () => clearInterval(interval);
  }, [fetchActiveProcesses]);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Scroll selected node into view
  useEffect(() => {
    selectedNodeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedNodeId]);

  const toggleNode = (nodeId: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  // Collect all expandable node IDs from the tree
  const getAllExpandableNodeIds = (nodes: ProcessNode[]): string[] => {
    const ids: string[] = [];
    const traverse = (nodeList: ProcessNode[]) => {
      nodeList.forEach(node => {
        if (node.children && node.children.length > 0) {
          ids.push(node.id);
          traverse(node.children);
        }
      });
    };
    traverse(nodes);
    return ids;
  };

  const expandAll = () => {
    const processTree = buildProcessTree();
    const allIds = getAllExpandableNodeIds(processTree);
    setExpandedNodes(new Set(allIds));
  };

  const collapseAll = () => {
    setExpandedNodes(new Set());
  };

  // Parse the base session ID from a process session ID
  // Process session IDs are formatted as:
  // - {baseSessionId}-ai (legacy)
  // - {baseSessionId}-ai-{tabId} (tab-based AI)
  // - {baseSessionId}-terminal
  // - {baseSessionId}-batch-{timestamp}
  // - {baseSessionId}-synopsis-{timestamp}
  const parseBaseSessionId = (processSessionId: string): string => {
    // Check for batch mode pattern: {sessionId}-batch-{timestamp}
    const batchMatch = processSessionId.match(/^(.+)-batch-\d+$/);
    if (batchMatch) {
      return batchMatch[1];
    }
    // Check for synopsis pattern: {sessionId}-synopsis-{timestamp}
    const synopsisMatch = processSessionId.match(/^(.+)-synopsis-\d+$/);
    if (synopsisMatch) {
      return synopsisMatch[1];
    }
    // Check for tab-based AI pattern: {sessionId}-ai-{tabId}
    const aiTabMatch = processSessionId.match(/^(.+)-ai-.+$/);
    if (aiTabMatch) {
      return aiTabMatch[1];
    }
    // Try to match common suffixes
    const suffixes = ['-ai', '-terminal'];
    for (const suffix of suffixes) {
      if (processSessionId.endsWith(suffix)) {
        return processSessionId.slice(0, -suffix.length);
      }
    }
    // Return as-is if no known suffix
    return processSessionId;
  };

  // Determine process type from session ID
  const getProcessType = (processSessionId: string): 'ai' | 'terminal' | 'batch' | 'synopsis' => {
    if (processSessionId.endsWith('-terminal')) return 'terminal';
    if (processSessionId.match(/-batch-\d+$/)) return 'batch';
    if (processSessionId.match(/-synopsis-\d+$/)) return 'synopsis';
    return 'ai';
  };

  // Extract tab ID from process session ID (format: {sessionId}-ai-{tabId})
  const parseTabId = (processSessionId: string): string | null => {
    const match = processSessionId.match(/-ai-([^-]+)$/);
    return match ? match[1] : null;
  };

  // Build the process tree using real active processes
  const buildProcessTree = (): ProcessNode[] => {
    const tree: ProcessNode[] = [];

    // Group sessions by group
    const sessionsByGroup = new Map<string, Session[]>();
    const ungroupedSessions: Session[] = [];

    sessions.forEach(session => {
      if (session.groupId) {
        const existing = sessionsByGroup.get(session.groupId) || [];
        sessionsByGroup.set(session.groupId, [...existing, session]);
      } else {
        ungroupedSessions.push(session);
      }
    });

    // Map active processes to their base session IDs
    const processesMap = new Map<string, ActiveProcess[]>();
    activeProcesses.forEach(proc => {
      const baseId = parseBaseSessionId(proc.sessionId);
      const existing = processesMap.get(baseId) || [];
      processesMap.set(baseId, [...existing, proc]);
    });

    // Build session node with active processes
    const buildSessionNode = (session: Session): ProcessNode => {
      const sessionNode: ProcessNode = {
        id: `session-${session.id}`,
        type: 'session',
        label: session.name,
        sessionId: session.id,
        expanded: expandedNodes.has(`session-${session.id}`),
        children: []
      };

      // Get active processes for this session
      const sessionProcesses = processesMap.get(session.id) || [];

      // Add each active process
      sessionProcesses.forEach(proc => {
        const processType = getProcessType(proc.sessionId);
        let label: string;
        if (processType === 'terminal') {
          label = 'Terminal Shell';
        } else if (processType === 'batch') {
          label = `AI Agent (${proc.toolType}) - Batch`;
        } else if (processType === 'synopsis') {
          label = `AI Agent (${proc.toolType}) - Synopsis`;
        } else {
          label = `AI Agent (${proc.toolType})`;
        }

        // Look up Claude session ID from the tab if this is an AI process
        let claudeSessionId: string | undefined;
        let tabId: string | undefined;
        if (processType === 'ai' || processType === 'batch' || processType === 'synopsis') {
          tabId = parseTabId(proc.sessionId) || undefined;
          if (session.aiTabs) {
            // First try to find by tab ID
            if (tabId) {
              const tab = session.aiTabs.find(t => t.id === tabId);
              if (tab?.claudeSessionId) {
                claudeSessionId = tab.claudeSessionId;
              }
            }
            // Fall back to active tab if no tab ID match
            if (!claudeSessionId) {
              const activeTab = session.aiTabs.find(t => t.id === session.activeTabId);
              if (activeTab?.claudeSessionId) {
                claudeSessionId = activeTab.claudeSessionId;
                tabId = activeTab.id;
              }
            }
          }
        }

        sessionNode.children!.push({
          id: `process-${proc.sessionId}`,
          type: 'process',
          label,
          pid: proc.pid,
          processType,
          sessionId: session.id,
          isAlive: true, // Active processes are always alive
          toolType: proc.toolType,
          cwd: proc.cwd,
          claudeSessionId,
          tabId
        });
      });

      // Only return session node if it has active processes
      return sessionNode;
    };

    // Add grouped sessions (only include sessions with active processes)
    groups.forEach(group => {
      const groupSessions = sessionsByGroup.get(group.id) || [];
      const sessionNodes = groupSessions
        .map(session => buildSessionNode(session))
        .filter(node => node.children && node.children.length > 0);

      // Only add group if it has sessions with active processes
      if (sessionNodes.length > 0) {
        const groupNode: ProcessNode = {
          id: `group-${group.id}`,
          type: 'group',
          label: group.name,
          emoji: group.emoji,
          expanded: expandedNodes.has(`group-${group.id}`),
          children: sessionNodes
        };
        tree.push(groupNode);
      }
    });

    // Add ungrouped sessions (root level, only with active processes)
    if (ungroupedSessions.length > 0) {
      const sessionNodes = ungroupedSessions
        .map(session => buildSessionNode(session))
        .filter(node => node.children && node.children.length > 0);

      if (sessionNodes.length > 0) {
        const rootNode: ProcessNode = {
          id: 'group-root',
          type: 'group',
          label: 'UNGROUPED',
          emoji: '📁',
          expanded: expandedNodes.has('group-root'),
          children: sessionNodes
        };
        tree.push(rootNode);
      }
    }

    return tree;
  };

  // Expand all nodes by default on initial load
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isLoading && !hasExpandedInitially) {
      // Build tree and get all expandable node IDs
      const tree = buildProcessTree();
      const allIds = getAllExpandableNodeIds(tree);
      setExpandedNodes(new Set(allIds));
      setHasExpandedInitially(true);
    }
  }, [isLoading, hasExpandedInitially, activeProcesses]);

  // Build flat list of visible nodes for keyboard navigation
  const getVisibleNodes = (nodes: ProcessNode[]): ProcessNode[] => {
    const result: ProcessNode[] = [];
    const traverse = (nodeList: ProcessNode[]) => {
      nodeList.forEach(node => {
        result.push(node);
        if (node.children && node.children.length > 0 && expandedNodes.has(node.id)) {
          traverse(node.children);
        }
      });
    };
    traverse(nodes);
    return result;
  };

  // Keyboard navigation handler
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const processTree = buildProcessTree();
    const visibleNodes = getVisibleNodes(processTree);

    if (visibleNodes.length === 0) return;

    const currentIndex = selectedNodeId
      ? visibleNodes.findIndex(n => n.id === selectedNodeId)
      : -1;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (currentIndex < visibleNodes.length - 1) {
          setSelectedNodeId(visibleNodes[currentIndex + 1].id);
        } else if (currentIndex === -1 && visibleNodes.length > 0) {
          // If nothing selected, select first node
          setSelectedNodeId(visibleNodes[0].id);
        }
        break;

      case 'ArrowUp':
        e.preventDefault();
        if (currentIndex > 0) {
          setSelectedNodeId(visibleNodes[currentIndex - 1].id);
        } else if (currentIndex === -1 && visibleNodes.length > 0) {
          // If nothing selected, select last node
          setSelectedNodeId(visibleNodes[visibleNodes.length - 1].id);
        }
        break;

      case 'ArrowRight':
        e.preventDefault();
        if (selectedNodeId) {
          const selectedNode = visibleNodes.find(n => n.id === selectedNodeId);
          if (selectedNode && selectedNode.children && selectedNode.children.length > 0) {
            if (!expandedNodes.has(selectedNodeId)) {
              // Expand the node
              setExpandedNodes(prev => new Set([...prev, selectedNodeId]));
            } else {
              // Already expanded, move to first child
              setSelectedNodeId(selectedNode.children[0].id);
            }
          }
        }
        break;

      case 'ArrowLeft':
        e.preventDefault();
        if (selectedNodeId) {
          const selectedNode = visibleNodes.find(n => n.id === selectedNodeId);
          if (selectedNode && expandedNodes.has(selectedNodeId) && selectedNode.children && selectedNode.children.length > 0) {
            // Collapse the node
            setExpandedNodes(prev => {
              const next = new Set(prev);
              next.delete(selectedNodeId);
              return next;
            });
          } else {
            // Move to parent - find parent by checking which node contains this as a child
            const findParent = (nodes: ProcessNode[], targetId: string, parent: ProcessNode | null = null): ProcessNode | null => {
              for (const node of nodes) {
                if (node.id === targetId) return parent;
                if (node.children) {
                  const found = findParent(node.children, targetId, node);
                  if (found !== null) return found;
                }
              }
              return null;
            };
            const parent = findParent(processTree, selectedNodeId);
            if (parent) {
              setSelectedNodeId(parent.id);
            }
          }
        }
        break;

      case 'Enter':
      case ' ':
        e.preventDefault();
        if (selectedNodeId) {
          const selectedNode = visibleNodes.find(n => n.id === selectedNodeId);
          if (selectedNode && selectedNode.children && selectedNode.children.length > 0) {
            toggleNode(selectedNodeId);
          }
        }
        break;

      case 'r':
      case 'R':
        e.preventDefault();
        fetchActiveProcesses(true);
        break;
    }
  };

  const renderNode = (node: ProcessNode, depth: number = 0): React.ReactNode => {
    const isExpanded = expandedNodes.has(node.id);
    const hasChildren = node.children && node.children.length > 0;
    const paddingLeft = depth * 20 + 16; // 20px per depth level + 16px base
    const isSelected = selectedNodeId === node.id;

    if (node.type === 'group') {
      return (
        <div key={node.id}>
          <button
            ref={isSelected ? selectedNodeRef as React.RefObject<HTMLButtonElement> : null}
            onClick={() => { setSelectedNodeId(node.id); toggleNode(node.id); }}
            className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-opacity-5"
            style={{
              paddingLeft: `${paddingLeft}px`,
              backgroundColor: isSelected ? `${theme.colors.accent}25` : 'transparent',
              color: theme.colors.textMain,
              outline: isSelected ? `2px solid ${theme.colors.accent}` : 'none',
              outlineOffset: '-2px'
            }}
            onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`; }}
            onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent'; }}
          >
            {hasChildren && (
              isExpanded ?
                <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.textDim }} /> :
                <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.textDim }} />
            )}
            {!hasChildren && <div className="w-4 h-4 flex-shrink-0" />}
            <span className="mr-2">{node.emoji}</span>
            <span className="font-medium flex-1 truncate">{node.label}</span>
            {hasChildren && (
              <span className="text-xs flex-shrink-0" style={{ color: theme.colors.textDim }}>
                {node.children!.length} {node.children!.length === 1 ? 'session' : 'sessions'}
              </span>
            )}
          </button>
          {isExpanded && hasChildren && (
            <div>
              {node.children!.map(child => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    if (node.type === 'session') {
      // Count active processes for this session
      const activeCount = node.children?.filter(c => c.isAlive).length || 0;

      return (
        <div key={node.id}>
          <button
            ref={isSelected ? selectedNodeRef as React.RefObject<HTMLButtonElement> : null}
            onClick={() => { setSelectedNodeId(node.id); toggleNode(node.id); }}
            className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-opacity-5"
            style={{
              paddingLeft: `${paddingLeft}px`,
              backgroundColor: isSelected ? `${theme.colors.accent}25` : 'transparent',
              color: theme.colors.textMain,
              outline: isSelected ? `2px solid ${theme.colors.accent}` : 'none',
              outlineOffset: '-2px'
            }}
            onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`; }}
            onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent'; }}
          >
            {hasChildren && (
              isExpanded ?
                <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.textDim }} /> :
                <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.textDim }} />
            )}
            {!hasChildren && <div className="w-4 h-4 flex-shrink-0" />}
            <Activity className="w-4 h-4 flex-shrink-0" style={{ color: activeCount > 0 ? theme.colors.success : theme.colors.textDim }} />
            <span className="flex-1 truncate">{node.label}</span>
            <span className="text-xs flex items-center gap-2 flex-shrink-0" style={{ color: theme.colors.textDim }}>
              {activeCount > 0 && (
                <span
                  className="px-1.5 py-0.5 rounded text-xs"
                  style={{ backgroundColor: `${theme.colors.success}20`, color: theme.colors.success }}
                >
                  {activeCount} running
                </span>
              )}
              <span>Session: {node.sessionId?.substring(0, 8)}...</span>
            </span>
          </button>
          {isExpanded && hasChildren && (
            <div>
              {node.children!.map(child => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    if (node.type === 'process') {
      return (
        <div
          ref={isSelected ? selectedNodeRef as React.RefObject<HTMLDivElement> : null}
          key={node.id}
          tabIndex={0}
          className="px-4 py-2 flex items-center gap-2 cursor-default"
          style={{
            paddingLeft: `${paddingLeft}px`,
            color: theme.colors.textMain,
            backgroundColor: isSelected ? `${theme.colors.accent}25` : 'transparent',
            outline: isSelected ? `2px solid ${theme.colors.accent}` : 'none',
            outlineOffset: '-2px'
          }}
          onClick={() => setSelectedNodeId(node.id)}
          onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`; }}
          onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent'; }}
        >
          <div className="w-4 h-4 flex-shrink-0" />
          <div
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: theme.colors.success }}
          />
          <span className="text-sm flex-1 truncate">{node.label}</span>
          {node.claudeSessionId && node.sessionId && onNavigateToSession && (
            <button
              className="text-xs font-mono flex-shrink-0 hover:underline cursor-pointer"
              style={{ color: theme.colors.accent }}
              onClick={(e) => {
                e.stopPropagation();
                onNavigateToSession(node.sessionId!, node.tabId);
                onClose();
              }}
              title="Click to navigate to this session"
            >
              {node.claudeSessionId.substring(0, 8)}...
            </button>
          )}
          {node.claudeSessionId && (!node.sessionId || !onNavigateToSession) && (
            <span className="text-xs font-mono flex-shrink-0" style={{ color: theme.colors.accent }}>
              {node.claudeSessionId.substring(0, 8)}...
            </span>
          )}
          <span className="text-xs font-mono flex-shrink-0" style={{ color: theme.colors.textDim }}>
            PID: {node.pid}
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded"
            style={{
              backgroundColor: `${theme.colors.success}20`,
              color: theme.colors.success
            }}
          >
            Running
          </span>
        </div>
      );
    }

    return null;
  };

  const processTree = buildProcessTree();
  const totalActiveProcesses = activeProcesses.length;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[9999] animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="System Processes"
        className="w-[700px] max-h-[80vh] rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none"
        style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div
          className="px-6 py-4 border-b flex items-center justify-between"
          style={{ borderColor: theme.colors.border }}
        >
          <div className="flex items-center gap-3">
            <Activity className="w-5 h-5" style={{ color: theme.colors.accent }} />
            <h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
              System Processes
            </h2>
            {totalActiveProcesses > 0 && (
              <span
                className="text-xs px-2 py-1 rounded-full"
                style={{ backgroundColor: `${theme.colors.success}20`, color: theme.colors.success }}
              >
                {totalActiveProcesses} active
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => fetchActiveProcesses(true)}
              className="p-1.5 rounded hover:bg-opacity-10 flex items-center gap-1"
              style={{ color: theme.colors.textDim }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
              title="Refresh (R)"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={expandAll}
              className="p-1.5 rounded hover:bg-opacity-10"
              style={{ color: theme.colors.textDim }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
              title="Expand all"
            >
              <div className="flex flex-col items-center -space-y-1.5">
                <ChevronUp className="w-4 h-4" />
                <ChevronDown className="w-4 h-4" />
              </div>
            </button>
            <button
              onClick={collapseAll}
              className="p-1.5 rounded hover:bg-opacity-10"
              style={{ color: theme.colors.textDim }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
              title="Collapse all"
            >
              <div className="flex flex-col items-center -space-y-1.5">
                <ChevronDown className="w-4 h-4" />
                <ChevronUp className="w-4 h-4" />
              </div>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded hover:bg-opacity-10"
              style={{ color: theme.colors.textDim }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Process tree */}
        <div className="overflow-y-auto flex-1 scrollbar-thin">
          {isLoading ? (
            <div
              className="px-6 py-8 text-center flex items-center justify-center gap-2"
              style={{ color: theme.colors.textDim }}
            >
              <RefreshCw className="w-4 h-4 animate-spin" />
              Loading processes...
            </div>
          ) : processTree.length === 0 ? (
            <div
              className="px-6 py-8 text-center"
              style={{ color: theme.colors.textDim }}
            >
              No running processes
            </div>
          ) : (
            <div className="py-2">
              {processTree.map(node => renderNode(node, 0))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-6 py-3 border-t flex items-center justify-between text-xs"
          style={{
            borderColor: theme.colors.border,
            color: theme.colors.textDim
          }}
        >
          <div className="flex items-center gap-4">
            <span>{sessions.length} {sessions.length === 1 ? 'session' : 'sessions'} • {groups.length} {groups.length === 1 ? 'group' : 'groups'}</span>
            <span style={{ opacity: 0.7 }}>↑↓ navigate • ←→ collapse/expand • R refresh</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: theme.colors.success }} />
            <span>Running</span>
          </div>
        </div>
      </div>
    </div>
  );
}
