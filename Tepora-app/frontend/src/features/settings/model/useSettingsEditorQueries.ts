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
	const textModels = modelList.filter((model) => model.role === "text");
	const embeddingModels = modelList.filter((model) => model.role === "embedding");
	const activeTextModelId =
		textModels.find((model) => model.active_assignment_keys?.includes("character"))?.id ?? null;
	const activeEmbeddingModelId =
		embeddingModels.find((model) => model.active_assignment_keys?.includes("embedding"))?.id ??
		null;

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
