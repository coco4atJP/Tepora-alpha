
import { Settings, Cpu, Users, Brain, Database } from 'lucide-react';
import { NavItem } from './SettingsComponents';

export const NAV_ITEMS: NavItem[] = [
    { id: 'general', label: 'General', icon: <Settings size={18} /> },
    { id: 'agents', label: 'Characters', icon: <Users size={18} /> },
    { id: 'mcp', label: 'MCP Tools', icon: <Database size={18} /> },
    { id: 'models', label: 'Models', icon: <Cpu size={18} /> },
    { id: 'memory', label: 'Memory', icon: <Brain size={18} /> },
];
