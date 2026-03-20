import { Briefcase, Brain, Cpu, Database, HardDrive, Settings, Shield, SlidersHorizontal, Users } from "lucide-react";
import type { TFunction } from "i18next";
import type { NavItem } from "./SettingsComponents";

export function getNavItems(t: TFunction): NavItem[] {
	return [
		{ id: "general", label: t("settings.nav.general", "General"), icon: <Settings size={18} /> },
		{ id: "privacy", label: t("settings.nav.privacy", "Privacy"), icon: <Shield size={18} /> },
		{ id: "data_storage", label: t("settings.nav.data_storage", "Data Storage"), icon: <HardDrive size={18} /> },
		{ id: "system_performance", label: t("settings.nav.system_performance", "System Performance"), icon: <Cpu size={18} /> },
		{ id: "agents", label: t("settings.nav.agents", "Characters"), icon: <Users size={18} />, group: "custom" },
		{ id: "agent_skills", label: t("settings.nav.execution_agents", "Agent Skills"), icon: <Briefcase size={18} />, group: "custom" },
		{ id: "models", label: t("settings.nav.models", "Models"), icon: <SlidersHorizontal size={18} /> },
		{ id: "mcp", label: t("settings.nav.mcp", "MCP Tools"), icon: <Database size={18} /> },
		{ id: "memory", label: t("settings.nav.memory", "Memory"), icon: <Brain size={18} /> },
		{ id: "other", label: t("settings.nav.other", "Other"), icon: <Settings size={18} /> },
	];
}
