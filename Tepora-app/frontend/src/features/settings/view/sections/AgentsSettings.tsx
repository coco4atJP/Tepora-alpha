import React from "react";
import { CharacterAgentsSettings } from "./CharacterAgentsSettings";
import { ExecutiveAgentsSettings } from "./ExecutiveAgentsSettings";
import { SupervisorAgentSettings } from "./SupervisorAgentSettings";
import { PlannerAgentSettings } from "./PlannerAgentSettings";
import { SearchAgentSettings } from "./SearchAgentSettings";

interface AgentsSettingsProps {
	activeTab?: string;
}

export const AgentsSettings: React.FC<AgentsSettingsProps> = ({ activeTab }) => {
	switch (activeTab) {
		case "Characters":
			return <CharacterAgentsSettings activeTab={activeTab} />;
		case "Executive":
			return <ExecutiveAgentsSettings activeTab={activeTab} />;
		case "Supervisor":
			return <SupervisorAgentSettings activeTab={activeTab} />;
		case "Planner":
			return <PlannerAgentSettings activeTab={activeTab} />;
		case "Search":
			return <SearchAgentSettings activeTab={activeTab} />;
		default:
			// Default to Characters if activeTab is unrecognized or missing
			return <CharacterAgentsSettings activeTab={activeTab} />;
	}
};
