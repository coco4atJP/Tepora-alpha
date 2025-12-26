import React from 'react';
import { Terminal, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';

import { ActivityLogEntry } from '../types';

interface AgentStatusProps {
    activityLog: ActivityLogEntry[];
}

const AgentStatus: React.FC<AgentStatusProps> = ({ activityLog }) => {
    return (
        <div className="h-full flex flex-col glass-panel p-4 overflow-hidden animate-fade-in transition-all duration-300">
            <div className="flex items-center gap-2 mb-4 text-gold-400 border-b border-white/10 pb-2">
                <Terminal className="w-4 h-4" />
                <h3 className="text-sm font-bold uppercase tracking-wider font-display">Agent Activity</h3>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar font-mono text-xs min-h-0">
                {activityLog.length === 0 ? (
                    <div className="text-gray-600 italic px-2">Waiting for task...</div>
                ) : (
                    activityLog.map((step) => (
                        <div key={step.id} className="flex gap-3 items-start animate-slide-in-right">
                            <div className="mt-0.5 shrink-0">
                                {step.status === 'done' && <CheckCircle2 className="w-3 h-3 text-green-400" />}
                                {step.status === 'processing' && <Loader2 className="w-3 h-3 text-gold-400 animate-spin" />}
                                {step.status === 'pending' && <div className="w-3 h-3 rounded-full border border-gray-600" />}
                                {step.status === 'error' && <AlertCircle className="w-3 h-3 text-red-400" />}
                            </div>
                            <div className={`break-words ${step.status === 'processing' ? 'text-gold-100 font-semibold' :
                                step.status === 'done' ? 'text-gray-300' : 'text-gray-500'
                                }`}>
                                {step.message}
                            </div>
                        </div>
                    ))
                )}

                {/* Blinking cursor effect */}
                <div className="flex gap-3 items-center text-gold-500/50 animate-pulse px-2">
                    <div className="w-1.5 h-3 bg-gold-500/30" />
                </div>
            </div>
        </div>
    );
};

export default AgentStatus;
