export type NavCategory =
	| "General"
	| "Appearance"
	| "Privacy"
	| "Data"
	| "System"
	| "Models"
	| "Memory"
	| "Context"
	| "CharacterAgents"
	| "ExecutiveAgents"
	| "SupervisorAgent"
	| "PlannerAgent"
	| "SearchAgent"
	| "Capabilities"
	| "Advanced";

export interface SettingsCategoryDefinition {
	id: NavCategory;
	label: string;
	tabs: string[];
}

export const SETTINGS_CATEGORIES: SettingsCategoryDefinition[] = [
	{ id: "General", label: "General", tabs: ["Basics", "Deliberate"] },
	{
		id: "Appearance",
		label: "Appearance",
		tabs: ["Theme", "Typography", "Code Blocks", "Notifications", "Shortcuts"],
	},
	{
		id: "Privacy",
		label: "Privacy",
		tabs: ["Privacy", "Quarantine", "Permissions"],
	},
	{ id: "Data", label: "Data", tabs: ["Indexing", "Paths", "Cache", "Backup"] },
	{
		id: "System",
		label: "System",
		tabs: ["Integration", "Performance", "Updates"],
	},
	{
		id: "Models",
		label: "Models",
		tabs: ["Hub", "Defaults", "Embedding", "Loader", "Advanced"],
	},
	{ id: "Memory", label: "Memory", tabs: ["Basics", "Decay Engine", "Retrieval"] },
	{ id: "Context", label: "Context", tabs: ["RAG", "Window Allocation"] },
	{ id: "CharacterAgents", label: "Character Agents", tabs: ["Personas"] },
	{ id: "ExecutiveAgents", label: "Executive Agents", tabs: ["Agents & Skills"] },
	{ id: "SupervisorAgent", label: "Supervisor Agent", tabs: ["Routing", "Execution"] },
	{ id: "PlannerAgent", label: "Planner Agent", tabs: ["Planning"] },
	{ id: "SearchAgent", label: "Search Agent", tabs: ["Retrieval", "Synthesis"] },
	{
		id: "Capabilities",
		label: "Capabilities",
		tabs: ["MCP Servers", "Web Search", "Credentials"],
	},
	{
		id: "Advanced",
		label: "Advanced",
		tabs: ["Model DL", "Features", "Server"],
	},
];
