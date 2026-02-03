import { Briefcase, Brain, Cpu, Database, Settings, Shield, Users } from "lucide-react";
import type { NavItem } from "./SettingsComponents";

export const NAV_ITEMS: NavItem[] = [
	{ id: "general", label: "General", icon: <Settings size={18} /> },
	{ id: "privacy", label: "Privacy", icon: <Shield size={18} /> },
	// Custom Group
	{ id: "agents", label: "Characters", icon: <Users size={18} />, group: "custom" },
	{ id: "custom_agents", label: "Professional", icon: <Briefcase size={18} />, group: "custom" },

	{ id: "models", label: "Models", icon: <Cpu size={18} /> },
	{ id: "mcp", label: "MCP Tools", icon: <Database size={18} /> },
	{ id: "memory", label: "Memory", icon: <Brain size={18} /> },
	{ id: "other", label: "Other", icon: <Settings size={18} /> }, // Using generic settings icon or maybe something else?
];
