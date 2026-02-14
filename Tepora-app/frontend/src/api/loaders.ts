import { apiClient } from "../utils/api-client";
import { ENDPOINTS } from "../utils/endpoints";

export const loadersApi = {
    refreshOllamaModels: () =>
        apiClient.post<void>(ENDPOINTS.LOADERS.OLLAMA.REFRESH),

    refreshLmStudioModels: () =>
        apiClient.post<void>(ENDPOINTS.LOADERS.LMSTUDIO.REFRESH),
};
