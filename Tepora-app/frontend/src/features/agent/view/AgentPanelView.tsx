import React from "react";
import { useTranslation } from "react-i18next";
import { Chip } from "../../../shared/ui/Chip";
import type { AgentPanelViewProps } from "./props";

export const AgentPanelView: React.FC<AgentPanelViewProps> = ({
	state,
	title,
	subtitle,
	sections,
	activeContext,
	toolConfirmation,
	errorMessage,
	onToolDecision,
}) => {
	const { t } = useTranslation();

	return (
		<div className="flex h-full flex-col overflow-hidden text-text-main">
			<div className="mb-8 border-b border-white/8 pb-4">
				<div className="font-serif text-[1.45rem] italic text-primary">{title}</div>
				<div className="mt-2 text-[0.72rem] uppercase tracking-[0.18em] text-text-muted">
					{subtitle}
				</div>
			</div>

			{errorMessage ? (
				<div className="mb-4 rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
					{errorMessage}
				</div>
			) : null}

			<div className="custom-scrollbar -mr-2 flex flex-1 flex-col overflow-y-auto pr-2 pb-10">
				{activeContext.length > 0 ? (
					<div className="mb-8">
						<div className="mb-4 text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-primary/55">
							{t("v2.agent.activeContext", "Active context")}
						</div>
						<div className="flex flex-wrap gap-2">
							{activeContext.map((context) => (
								<Chip key={context.id} active={context.kind === "agent"}>
									{context.label}
								</Chip>
							))}
						</div>
					</div>
				) : null}

				{toolConfirmation ? (
					<div className="mb-8">
						<div className="mb-4 text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-primary/55">
							{t("v2.agent.approvalRequired", "Approval required")}
						</div>
						<div className="rounded-[24px] border border-primary/15 bg-surface/35 p-4 text-sm leading-7 text-text-muted">
							<div className="text-base font-medium text-text-main">
								{toolConfirmation.toolName}
							</div>
							<div className="mt-2 text-xs uppercase tracking-[0.14em] text-primary/75">
								{toolConfirmation.riskLevel} {t("v2.agent.risk", "risk")}
							</div>
							{toolConfirmation.description ? (
								<p className="mt-3">{toolConfirmation.description}</p>
							) : null}
							<p className="mt-3">{toolConfirmation.scopeLabel}</p>
							<pre className="mt-3 max-h-40 overflow-auto rounded-2xl bg-black/25 p-3 text-xs text-text-main/85">
								{toolConfirmation.argsPreview}
							</pre>
							<div className="mt-4 flex flex-wrap gap-2">
								<button
									type="button"
									onClick={() => void onToolDecision("deny")}
									className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-text-main transition-colors hover:border-primary/30 hover:text-primary"
								>
									{t("v2.agent.deny", "Deny")}
								</button>
								<button
									type="button"
									onClick={() => void onToolDecision("once")}
									className="rounded-full border border-primary/25 px-3 py-1.5 text-xs text-primary transition-colors hover:border-primary/40"
								>
									{t("v2.agent.approveOnce", "Approve once")}
								</button>
								{toolConfirmation.expiryOptions[0] ? (
									<button
										type="button"
										onClick={() =>
											void onToolDecision(
												"always_until_expiry",
												toolConfirmation.expiryOptions[0],
											)
										}
										className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-text-main transition-colors hover:border-primary/30 hover:text-primary"
									>
										{t("v2.agent.allowTemporary", "Allow temporarily")}
									</button>
								) : null}
							</div>
						</div>
					</div>
				) : null}

				{sections.map((section) => (
					<div key={section.id} className="mb-8">
						<div className="mb-4 text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-primary/55">
							{section.title}
						</div>
						<div className="whitespace-pre-wrap rounded-[24px] border border-white/8 bg-surface/25 p-4 text-sm leading-7 text-text-muted">
							{section.body}
						</div>
					</div>
				))}

				{state === "loading" ? (
					<div className="mt-2 text-sm text-text-muted/70">
						{t("v2.common.loading", "Loading...")}
					</div>
				) : null}
			</div>
		</div>
	);
};
