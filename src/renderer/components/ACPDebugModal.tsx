/**
 * ACP Debug Modal
 *
 * Displays ACP (Agent Client Protocol) communication history for debugging.
 * Shows the initialization command and all inbound/outbound messages.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Modal, ModalFooter } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import type { Theme } from '../types';

interface ACPLogEntry {
  timestamp: string;
  direction: 'inbound' | 'outbound';
  type: 'request' | 'response' | 'notification';
  method?: string;
  id?: number | string;
  data: unknown;
}

interface ACPDebugInfo {
  initCommand: string | null;
  messages: ACPLogEntry[];
  stats: {
    totalMessages: number;
    inboundMessages: number;
    outboundMessages: number;
    requests: number;
    responses: number;
    notifications: number;
  };
}

interface ACPDebugModalProps {
  theme: Theme;
  isOpen: boolean;
  onClose: () => void;
}

export function ACPDebugModal({ theme, isOpen, onClose }: ACPDebugModalProps): JSX.Element | null {
  const [debugInfo, setDebugInfo] = useState<ACPDebugInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'inbound' | 'outbound'>('all');
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(new Set());

  const loadDebugInfo = useCallback(async () => {
    setLoading(true);
    try {
      const info = await window.maestro.acpDebug.getDebugInfo();
      setDebugInfo(info);
    } catch (error) {
      console.error('Failed to load ACP debug info:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadDebugInfo();
    }
  }, [isOpen, loadDebugInfo]);

  const handleClearLog = async () => {
    await window.maestro.acpDebug.clearLog();
    loadDebugInfo();
  };

  const toggleMessage = (index: number) => {
    setExpandedMessages(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const filteredMessages = debugInfo?.messages.filter(m => {
    if (filter === 'all') return true;
    return m.direction === filter;
  }) || [];

  if (!isOpen) return null;

  return (
    <Modal
      theme={theme}
      title="ACP Debug Log"
      priority={MODAL_PRIORITIES.SETTINGS}
      onClose={onClose}
      width={800}
      footer={
        <ModalFooter
          theme={theme}
          onCancel={onClose}
          cancelLabel="Close"
          onConfirm={loadDebugInfo}
          confirmLabel="Refresh"
        />
      }
    >
      <div className="space-y-4">
        {/* Clear log button */}
        <div className="flex justify-end">
          <button
            onClick={handleClearLog}
            className="px-3 py-1 text-xs rounded"
            style={{ backgroundColor: theme.colors.error, color: '#fff' }}
          >
            Clear Log
          </button>
        </div>

        {/* Initialization Command */}
        <div>
          <h3 className="text-sm font-medium mb-2" style={{ color: theme.colors.textMain }}>
            Initialization Command
          </h3>
          <div
            className="p-3 rounded font-mono text-xs break-all"
            style={{ backgroundColor: theme.colors.bgSidebar, color: theme.colors.textMain }}
          >
            {debugInfo?.initCommand || <span style={{ color: theme.colors.textDim }}>No ACP session started yet</span>}
          </div>
        </div>

        {/* Stats */}
        {debugInfo && (
          <div className="flex gap-4 text-xs" style={{ color: theme.colors.textDim }}>
            <span>Total: {debugInfo.stats.totalMessages}</span>
            <span>Inbound: {debugInfo.stats.inboundMessages}</span>
            <span>Outbound: {debugInfo.stats.outboundMessages}</span>
            <span>Requests: {debugInfo.stats.requests}</span>
            <span>Responses: {debugInfo.stats.responses}</span>
            <span>Notifications: {debugInfo.stats.notifications}</span>
          </div>
        )}

        {/* Filter */}
        <div className="flex gap-2">
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1 rounded text-xs ${filter === 'all' ? 'font-bold' : ''}`}
            style={{
              backgroundColor: filter === 'all' ? theme.colors.accent : theme.colors.bgSidebar,
              color: filter === 'all' ? theme.colors.accentForeground : theme.colors.textMain,
            }}
          >
            All
          </button>
          <button
            onClick={() => setFilter('inbound')}
            className={`px-3 py-1 rounded text-xs ${filter === 'inbound' ? 'font-bold' : ''}`}
            style={{
              backgroundColor: filter === 'inbound' ? '#3b82f6' : theme.colors.bgSidebar,
              color: filter === 'inbound' ? '#fff' : theme.colors.textMain,
            }}
          >
            Inbound
          </button>
          <button
            onClick={() => setFilter('outbound')}
            className={`px-3 py-1 rounded text-xs ${filter === 'outbound' ? 'font-bold' : ''}`}
            style={{
              backgroundColor: filter === 'outbound' ? '#10b981' : theme.colors.bgSidebar,
              color: filter === 'outbound' ? '#fff' : theme.colors.textMain,
            }}
          >
            Outbound
          </button>
        </div>

        {/* Messages */}
        <div>
          <h3 className="text-sm font-medium mb-2" style={{ color: theme.colors.textMain }}>
            Messages ({filteredMessages.length})
          </h3>
          <div
            className="rounded overflow-auto"
            style={{
              backgroundColor: theme.colors.bgSidebar,
              maxHeight: '400px',
            }}
          >
            {loading ? (
              <div className="p-4 text-center" style={{ color: theme.colors.textDim }}>
                Loading...
              </div>
            ) : filteredMessages.length === 0 ? (
              <div className="p-4 text-center" style={{ color: theme.colors.textDim }}>
                No messages logged yet
              </div>
            ) : (
              <div className="divide-y" style={{ borderColor: theme.colors.border }}>
                {filteredMessages.map((msg, index) => (
                  <div
                    key={index}
                    className="p-2 cursor-pointer hover:opacity-80"
                    onClick={() => toggleMessage(index)}
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <span
                        className="px-2 py-0.5 rounded font-mono"
                        style={{
                          backgroundColor: msg.direction === 'inbound' ? '#3b82f620' : '#10b98120',
                          color: msg.direction === 'inbound' ? '#3b82f6' : '#10b981',
                        }}
                      >
                        {msg.direction === 'inbound' ? '←' : '→'} {msg.direction}
                      </span>
                      <span
                        className="px-2 py-0.5 rounded"
                        style={{
                          backgroundColor: theme.colors.bgMain,
                          color: theme.colors.textDim,
                        }}
                      >
                        {msg.type}
                      </span>
                      {msg.method && (
                        <span className="font-mono font-medium" style={{ color: theme.colors.textMain }}>
                          {msg.method}
                        </span>
                      )}
                      {msg.id !== undefined && (
                        <span style={{ color: theme.colors.textDim }}>
                          id: {msg.id}
                        </span>
                      )}
                      <span className="ml-auto" style={{ color: theme.colors.textDim }}>
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    {expandedMessages.has(index) && (
                      <pre
                        className="mt-2 p-2 rounded text-xs overflow-auto"
                        style={{
                          backgroundColor: theme.colors.bgMain,
                          color: theme.colors.textMain,
                          maxHeight: '200px',
                        }}
                      >
                        {JSON.stringify(msg.data, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
