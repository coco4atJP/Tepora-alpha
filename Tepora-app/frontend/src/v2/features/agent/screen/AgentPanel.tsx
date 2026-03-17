import { useAgentPanelModel } from "../model/useAgentPanelModel";
import { AgentPanelView } from "../view/AgentPanelView";

export function AgentPanel() {
	const model = useAgentPanelModel();
	return <AgentPanelView {...model} />;
}
