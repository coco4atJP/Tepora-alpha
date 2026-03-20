import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AgentPanel } from "../features/agent/screen/AgentPanel";
import { ChatScreen } from "../features/chat/screen/ChatScreen";
import { SessionSidebar } from "../features/session/screen/SessionSidebar";
import { SettingsScreen } from "../features/settings/screen/SettingsScreen";
import { AppShellLayout } from "../shared/ui/AppShellLayout";

interface WorkspaceProps {
	isSettingsOpen?: boolean;
}

export function Workspace({ isSettingsOpen = false }: WorkspaceProps) {
	const navigate = useNavigate();
	const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(false);
	const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(false);

	return (
		<div className="relative h-screen w-screen overflow-hidden">
			<AppShellLayout
				leftSidebar={<SessionSidebar />}
				rightSidebar={<AgentPanel />}
				isLeftSidebarOpen={isLeftSidebarOpen}
				isRightSidebarOpen={isRightSidebarOpen}
				onLeftSidebarClose={() => setIsLeftSidebarOpen(false)}
				onRightSidebarClose={() => setIsRightSidebarOpen(false)}
				mainContent={
					<ChatScreen
						onOpenSettings={() => {
							navigate("/settings");
						}}
						onOpenLeftSidebar={() => setIsLeftSidebarOpen(true)}
						onOpenRightSidebar={() => setIsRightSidebarOpen(true)}
					/>
				}
			/>
			<SettingsScreen
				isOpen={isSettingsOpen}
				onClose={() => {
					navigate("/");
				}}
			/>
		</div>
	);
}
