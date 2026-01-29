import { Code2, MessageSquare, Search, Sparkles } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";

interface EmptyStateProps {
	onPromptSelect: (prompt: string) => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ onPromptSelect }) => {
	const { t } = useTranslation();

	const capabilities = [
		{
			icon: Search,
			title: t("empty.capability.search.title", "Web Search"),
			description: t(
				"empty.capability.search.desc",
				"Search the internet for real-time info",
			),
			prompt: "Search for the latest news on AI technology",
			color: "text-blue-400",
			bg: "bg-blue-500/10",
			border: "border-blue-500/20",
		},
		{
			icon: Code2,
			title: t("empty.capability.code.title", "Code Analysis"),
			description: t(
				"empty.capability.code.desc",
				"Analyze, refactor, and explain code",
			),
			prompt: "Analyze the current project structure and suggest improvements",
			color: "text-green-400",
			bg: "bg-green-500/10",
			border: "border-green-500/20",
		},
		{
			icon: MessageSquare,
			title: t("empty.capability.chat.title", "Natural Chat"),
			description: t(
				"empty.capability.chat.desc",
				"Have a fluid conversation about any topic",
			),
			prompt: "Let's brainstorm some ideas for a new feature",
			color: "text-gold-400",
			bg: "bg-gold-500/10",
			border: "border-gold-500/20",
		},
	];

	return (
		<div className="h-full flex flex-col items-center justify-center p-4 max-w-4xl mx-auto animate-fade-in">
			{/* Hero Section */}
			<div className="text-center mb-12 relative">
				<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-gold-500/10 rounded-full blur-[80px] pointer-events-none" />
				<h1 className="text-5xl md:text-6xl font-display font-light text-transparent bg-clip-text bg-gradient-to-br from-gold-300 via-white to-gold-300 tracking-tight mb-4 drop-shadow-[0_0_15px_rgba(255,215,0,0.3)]">
					TEPORA
				</h1>
				<p className="text-gray-400 text-lg md:text-xl font-light tracking-wide max-w-lg mx-auto leading-relaxed">
					{t(
						"empty.hero.subtitle",
						"Your intelligent AI companion for code and creativity",
					)}
				</p>
			</div>

			{/* Capability Cards */}
			<div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full px-4">
				{capabilities.map((cap) => (
					<button
						type="button"
						key={cap.prompt}
						onClick={() => onPromptSelect(cap.prompt)}
						className={`group relative p-6 rounded-xl border ${cap.border} ${cap.bg} backdrop-blur-sm transition-all duration-300 hover:scale-105 hover:shadow-lg text-left overflow-hidden`}
					>
						<div
							className={`absolute inset-0 opacity-0 group-hover:opacity-10 transition-opacity duration-500 bg-gradient-to-br from-white to-transparent`}
						/>
						<div className="flex items-start justify-between mb-4">
							<div className={`p-3 rounded-lg bg-black/20 ${cap.color}`}>
								<cap.icon size={24} />
							</div>
							<Sparkles
								className={`w-4 h-4 ${cap.color} opacity-0 group-hover:opacity-100 transition-opacity duration-300`}
							/>
						</div>
						<h3 className="text-lg font-medium text-white mb-2 group-hover:text-gold-300 transition-colors">
							{cap.title}
						</h3>
						<p className="text-sm text-gray-400 leading-relaxed group-hover:text-gray-300 transition-colors">
							{cap.description}
						</p>
					</button>
				))}
			</div>
		</div>
	);
};
