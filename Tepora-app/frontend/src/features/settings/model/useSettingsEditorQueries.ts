import {
	useSaveV2ConfigMutation,
	useSetActiveSetupModelMutation,
	useV2ConfigQuery,
	useV2SetupModelsQuery,
} from "./queries";

export function useSettingsEditorQueries() {
	const configQuery = useV2ConfigQuery();
	const saveMutation = useSaveV2ConfigMutation();
	const modelsQuery = useV2SetupModelsQuery();
	const setActiveModelMutation = useSetActiveSetupModelMutation();

	const modelList = modelsQuery.data?.models ?? [];
	const textModels = modelList.filter((model) => (model.role ?? "text") !== "embedding");
	const embeddingModels = modelList.filter((model) => model.role === "embedding");
	const activeTextModelId =
		textModels.find((model) => Boolean(model.is_active))?.id ?? null;
	const activeEmbeddingModelId =
		embeddingModels.find((model) => Boolean(model.is_active))?.id ?? null;

	return {
		configQuery,
		saveMutation,
		modelsQuery,
		setActiveModelMutation,
		textModels,
		embeddingModels,
		activeTextModelId,
		activeEmbeddingModelId,
	};
}
