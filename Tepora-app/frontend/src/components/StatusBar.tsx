import React, { useEffect, useState } from 'react';
import { Wifi, WifiOff, Database } from 'lucide-react';
import { SystemStatus, MemoryStats } from '../types';

interface StatusBarProps {
  isConnected: boolean;
  memoryStats: MemoryStats | null;
}

const StatusBar: React.FC<StatusBarProps> = ({ isConnected, memoryStats }) => {
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/status');
        const data = await response.json();
        setSystemStatus(data);
      } catch (error) {
        console.error('Failed to fetch system status:', error);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 30000); // Poll every 30 seconds
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-gray-900 border-b border-gray-700 px-4 py-2 flex items-center gap-4 text-sm">
      <div className="flex items-center gap-2">
        {isConnected ? (
          <>
            <Wifi className="w-4 h-4 text-green-500" />
            <span className="text-green-500">接続中</span>
          </>
        ) : (
          <>
            <WifiOff className="w-4 h-4 text-red-500" />
            <span className="text-red-500">切断</span>
          </>
        )}
      </div>

      {systemStatus?.em_llm_enabled && (
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-blue-500" />
          <span className="text-gray-400">
            EM-LLM: <span className="text-blue-400">{systemStatus.memory_events} イベント</span>
          </span>
        </div>
      )}

      {memoryStats && (
        <div className="text-gray-500 text-xs">
          {(memoryStats.char_memory?.total_events || 0) + (memoryStats.prof_memory?.total_events || 0)} events
        </div>
      )}
    </div>
  );
};

export default StatusBar;
