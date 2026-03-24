/**
 * modelsApi - Model操作の共通APIクライアント
 *
 * ModelSettings.tsx と ModelHub.tsx の重複する apiClient 呼び出しを
 * このモジュールに集約する。
 */

import { apiClient } from "../../utils/api-client";
import { ENDPOINTS } from "../../utils/endpoints";
import type { ModelInfo } from "../../types";

// --- 型定義 ---

export interface ModelRoles {
    character_model_id: string | null;
    character_model_map: Record<string, string>;
    agent_model_map: Record<string, string>;
    professional_model_map: Record<string, string>;
}

// --- API操作 ---

export const modelsApi = {
    /** 登録済みモデル一覧を取得 */
    list: () => apiClient.get<{ models?: ModelInfo[] }>(ENDPOINTS.SETUP.MODELS),

    /** モデルロール割り当て情報を取得 */
    getRoles: () => apiClient.get<ModelRoles>(ENDPOINTS.SETUP.MODEL_ROLES),

    /** デフォルトキャラクターモデルを設定 */
    setCharacterRole: (model_id: string) =>
        apiClient.post(ENDPOINTS.SETUP.MODEL_ROLES_CHARACTER, { model_id }),

    /** キャラクター固有のモデルを設定 */
    setCharacterScopedRole: (characterId: string, model_id: string) =>
        apiClient.post(ENDPOINTS.SETUP.MODEL_ROLES_CHARACTER_SCOPED(characterId), {
            model_id,
        }),

    /** キャラクター固有のモデル割り当てを削除 */
    deleteCharacterScopedRole: (characterId: string) =>
        apiClient.delete(ENDPOINTS.SETUP.MODEL_ROLES_CHARACTER_SCOPED(characterId)),

    /** エージェント固有のモデルを設定 */
    setAgentScopedRole: (agentId: string, model_id: string) =>
        apiClient.post(ENDPOINTS.SETUP.MODEL_ROLES_AGENT_SCOPED(agentId), {
            model_id,
        }),

    /** エージェント固有のモデル割り当てを削除 */
    deleteAgentScopedRole: (agentId: string) =>
        apiClient.delete(ENDPOINTS.SETUP.MODEL_ROLES_AGENT_SCOPED(agentId)),

    /** プロフェッショナルタスクのデフォルトモデルを設定 */
    setProfessionalRole: (task_type: string, model_id: string) =>
        apiClient.post(ENDPOINTS.SETUP.MODEL_ROLES_PROFESSIONAL, {
            task_type,
            model_id,
        }),

    /** アクティブモデルを設定 */
    setActive: (model_id: string, assignment_key: string) =>
        apiClient.post(ENDPOINTS.SETUP.MODEL_ACTIVE, { model_id, assignment_key }),

    /** モデルの表示順を変更 */
    reorder: (modality: string, model_ids: string[]) =>
        apiClient.post(ENDPOINTS.SETUP.MODEL_REORDER, { modality, model_ids }),

    /** モデルを削除 */
    delete: (id: string) => apiClient.delete(ENDPOINTS.SETUP.MODEL_DETAIL(id)),
};

// --- ユーティリティ ---

/**
 * embeddingモデルの設定ファイルパス文字列を解決する。
 *
 * 優先度:
 * 1. `model.file_path` があればそのまま返す
 * 2. Ollama モデル → `ollama://<filename>`
 * 3. LM Studio モデル → `lmstudio://<filename>`
 * 4. ローカル GGUF → `models/embedding/<filename>`
 * 5. いずれも該当しない場合は空文字
 */
export function resolveEmbeddingModelPath(model: ModelInfo): string {
    if (model.file_path) return model.file_path;
    const isOllama = model.source === "ollama" || model.loader === "ollama";
    const isLmStudio =
        model.source === "lmstudio" || model.loader === "lmstudio";
    if (isOllama && model.filename) return `ollama://${model.filename}`;
    if (isLmStudio && model.filename) return `lmstudio://${model.filename}`;
    if (model.filename) return `models/embedding/${model.filename}`;
    return "";
}
