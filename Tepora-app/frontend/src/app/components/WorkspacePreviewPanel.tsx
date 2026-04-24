import { useEffect, useState } from "react";
import { Check, Save, X } from "lucide-react";
import type { WorkspaceDocument } from "../../shared/contracts";

interface WorkspacePreviewPanelProps {
	document: WorkspaceDocument | null;
	selectedPath: string | null;
	isLoading: boolean;
	onSave: (content: string) => Promise<void>;
	onClose?: () => void;
}

export function WorkspacePreviewPanel({
	document,
	selectedPath,
	isLoading,
	onSave,
	onClose,

}: WorkspacePreviewPanelProps) {
	const [draft, setDraft] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [saveSuccess, setSaveSuccess] = useState(false);

	useEffect(() => {
		setDraft(document?.content ?? "");
		setSaveSuccess(false);
	}, [document?.content, document?.path]);

	const handleSave = async () => {
		if (isSaving || !document) return;
		setIsSaving(true);
		setSaveSuccess(false);
		try {
			await onSave(draft);
			setSaveSuccess(true);
			setTimeout(() => {
				setSaveSuccess(false);
			}, 2000);
		} catch (error) {
			console.error("Failed to save:", error);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<div className="relative flex h-full flex-col overflow-hidden rounded-[28px] border border-[var(--glass-border)] bg-[var(--glass-bg)] shadow-[var(--glass-shadow)] backdrop-blur-xl transition-all duration-500 ease-out">
			{/* Inner subtle glow */}
			<div className="absolute top-0 left-1/4 w-1/2 h-px bg-gradient-to-r from-transparent via-gold-500/50 to-transparent z-10" />
			
			<div className="flex items-start justify-between border-b border-border px-5 py-4 relative z-10">
				<div className="min-w-0 pr-4">
					<div className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-primary/70">
						Preview
					</div>
					<div className="mt-2 truncate text-sm text-text-muted">
						{selectedPath ?? "Select a file"}
					</div>
				</div>
				{onClose && (
					<button
						type="button"
						onClick={onClose}
						className="mt-1 flex-shrink-0 rounded-full p-1.5 text-text-muted hover:bg-white/10 hover:text-text-main transition-colors"
						aria-label="Close preview"
					>
						<X className="h-4 w-4" />
					</button>
				)}
			</div>
			{isLoading ? (
				<div className="flex flex-1 items-center justify-center text-sm text-text-muted">
					Loading...
				</div>
			) : !document ? (
				<div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-text-muted">
					Select a context, skill, or workspace file to preview and edit it here.
				</div>
			) : (
				<>
					<textarea
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						className="min-h-0 flex-1 resize-none bg-transparent px-5 py-4 font-mono text-sm leading-7 text-text-main outline-none"
						spellCheck={false}
					/>
					<div className="flex items-center justify-between border-t border-border px-5 py-4">
						<div className="text-xs text-text-muted/60">
							{saveSuccess ? (
								<span className="flex items-center text-green-600">
									<Check className="mr-1 h-3.5 w-3.5" />
									Saved successfully
								</span>
							) : draft !== document.content ? (
								<span className="italic">Unsaved changes</span>
							) : null}
						</div>
						<button
							type="button"
							disabled={isSaving || draft === document.content}
							onClick={() => void handleSave()}
							className={`flex items-center rounded-full border px-4 py-2 text-xs uppercase tracking-[0.14em] transition-colors ${
								isSaving || draft === document.content
									? "border-border text-border cursor-not-allowed"
									: "border-primary/30 text-primary hover:bg-primary/8"
							}`}
						>
							<Save className="mr-1.5 h-3.5 w-3.5" />
							{isSaving ? "Saving..." : "Save"}
						</button>
					</div>
				</>
			)}
		</div>
	);
}
