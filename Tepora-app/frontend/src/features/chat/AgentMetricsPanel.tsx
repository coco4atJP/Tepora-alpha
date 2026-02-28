/**
 * AgentMetricsPanel - 開発者向けのエージェントイベントログビューア
 *
 * Feature flag: redesign.agent_metrics
 * セッション内のGraphノードの実行イベント（NodeStarted, PromptGenerated, ToolCallなど）を
 * タイムライン形式で表示する。
 */
import { Activity, ChevronDown, ChevronUp, RefreshCw, Zap, Brain, Wrench, AlertCircle, Play, CheckCircle } from "lucide-react";
import type React from "react";
import { useEffect, useState, useMemo } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { useAgentMetrics } from "./hooks/useAgentMetrics";
import type { AgentEventType } from "../../api/metrics";

const EVENT_ICONS: Record<AgentEventType, React.ReactNode> = {
    node_started: <Play className="w-3.5 h-3.5 text-emerald-400" />,
    node_completed: <CheckCircle className="w-3.5 h-3.5 text-blue-400" />,
    prompt_generated: <Brain className="w-3.5 h-3.5 text-purple-400" />,
    tool_call: <Wrench className="w-3.5 h-3.5 text-amber-400" />,
    error: <AlertCircle className="w-3.5 h-3.5 text-red-400" />,
};

const EVENT_LABELS: Record<AgentEventType, string> = {
    node_started: "Node Started",
    node_completed: "Node Completed",
    prompt_generated: "Prompt Generated",
    tool_call: "Tool Call",
    error: "Error",
};

const EVENT_COLORS: Record<AgentEventType, string> = {
    node_started: "border-emerald-500/30 bg-emerald-500/5",
    node_completed: "border-blue-500/30 bg-blue-500/5",
    prompt_generated: "border-purple-500/30 bg-purple-500/5",
    tool_call: "border-amber-500/30 bg-amber-500/5",
    error: "border-red-500/30 bg-red-500/5",
};

interface AgentMetricsPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

const AgentMetricsPanel: React.FC<AgentMetricsPanelProps> = ({ isOpen, onClose }) => {
    const currentSessionId = useSessionStore((s) => s.currentSessionId);
    const { events, loading, error, fetchMetrics } = useAgentMetrics(currentSessionId);
    const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen && currentSessionId && currentSessionId !== "default") {
            fetchMetrics();
        }
    }, [isOpen, currentSessionId, fetchMetrics]);

    const summary = useMemo(() => {
        const prompts = events.filter((e) => e.event_type === "prompt_generated");
        const tools = events.filter((e) => e.event_type === "tool_call");
        const totalResponseLen = prompts.reduce(
            (acc, e) => acc + (Number(e.metadata?.length) || 0),
            0
        );
        return {
            totalEvents: events.length,
            promptCount: prompts.length,
            toolCallCount: tools.length,
            totalResponseLength: totalResponseLen,
        };
    }, [events]);

    if (!isOpen) return null;

    return (
        <div className="shrink-0 border-b border-border-highlight bg-bg-app/80 backdrop-blur-lg z-10 overflow-hidden transition-all duration-300">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-white/5">
                <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-gold-300" />
                    <span className="text-xs font-semibold text-gold-200 tracking-wide uppercase">
                        Agent Metrics
                    </span>
                    <span className="text-[10px] text-tea-200/50 font-mono ml-2">
                        {currentSessionId === "default" ? "—" : currentSessionId.slice(0, 8)}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={fetchMetrics}
                        disabled={loading}
                        className="p-1.5 rounded-lg text-tea-200/60 hover:text-gold-300 hover:bg-white/5 transition-colors disabled:opacity-40"
                        title="Refresh"
                    >
                        <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1 rounded-lg text-tea-200/60 hover:text-gold-300 hover:bg-white/5 transition-colors"
                    >
                        <ChevronUp className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Summary Bar */}
            <div className="flex items-center gap-4 px-4 py-1.5 text-[11px] text-tea-200/70 border-b border-white/5">
                <span className="flex items-center gap-1">
                    <Zap className="w-3 h-3 text-gold-300" />
                    {summary.totalEvents} events
                </span>
                <span className="flex items-center gap-1">
                    <Brain className="w-3 h-3 text-purple-400" />
                    {summary.promptCount} prompts
                </span>
                <span className="flex items-center gap-1">
                    <Wrench className="w-3 h-3 text-amber-400" />
                    {summary.toolCallCount} tools
                </span>
                {summary.totalResponseLength > 0 && (
                    <span className="text-tea-200/50 ml-auto font-mono">
                        ~{(summary.totalResponseLength / 1000).toFixed(1)}k chars
                    </span>
                )}
            </div>

            {/* Event Timeline */}
            <div className="max-h-[220px] overflow-y-auto px-4 py-2 space-y-1 scrollbar-thin scrollbar-thumb-white/10">
                {error && (
                    <div className="text-xs text-red-400 py-2">
                        Failed to load metrics: {error.message}
                    </div>
                )}
                {!loading && events.length === 0 && !error && (
                    <div className="text-xs text-tea-200/40 py-3 text-center">
                        No events recorded for this session yet.
                    </div>
                )}
                {events.map((event) => (
                    <div
                        key={event.id}
                        className={`flex flex-col rounded-lg border p-2 transition-colors cursor-pointer ${EVENT_COLORS[event.event_type as AgentEventType] || "border-white/10 bg-white/5"} hover:bg-white/10`}
                        onClick={() =>
                            setExpandedEventId(expandedEventId === event.id ? null : event.id)
                        }
                        onKeyDown={() => { }}
                        role="button"
                        tabIndex={0}
                    >
                        <div className="flex items-center gap-2">
                            {EVENT_ICONS[event.event_type as AgentEventType] || <Activity className="w-3.5 h-3.5 text-tea-200/50" />}
                            <span className="text-[11px] font-medium text-tea-100/90">
                                {EVENT_LABELS[event.event_type as AgentEventType] || event.event_type}
                            </span>
                            <span className="text-[10px] text-tea-200/40 font-mono">
                                {event.node_name}
                            </span>
                            <span className="ml-auto text-[9px] text-tea-200/30 font-mono">
                                {new Date(event.created_at).toLocaleTimeString("ja-JP", {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit",
                                })}
                            </span>
                            {expandedEventId === event.id ? (
                                <ChevronUp className="w-3 h-3 text-tea-200/40" />
                            ) : (
                                <ChevronDown className="w-3 h-3 text-tea-200/40" />
                            )}
                        </div>
                        {expandedEventId === event.id && event.metadata && Object.keys(event.metadata).length > 0 && (
                            <pre className="mt-1.5 text-[10px] text-tea-200/60 font-mono bg-black/20 rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all">
                                {JSON.stringify(event.metadata, null, 2)}
                            </pre>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};

export default AgentMetricsPanel;
