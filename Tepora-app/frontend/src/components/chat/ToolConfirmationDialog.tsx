import { AlertTriangle, Check, ExternalLink, X } from "lucide-react";
import React from "react";
import Modal from "../ui/Modal";

export interface ToolConfirmationRequest {
	requestId: string;
	toolName: string;
	toolArgs: Record<string, unknown>;
	description?: string;
}

interface ToolConfirmationDialogProps {
	request: ToolConfirmationRequest | null;
	onAllow: (requestId: string, rememberChoice: boolean) => void;
	onDeny: (requestId: string) => void;
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
	native_web_fetch: "Webページ取得",
	native_google_search: "Google検索",
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
	native_web_fetch: "指定されたURLのWebページにアクセスします。",
	native_google_search: "Googleでウェブ検索を実行します。",
};

/**
 * Dialog for confirming dangerous tool execution.
 * Shows tool name, arguments, and allows user to approve or deny.
 */
const ToolConfirmationDialog: React.FC<ToolConfirmationDialogProps> = ({
	request,
	onAllow,
	onDeny,
}) => {
	const [rememberChoice, setRememberChoice] = React.useState(false);

	if (!request) return null;

	const displayName = TOOL_DISPLAY_NAMES[request.toolName] || request.toolName;
	const description =
		request.description ||
		TOOL_DESCRIPTIONS[request.toolName] ||
		"このツールを実行しようとしています。";

	return (
		<Modal
			isOpen={true}
			onClose={() => onDeny(request.requestId)}
			title="ツール実行の確認"
			size="md"
		>
			<div className="p-6 space-y-6">
				{/* Warning Icon and Message */}
				<div className="flex items-start gap-4">
					<div className="flex-shrink-0 w-12 h-12 rounded-full bg-amber-500/20 flex items-center justify-center">
						<AlertTriangle className="w-6 h-6 text-amber-400" />
					</div>
					<div>
						<h3 className="text-lg font-semibold text-white mb-1">
							{displayName}
						</h3>
						<p className="text-gray-400 text-sm">{description}</p>
					</div>
				</div>

				{/* Tool Arguments */}
				<div className="bg-black/30 rounded-lg p-4 border border-white/10">
					<h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
						パラメータ
					</h4>
					<pre className="text-sm text-gray-300 whitespace-pre-wrap break-all font-mono">
						{JSON.stringify(request.toolArgs, null, 2)}
					</pre>
				</div>

				{/* URL Preview for web_fetch */}
				{request.toolName === "native_web_fetch" &&
					typeof request.toolArgs.url === "string" && (
						<div className="flex items-center gap-2 text-sm text-blue-400">
							<ExternalLink className="w-4 h-4" />
							<span className="truncate">{request.toolArgs.url}</span>
						</div>
					)}

				{/* Remember Choice */}
				<label className="flex items-center gap-3 cursor-pointer group">
					<input
						type="checkbox"
						checked={rememberChoice}
						onChange={(e) => setRememberChoice(e.target.checked)}
						className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-gold-500 focus:ring-gold-500/50"
					/>
					<span className="text-sm text-gray-400 group-hover:text-gray-300 transition-colors">
						このセッション中は同じツールを自動的に許可する
					</span>
				</label>

				{/* Warning about non-blocking behavior */}
				<div className="text-xs text-amber-400/80 bg-amber-500/10 rounded-lg px-3 py-2 border border-amber-500/20">
					⚠️ 拒否すると処理を中断します
				</div>

				{/* Action Buttons */}
				<div className="flex gap-3 pt-2">
					<button
						type="button"
						onClick={() => onDeny(request.requestId)}
						className="
              flex-1 px-4 py-3 rounded-lg
              bg-gray-800 hover:bg-gray-700
              border border-gray-700 hover:border-gray-600
              text-gray-300 hover:text-white
              font-medium text-sm
              transition-all duration-200
              flex items-center justify-center gap-2
            "
					>
						<X className="w-4 h-4" />
						拒否
					</button>
					<button
						type="button"
						onClick={() => onAllow(request.requestId, rememberChoice)}
						className="
              flex-1 px-4 py-3 rounded-lg
              bg-gradient-to-r from-green-600 to-emerald-600
              hover:from-green-500 hover:to-emerald-500
              text-white font-medium text-sm
              transition-all duration-200
              flex items-center justify-center gap-2
              shadow-lg shadow-green-500/20
            "
					>
						<Check className="w-4 h-4" />
						許可
					</button>
				</div>
			</div>
		</Modal>
	);
};

export default ToolConfirmationDialog;
