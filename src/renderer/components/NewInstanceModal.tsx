import React, { useState, useEffect } from 'react';
import { Folder, X } from 'lucide-react';

interface AgentConfig {
  id: string;
  name: string;
  available: boolean;
  path?: string;
}

interface NewInstanceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (agentId: string, workingDir: string, name: string) => void;
  theme: any;
  defaultAgent: string;
}

export function NewInstanceModal({ isOpen, onClose, onCreate, theme, defaultAgent }: NewInstanceModalProps) {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [selectedAgent, setSelectedAgent] = useState(defaultAgent);
  const [workingDir, setWorkingDir] = useState('~');
  const [instanceName, setInstanceName] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isOpen) {
      loadAgents();
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const loadAgents = async () => {
    setLoading(true);
    try {
      const detectedAgents = await window.maestro.agents.detect();
      setAgents(detectedAgents);

      // Set default or first available
      const defaultAvailable = detectedAgents.find((a: AgentConfig) => a.id === defaultAgent && a.available);
      const firstAvailable = detectedAgents.find((a: AgentConfig) => a.available);

      if (defaultAvailable) {
        setSelectedAgent(defaultAgent);
      } else if (firstAvailable) {
        setSelectedAgent(firstAvailable.id);
      }
    } catch (error) {
      console.error('Failed to load agents:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectFolder = async () => {
    const folder = await window.maestro.dialog.selectFolder();
    if (folder) {
      setWorkingDir(folder);
    }
  };

  const handleCreate = () => {
    const name = instanceName || agents.find(a => a.id === selectedAgent)?.name || 'New Instance';
    onCreate(selectedAgent, workingDir, name);
    onClose();

    // Reset
    setInstanceName('');
    setWorkingDir('~');
  };

  if (!isOpen) return null;

  return (
    <div
      className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50"
      onKeyDown={(e) => {
        // Stop propagation of all keyboard events to prevent background components from handling them
        if (e.key !== 'Escape') {
          e.stopPropagation();
        }
      }}
    >
      <div
        className="w-[500px] rounded-xl border shadow-2xl overflow-hidden"
        style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
      >
        {/* Header */}
        <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: theme.colors.border }}>
          <h2 className="text-lg font-bold" style={{ color: theme.colors.textMain }}>Create New Instance</h2>
          <button onClick={onClose} style={{ color: theme.colors.textDim }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {/* Instance Name */}
          <div>
            <label className="block text-xs font-bold opacity-70 uppercase mb-2" style={{ color: theme.colors.textMain }}>
              Instance Name (Optional)
            </label>
            <input
              type="text"
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
              placeholder="My Project Session"
              className="w-full p-2 rounded border bg-transparent outline-none"
              style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
            />
          </div>

          {/* Agent Selection */}
          <div>
            <label className="block text-xs font-bold opacity-70 uppercase mb-2" style={{ color: theme.colors.textMain }}>
              AI Agent / Tool
            </label>
            {loading ? (
              <div className="text-sm opacity-50">Loading agents...</div>
            ) : (
              <div className="space-y-2">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    disabled={agent.id !== 'claude-code' || !agent.available}
                    onClick={() => setSelectedAgent(agent.id)}
                    className={`w-full text-left p-3 rounded border transition-all ${
                      selectedAgent === agent.id ? 'ring-2' : ''
                    } ${(agent.id !== 'claude-code' || !agent.available) ? 'opacity-40 cursor-not-allowed' : 'hover:bg-opacity-10'}`}
                    style={{
                      borderColor: theme.colors.border,
                      backgroundColor: selectedAgent === agent.id ? theme.colors.accentDim : 'transparent',
                      ringColor: theme.colors.accent,
                      color: theme.colors.textMain,
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{agent.name}</div>
                        {agent.path && (
                          <div className="text-xs opacity-50 font-mono mt-1">{agent.path}</div>
                        )}
                      </div>
                      {agent.id === 'claude-code' ? (
                        agent.available ? (
                          <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: theme.colors.success + '20', color: theme.colors.success }}>
                            Available
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: theme.colors.error + '20', color: theme.colors.error }}>
                            Not Found
                          </span>
                        )
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: theme.colors.warning + '20', color: theme.colors.warning }}>
                          Coming Soon
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Working Directory */}
          <div>
            <label className="block text-xs font-bold opacity-70 uppercase mb-2" style={{ color: theme.colors.textMain }}>
              Working Directory
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={workingDir}
                onChange={(e) => setWorkingDir(e.target.value)}
                className="flex-1 p-2 rounded border bg-transparent outline-none font-mono text-sm"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
              />
              <button
                onClick={handleSelectFolder}
                className="p-2 rounded border hover:bg-opacity-10"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                title="Browse folders"
              >
                <Folder className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t flex justify-end gap-2" style={{ borderColor: theme.colors.border }}>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded border"
            style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!selectedAgent || !agents.find(a => a.id === selectedAgent)?.available}
            className="px-4 py-2 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: theme.colors.accent }}
          >
            Create Instance
          </button>
        </div>
      </div>
    </div>
  );
}
