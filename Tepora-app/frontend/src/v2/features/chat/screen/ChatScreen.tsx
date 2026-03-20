import type { ChangeEvent } from "react";
import { useRef } from "react";
import { useChatScreenModel } from "../model/useChatScreenModel";
import { ChatScreenView } from "../view/ChatScreenView";

interface ChatScreenProps {
	onOpenSettings?: () => void;
	onOpenLeftSidebar?: () => void;
	onOpenRightSidebar?: () => void;
}

export function ChatScreen({ onOpenSettings, onOpenLeftSidebar, onOpenRightSidebar }: ChatScreenProps) {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const model = useChatScreenModel();

	const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
		const files = event.target.files ? Array.from(event.target.files) : null;
		await model.onAddFiles(files);
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	};

	return (
		<div className="relative h-full w-full">
			<input
				ref={fileInputRef}
				type="file"
				className="hidden"
				onChange={handleFileChange}
				multiple
			/>
			<ChatScreenView
				{...model}
				onOpenSettings={onOpenSettings}
				onOpenLeftSidebar={onOpenLeftSidebar}
				onOpenRightSidebar={onOpenRightSidebar}
				onAddAttachment={() => {
					fileInputRef.current?.click();
				}}
			/>
			{model.errorMessage ? (
				<div className="pointer-events-none absolute left-1/2 top-6 z-30 w-full max-w-[720px] -translate-x-1/2 px-5">
					<div className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100/85 backdrop-blur-xl">
						{model.errorMessage}
					</div>
				</div>
			) : null}
		</div>
	);
}
