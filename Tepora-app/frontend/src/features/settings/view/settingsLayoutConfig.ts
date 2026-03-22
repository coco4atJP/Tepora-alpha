export type NavCategory =
	| "General"
	| "Appearance"
	| "Characters"
	| "Models"
	| "Privacy"
	| "Tools"
	| "Memory"
	| "Context"
	| "Data"
	| "System"
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
	{ id: "Characters", label: "Characters", tabs: ["Personas", "Custom Agents"] },
	{
		id: "Models",
		label: "Models",
		tabs: ["Hub", "Defaults", "Embedding", "Loader", "Advanced"],
	},
	{
		id: "Privacy",
		label: "Privacy",
		tabs: ["Privacy", "Quarantine", "Permissions"],
	},
	{
		id: "Tools",
		label: "Tools",
		tabs: ["Web Search", "Agent Skills", "MCP", "Credentials"],
	},
	{ id: "Memory", label: "Memory", tabs: ["Basics", "Decay Engine", "Retrieval"] },
	{ id: "Context", label: "Context", tabs: ["RAG", "Window Allocation"] },
	{ id: "Data", label: "Data", tabs: ["Indexing", "Paths", "Cache", "Backup"] },
	{
		id: "System",
		label: "System",
		tabs: ["Integration", "Performance", "Updates"],
	},
	{
		id: "Advanced",
		label: "Advanced",
		tabs: ["Execution", "Agent", "Model DL", "Features", "Server"],
	},
];
