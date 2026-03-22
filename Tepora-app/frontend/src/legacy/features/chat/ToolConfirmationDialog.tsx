import { AlertTriangle, Check, Clock3, ExternalLink, ShieldAlert, X } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import Modal from "../../components/ui/Modal";

import type { ToolConfirmationRequest } from "../../../types";

interface ToolConfirmationDialogProps {
	request: ToolConfirmationRequest | null;
	onRespond: (requestId: string, decision: "deny" | "once" | "always_until_expiry", ttlSeconds?: number) => void;
}

const TOOL_NAME_ACRONYMS = new Set(["API", "HTTP", "HTTPS", "JSON", "LLM", "MCP", "URL"]);

const toTitleWord = (token: string) => {
	const upper = token.toUpperCase();
	if (TOOL_NAME_ACRONYMS.has(upper)) return upper;
	return token.charAt(0).toUpperCase() + token.slice(1);
};

const humanizeToolName = (toolName: string) => {
	if (!toolName) return toolName;
	const spaced = toolName
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	if (!spaced) return toolName;
	return spaced.split(" ").map(toTitleWord).join(" ");
};

const replaceToolName = (text: string, toolName: string, displayName: string) => {
	if (!text || !toolName) return text;
	return text.split(toolName).join(displayName);
};

const formatDuration = (seconds: number) => {
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
};

const riskTone: Record<string, string> = {
	low: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
	medium: "bg-amber-500/15 text-amber-200 border-amber-500/30",
	high: "bg-orange-500/15 text-orange-200 border-orange-500/30",
	critical: "bg-red-500/15 text-red-200 border-red-500/30",
};

const ToolConfirmationDialog: React.FC<ToolConfirmationDialogProps> = ({
	request,
	onRespond,
}) => {
	const { t } = useTranslation();
	const [ttlSeconds, setTtlSeconds] = React.useState<number | undefined>(undefined);

	React.useEffect(() => {
		if (!request) {
			setTtlSeconds(undefined);
			return;
		}
		const preferred = request.expiryOptions.find((option) => option === 24 * 60 * 60);
		setTtlSeconds(preferred ?? request.expiryOptions[0]);
	}, [request]);

	if (!request) return null;

	const translatedName = t(`tool_confirmation.names.${request.toolName}`);
	const displayName =
		translatedName !== `tool_confirmation.names.${request.toolName}`
			? translatedName
			: humanizeToolName(request.toolName);

	const translatedDescription = t(`tool_confirmation.descriptions.${request.toolName}`);
	const fallbackDescription = t(
		"tool_confirmation.description",
		"このツールを実行しようとしています。",
	);
	const description =
		translatedDescription !== `tool_confirmation.descriptions.${request.toolName}`
			? translatedDescription
			: request.description
				? replaceToolName(request.description, request.toolName, displayName)
				: fallbackDescription;

	return (
		<Modal
			isOpen={true}
			onClose={() => onRespond(request.requestId, "deny")}
			title={t("tool_confirmation.title", "ツール実行の確認")}
			size="lg"
		>
			<div className="p-6 space-y-6">
				<div className="flex items-start gap-4">
					<div className="flex-shrink-0 w-12 h-12 rounded-full bg-amber-500/20 flex items-center justify-center">
						<AlertTriangle className="w-6 h-6 text-amber-400" />
					</div>
					<div className="space-y-3 flex-1">
						<div>
							<h3 className="text-lg font-semibold text-white mb-1">{displayName}</h3>
							<p className="text-gray-400 text-sm">{description}</p>
						</div>
						<div className="flex flex-wrap gap-2 text-xs">
							<span className={`px-2.5 py-1 rounded-full border ${riskTone[request.riskLevel] || riskTone.medium}`}>
								{t("tool_confirmation.risk", "Risk")} : {request.riskLevel}
							</span>
							<span className="px-2.5 py-1 rounded-full border border-white/10 bg-white/5 text-gray-200">
								{request.scope === "mcp_server" ? "MCP" : "Native"} : {request.scopeName}
							</span>
						</div>
					</div>
				</div>

				<div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
					<div className="bg-black/30 rounded-lg p-4 border border-white/10">
						<h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
							{t("tool_confirmation.params", "パラメータ")}
						</h4>
						<pre className="text-sm text-gray-300 whitespace-pre-wrap break-all font-mono">
							{JSON.stringify(request.toolArgs, null, 2)}
						</pre>
					</div>

					<div className="bg-white/5 rounded-lg p-4 border border-white/10 space-y-3">
						<div className="flex items-center gap-2 text-sm text-gray-200">
							<Clock3 className="w-4 h-4 text-gold-300" />
							<span>{t("tool_confirmation.expiry", "許可期限")}</span>
						</div>
						<select
							value={ttlSeconds}
							onChange={(e) => setTtlSeconds(Number(e.target.value))}
							className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
						>
							{request.expiryOptions.map((option) => (
								<option key={option} value={option} className="bg-[#101217] text-white">
									{formatDuration(option)}
								</option>
							))}
						</select>
						<p className="text-xs text-gray-400">
							{t("tool_confirmation.expiry_hint", "常時許可を選んだ場合のみ適用されます。")}
						</p>
					</div>
				</div>

				{request.toolName === "native_web_fetch" && typeof request.toolArgs.url === "string" && (
					<div className="flex items-center gap-2 text-sm text-blue-400">
						<ExternalLink className="w-4 h-4" />
						<span className="truncate">{request.toolArgs.url}</span>
					</div>
				)}

				<div className="text-xs text-amber-300/90 bg-amber-500/10 rounded-lg px-3 py-2 border border-amber-500/20 flex items-start gap-2">
					<ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
					<span>
						{t("tool_confirmation.warning_deny", "拒否すると当該処理は中断されます。常時許可は期限内のみ再利用されます。")}
					</span>
				</div>

				<div className="grid gap-3 md:grid-cols-3 pt-2">
					<button
						type="button"
						onClick={() => onRespond(request.requestId, "deny")}
						className="flex-1 px-4 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-600 text-gray-300 hover:text-white font-medium text-sm transition-all duration-200 flex items-center justify-center gap-2"
					>
						<X className="w-4 h-4" />
						{t("tool_confirmation.deny", "拒否")}
					</button>
					<button
						type="button"
						onClick={() => onRespond(request.requestId, "once")}
						className="flex-1 px-4 py-3 rounded-lg bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 text-white font-medium text-sm transition-all duration-200 flex items-center justify-center gap-2 shadow-lg shadow-green-500/20"
					>
						<Check className="w-4 h-4" />
						{t("tool_confirmation.allow_once", "今回のみ許可")}
					</button>
					<button
						type="button"
						onClick={() => onRespond(request.requestId, "always_until_expiry", ttlSeconds)}
						className="flex-1 px-4 py-3 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white font-medium text-sm transition-all duration-200 flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20"
					>
						<Clock3 className="w-4 h-4" />
						{t("tool_confirmation.allow_until_expiry", "期限付きで常時許可")}
					</button>
				</div>
			</div>
		</Modal>
	);
};

export default ToolConfirmationDialog;

