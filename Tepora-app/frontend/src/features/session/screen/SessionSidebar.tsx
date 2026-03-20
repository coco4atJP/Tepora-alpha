import { useSessionSidebarModel } from "../model/useSessionSidebarModel";
import { SessionSidebarView } from "../view/SessionSidebarView";

export function SessionSidebar() {
	const model = useSessionSidebarModel();
	return <SessionSidebarView {...model} />;
}
