import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../shared/ui/Button";
import { Select } from "../../../../shared/ui/Select";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import { useSettingsEditor } from "../../model/editor";
import { ModelHubOverlay } from "../ModelHubOverlay";
import { BinaryUpdatePanel } from "../components/BinaryUpdatePanel";
import { DownloadModelPanel } from "../components/DownloadModelPanel";

interface ModelsSettingsProps {
	activeTab?: string;
}

export const ModelsSettings: React.FC<ModelsSettingsProps> = ({
	activeTab = "Hub",
}) => {
	const { t } = useTranslation();
	const editor = useSettingsEditor();
	const [isModelHubOpen, setIsModelHubOpen] = useState(false);
	const hasModels =
		editor.textModels.length > 0 || editor.embeddingModels.length > 0;

	const content = (() => {
		if (activeTab === "Hub") {
			return (
				<SettingsSectionGroup title={t("v2.settings.modelsHub", "Model Hub")}>
					<SettingsRow
						label={t("v2.settings.installedModels", "Installed Models")}
						description={t(
							"v2.settings.installedModelsDescription",
							"Open the fullscreen model hub to scan providers, download, and update models.",
						)}
					>
						<div className="flex flex-wrap items-center gap-4">
							<div className="rounded-full border border-primary/15 bg-primary/5 px-3 py-1 text-sm text-text-main">
								{editor.textModels.length} {t("v2.settings.textModels", "text models")}
							</div>
							<div className="rounded-full border border-primary/15 bg-primary/5 px-3 py-1 text-sm text-text-main">
								{editor.embeddingModels.length} {t("v2.settings.embeddingModels", "embedding models")}
							</div>
							<Button type="button" onClick={() => setIsModelHubOpen(true)}>
								{t("modelHub.title", "Model Hub")}
							</Button>
						</div>
					</SettingsRow>
					<div className="mt-4">
						<DownloadModelPanel />
					</div>
				</SettingsSectionGroup>
			);
		}

		if (activeTab === "Defaults") {
			return (
				<SettingsSectionGroup title={t("v2.settings.defaults", "Defaults")}>
					<SettingsRow
						label={t("v2.settings.globalDefaultModel", "Global Default Model")}
						description={t(
							"v2.settings.globalDefaultModelDescription",
							"Active text runtime used for chat, characters, and shared prompts.",
						)}
					>
						<div className="w-full max-w-md">
							<Select
								value={editor.activeTextModelId ?? ""}
								onChange={(event) =>
									void editor.activateModel(event.target.value, "character")
								}
								disabled={!editor.textModels.length || editor.isModelUpdating}
							>
								{editor.textModels.length ? null : (
									<option value="">{t("v2.settings.noTextModels", "No text models available")}</option>
								)}
								{editor.textModels.map((model) => (
									<option key={model.id} value={model.id}>
										{model.display_name}
									</option>
								))}
							</Select>
						</div>
					</SettingsRow>
				</SettingsSectionGroup>
			);
		}

		if (activeTab === "Embedding") {
			return (
				<SettingsSectionGroup title={t("v2.settings.embedding", "Embedding")}>
					<SettingsRow
						label={t("v2.settings.vectorModel", "Vector Model")}
						description={t(
							"v2.settings.vectorModelDescription",
							"Embedding runtime used for retrieval and RAG.",
						)}
					>
						<div className="w-full max-w-md">
							<Select
								value={editor.activeEmbeddingModelId ?? ""}
								onChange={(event) =>
									void editor.activateModel(event.target.value, "embedding")
								}
								disabled={!editor.embeddingModels.length || editor.isModelUpdating}
							>
								{editor.embeddingModels.length ? null : (
									<option value="">{t("v2.settings.noEmbeddingModels", "No embedding models available")}</option>
								)}
								{editor.embeddingModels.map((model) => (
									<option key={model.id} value={model.id}>
										{model.display_name}
									</option>
								))}
							</Select>
						</div>
					</SettingsRow>
				</SettingsSectionGroup>
			);
		}

		if (activeTab === "Loader") {
			return (
				<SettingsSectionGroup title={t("v2.settings.loader", "Loader")}>
					<SettingsRow label={t("v2.settings.ollamaBaseUrl", "Ollama Base URL")}>
						<div className="w-full max-w-xl">
							<TextField
								value={editor.readString("loaders.ollama.base_url", "http://localhost:11434")}
								onChange={(event) =>
									editor.updateField("loaders.ollama.base_url", event.target.value)
								}
								placeholder="http://localhost:11434"
							/>
						</div>
					</SettingsRow>
					<SettingsRow label={t("v2.settings.lmStudioBaseUrl", "LM Studio Base URL")}>
						<div className="w-full max-w-xl">
							<TextField
								value={editor.readString("loaders.lmstudio.base_url", "http://localhost:1234")}
								onChange={(event) =>
									editor.updateField("loaders.lmstudio.base_url", event.target.value)
								}
								placeholder="http://localhost:1234"
							/>
						</div>
					</SettingsRow>
					<div className="mt-6 border-t border-border/30 pt-6">
						<BinaryUpdatePanel />
					</div>
				</SettingsSectionGroup>
			);
		}

		return (
			<SettingsSectionGroup title={t("v2.settings.modelsAdvanced", "Advanced")}>
				<SettingsRow
					label={t("v2.settings.runtimeLoader", "Runtime Loader")}
					description={t(
						"v2.settings.runtimeLoaderDescription",
						"Default backend loader used when resolving active models.",
					)}
				>
					<div className="w-full max-w-sm">
						<Select
							value={editor.readString("llm_manager.loader", "ollama")}
							onChange={(event) =>
								editor.updateField("llm_manager.loader", event.target.value)
							}
						>
							<option value="ollama">Ollama</option>
							<option value="lmstudio">LM Studio</option>
							<option value="llama_cpp">llama.cpp</option>
						</Select>
					</div>
				</SettingsRow>
				{hasModels ? (
					<div className="text-sm leading-7 text-text-muted">
						{t(
							"v2.settings.roleApply",
							"Model role changes apply immediately through the setup API.",
						)}
					</div>
				) : null}
			</SettingsSectionGroup>
		);
	})();

	return (
		<>
			{content}
			<ModelHubOverlay isOpen={isModelHubOpen} onClose={() => setIsModelHubOpen(false)} />
		</>
	);
};
