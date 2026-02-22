import { ChevronRight, ExternalLink, FileText, Globe, Plus, Search, X } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type { Attachment, SearchResult } from "../../types";
import { sanitizeUrl } from "../../utils/sanitizeUrl";

interface RagContextPanelProps {
	attachments: Attachment[];
	onAddAttachment: () => void;
	onRemoveAttachment: (index: number) => void;
	searchResults: SearchResult[] | null;
	skipWebSearch?: boolean;
	onToggleWebSearch?: () => void;
	webSearchAllowed?: boolean;
}

const RagContextPanel: React.FC<RagContextPanelProps> = ({
	attachments,
	onAddAttachment,
	onRemoveAttachment,
	searchResults,
	skipWebSearch,
	onToggleWebSearch,
	webSearchAllowed = true,
}) => {
	const { t } = useTranslation();

	// Helper to safely get hostname
	const getHostname = (urlString: string) => {
		try {
			if (!urlString) return "";
			return new URL(urlString).hostname;
		} catch {
			return "Unknown Source";
		}
	};

	// Helper to get valid URL
	const getValidUrl = (result: SearchResult | { url?: string; link?: string }) => {
		const raw =
			("url" in result && result.url) || ("link" in result && result.link) || "";
		return sanitizeUrl(raw);
	};

	const hasAttachments = attachments.length > 0;
	const hasSearchResults = searchResults && searchResults.length > 0;
	const isEmpty = !hasAttachments && !hasSearchResults;

	return (
		<div className="h-full min-h-0 flex flex-col glass-panel p-4 overflow-hidden animate-fade-in border border-tea-500/10">
			{/* Header */}
			<div className="flex items-center justify-between mb-3 text-tea-400 border-b border-white/10 pb-2 shrink-0">
				<div className="flex items-center gap-2">
					<Search className="w-4 h-4" />
					<h3 className="text-xs font-bold uppercase tracking-[0.2em] font-display">
						{t("rag_context.title", "RAG Context")}
					</h3>
				</div>
				{onToggleWebSearch && (
					<button
						type="button"
						onClick={onToggleWebSearch}
						disabled={!webSearchAllowed}
						className={`flex items-center gap-1.5 h-6 px-3 rounded-full text-[10px] transition-all duration-300 border ${!webSearchAllowed
								? "bg-white/5 text-gray-600 border-white/5 cursor-not-allowed opacity-75"
								: !skipWebSearch
									? "bg-gold-500/10 text-gold-300 border-gold-500/30 shadow-[0_0_15px_-3px_rgba(234,179,8,0.2)]"
									: "bg-white/5 text-gray-500 border-white/5 hover:bg-white/10"
							}`}
						title={
							!webSearchAllowed
								? t("rag_context.web_search_denied", "Web Search is disabled in Privacy Settings")
								: skipWebSearch
									? `${t("chat.input.web_search")}: OFF`
									: `${t("chat.input.web_search")}: ON`
						}
					>
						<Globe
							className={`w-3 h-3 ${!webSearchAllowed ? "text-gray-600" : !skipWebSearch ? "text-gold-400 animate-pulse" : "text-gray-500"}`}
							aria-hidden="true"
						/>
						<span className="font-medium font-display tracking-wide">
							{!webSearchAllowed ? "OFF" : skipWebSearch ? "OFF" : "ON"}
						</span>
					</button>
				)}
			</div>

			{/* Scrollable Content */}
			<div className="overflow-y-auto custom-scrollbar flex-1 min-h-0 -mr-2 pr-2 space-y-4">
				{/* Empty State */}
				{isEmpty && (
					<div className="flex flex-col items-center justify-center text-gray-500 py-8">
						<div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-3">
							<FileText className="w-6 h-6 opacity-50" />
						</div>
						<span className="text-sm font-medium text-center">
							{t("rag_context.no_sources", "No sources added")}
						</span>
						<span className="text-xs text-gray-600 mt-1">
							{t("rag_context.add_hint", "Add files or search the web")}
						</span>
					</div>
				)}

				{/* Attachments Section */}
				{hasAttachments && (
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<span className="text-[10px] font-bold uppercase tracking-wider text-tea-300/80">
								{t("rag_context.files", "Files")} ({attachments.length})
							</span>
						</div>
						<div className="space-y-2">
							{attachments.map((att, index) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: file order matters
									key={index}
									className="group relative flex items-center gap-3 p-3 rounded-xl bg-black/20 border border-white/5 hover:border-tea-500/30 transition-all duration-300"
								>
									{/* Hover Glow */}
									<div className="absolute inset-0 rounded-xl bg-tea-500/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

									<div className="relative z-10 flex items-center gap-3 flex-1 min-w-0">
										<div className="p-1.5 bg-gold-500/10 rounded-lg shrink-0">
											<FileText className="w-4 h-4 text-gold-400" aria-hidden="true" />
										</div>
										<span className="text-xs font-medium text-tea-200 truncate">{att.name}</span>
									</div>

									<button
										type="button"
										onClick={() => onRemoveAttachment(index)}
										className="relative z-10 p-1.5 rounded-md text-gray-500 hover:text-red-400 hover:bg-white/5 transition-colors shrink-0"
										aria-label={t("chat.input.remove_attachment", {
											name: att.name,
										})}
									>
										<X className="w-3.5 h-3.5" aria-hidden="true" />
									</button>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Add File Button */}
				<button
					type="button"
					onClick={onAddAttachment}
					className="w-full flex items-center justify-center gap-2 p-3 rounded-xl border border-dashed border-white/10 hover:border-tea-500/30 hover:bg-white/5 text-gray-400 hover:text-tea-300 transition-all duration-300 group"
				>
					<Plus className="w-4 h-4 group-hover:scale-110 transition-transform" />
					<span className="text-xs font-medium">{t("rag_context.add_file", "Add File")}</span>
				</button>

				{/* Search Results Section */}
				{hasSearchResults && (
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<span className="text-[10px] font-bold uppercase tracking-wider text-tea-300/80">
								{t("rag_context.web_results", "Web Results")} ({searchResults?.length ?? 0})
							</span>
						</div>
						<div className="space-y-3">
							{searchResults?.map((result, index) => {
								const targetUrl = getValidUrl(result);
								return (
									<a
										// biome-ignore lint/suspicious/noArrayIndexKey: Search results need index if url duplicates
										key={`${targetUrl}-${index}`}
										href={targetUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="block group relative p-3 rounded-xl bg-black/20 hover:bg-white/5 border border-white/5 hover:border-tea-500/30 transition-all duration-300"
									>
										{/* Hover Glow */}
										<div className="absolute inset-0 rounded-xl bg-tea-500/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

										<div className="relative z-10">
											<h4 className="text-xs font-medium text-tea-200 group-hover:text-tea-100 flex items-center gap-2 leading-tight mb-1.5">
												<span className="line-clamp-2">{result.title}</span>
												<ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-50 transition-opacity shrink-0" />
											</h4>

											<p className="text-xs text-gray-500 line-clamp-2 leading-relaxed mb-2 group-hover:text-gray-400 transition-colors">
												{result.snippet}
											</p>

											<div className="flex items-center gap-1.5 text-[10px] text-tea-500/60 font-mono">
												<Globe className="w-2.5 h-2.5" />
												<span className="truncate max-w-[150px]">{getHostname(targetUrl)}</span>
											</div>
										</div>

										{/* Arrow indicator */}
										<div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 -translate-x-2 group-hover:translate-x-0 transition-all duration-300 text-tea-400">
											<ChevronRight className="w-4 h-4" />
										</div>
									</a>
								);
							})}
						</div>
					</div>
				)}
			</div>

			{/* Footer Fade */}
			<div className="h-4 shrink-0 bg-gradient-to-t from-black/20 to-transparent -mx-4 -mb-4 mt-2 pointer-events-none" />
		</div>
	);
};

export default RagContextPanel;
