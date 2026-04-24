export type NavCategory =
	| "General"
	| "Appearance"
	| "Privacy"
	| "Data"
	| "System"
	| "Models"
	| "Memory"
	| "Context"
	| "Agents"
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
	{ id: "Agents", label: "Agents", tabs: ["Characters", "Executive", "Supervisor", "Planner", "Search"] },
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
