import React, { useState, useEffect, useCallback } from 'react';
import {
    Download,
    Trash2,
    CheckCircle,
    XCircle,
    Loader2,
    FolderOpen,
    RefreshCw,
    HardDrive,
    Cpu,
} from 'lucide-react';
import { SettingsSection } from './SettingsComponents';
import { API_BASE, getAuthHeaders } from '../../utils/api';

interface ModelInfo {
    id: string;
    display_name: string;
    role: string;
    file_size: number;
    source: string;
    is_active: boolean;
}

interface RequirementsStatus {
    is_ready: boolean;
    binary: {
        status: string;
        version: string | null;
    };
    models: Record<string, { status: string; name: string | null }>;
}

const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const ModelManagerSettings: React.FC = () => {
    const [requirements, setRequirements] = useState<RequirementsStatus | null>(null);
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [downloading, setDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState({ progress: 0, message: '' });
    const [error, setError] = useState<string | null>(null);

    // 要件チェックを取得
    const fetchRequirements = useCallback(async () => {
        try {
            const response = await fetch(`${API_BASE}/api/setup/requirements`, {
                headers: { ...getAuthHeaders() }
            });
            if (response.ok) {
                setRequirements(await response.json());
            }
        } catch (err) {
            console.error('Failed to fetch requirements:', err);
        }
    }, []);

    // モデル一覧を取得
    const fetchModels = useCallback(async () => {
        try {
            const response = await fetch(`${API_BASE}/api/setup/models`, {
                headers: { ...getAuthHeaders() }
            });
            if (response.ok) {
                const data = await response.json();
                setModels(data.models || []);
            }
        } catch (err) {
            console.error('Failed to fetch models:', err);
        }
    }, []);

    // 初回ロード
    useEffect(() => {
        const load = async () => {
            setLoading(true);
            await Promise.all([fetchRequirements(), fetchModels()]);
            setLoading(false);
        };
        load();
    }, [fetchRequirements, fetchModels]);

    // 進捗ポーリング
    useEffect(() => {
        if (!downloading) return;
        const interval = setInterval(async () => {
            try {
                const response = await fetch(`${API_BASE}/api/setup/progress`, {
                    headers: { ...getAuthHeaders() }
                });
                if (response.ok) {
                    const data = await response.json();
                    setDownloadProgress({ progress: data.progress, message: data.message });
                    if (data.status === 'completed' || data.status === 'failed') {
                        setDownloading(false);
                        fetchRequirements();
                        fetchModels();
                    }
                }
            } catch {
                // ignore
            }
        }, 500);
        return () => clearInterval(interval);
    }, [downloading, fetchRequirements, fetchModels]);

    // llama.cppをダウンロード
    const handleDownloadBinary = async () => {
        try {
            setDownloading(true);
            setError(null);
            const response = await fetch(`${API_BASE}/api/setup/binary/download`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...getAuthHeaders()
                },
                body: JSON.stringify({ variant: 'auto' }),
            });
            if (!response.ok) throw new Error('Download failed');
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Download failed');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
            setDownloading(false);
        }
    };

    // モデルをダウンロード
    const handleDownloadModel = async (role: string) => {
        const defaultModels: Record<string, { repo_id: string; filename: string; display_name: string }> = {
            character: {
                repo_id: 'unsloth/gemma-3n-E4B-it-GGUF',
                filename: 'gemma-3n-E4B-it-IQ4_XS.gguf',
                display_name: 'Gemma-3N-E4B (IQ4_XS)',
            },
            executor: {
                repo_id: 'Menlo/granite-4.0-h-micro-preview-gguf',
                filename: 'granite-4.0-h-micro-IQ4_XS.gguf',
                display_name: 'Granite-4.0-Micro (IQ4_XS)',
            },
            embedding: {
                repo_id: 'Google/embeddinggemma-gguf',
                filename: 'embeddinggemma-300M-Q8_0.gguf',
                display_name: 'EmbeddingGemma-300M (Q8_0)',
            },
        };

        const model = defaultModels[role];
        if (!model) return;

        try {
            setDownloading(true);
            setError(null);
            const response = await fetch(`${API_BASE}/api/setup/model/download`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...getAuthHeaders()
                },
                body: JSON.stringify({ ...model, role }),
            });
            if (!response.ok) throw new Error('Download failed');
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Download failed');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
            setDownloading(false);
        }
    };

    // モデルを削除
    const handleDeleteModel = async (id: string) => {
        if (!confirm('このモデルを削除しますか？')) return;
        try {
            setError(null);
            const response = await fetch(`${API_BASE}/api/setup/model/${id}`, {
                method: 'DELETE',
                headers: { ...getAuthHeaders() }
            });
            if (!response.ok) throw new Error('Delete failed');
            const result = await response.json();
            if (!result.success) throw new Error(result.error || 'Delete failed');
            // Refresh the model list
            await fetchModels();
            await fetchRequirements();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        }
    };

    // モデルをアクティブに設定
    const handleSetActiveModel = async (id: string, role: string) => {
        try {
            setError(null);
            const response = await fetch(`${API_BASE}/api/setup/model/active`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...getAuthHeaders()
                },
                body: JSON.stringify({ model_id: id, role }),
            });
            if (!response.ok) throw new Error('Failed to set active model');
            const result = await response.json();
            if (!result.success) throw new Error(result.error || 'Failed to set active model');
            await fetchModels();
            await fetchRequirements();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        }
    };

    // ロール名を日本語に
    const roleLabel = (role: string) => {
        const labels: Record<string, string> = {
            character: 'キャラクター',
            executor: 'エグゼキューター',
            embedding: '埋め込み',
        };
        return labels[role] || role;
    };

    if (loading) {
        return (
            <div className="flex justify-center py-8">
                <Loader2 className="animate-spin" size={32} />
            </div>
        );
    }

    return (
        <>
            {/* llama.cpp Status */}
            <SettingsSection title="推論エンジン (llama.cpp)" icon={<Cpu size={18} />} description="ローカル推論用のバイナリ">
                <div className="settings-model-card">
                    <div className="settings-model-card__header">
                        {requirements?.binary.status === 'satisfied' ? (
                            <CheckCircle size={18} className="text-green-400" />
                        ) : (
                            <XCircle size={18} className="text-red-400" />
                        )}
                        <h3 className="settings-model-card__title">
                            {requirements?.binary.version || '未インストール'}
                        </h3>
                        <div className="ml-auto flex gap-2">
                            <button
                                onClick={fetchRequirements}
                                className="settings-list__add-button"
                                disabled={downloading}
                                title="更新チェック"
                            >
                                <RefreshCw size={16} />
                            </button>
                            {requirements?.binary.status !== 'satisfied' && (
                                <button
                                    onClick={handleDownloadBinary}
                                    className="settings-list__add-button"
                                    disabled={downloading}
                                >
                                    <Download size={16} />
                                    ダウンロード
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </SettingsSection>

            {/* Models */}
            <SettingsSection title="GGUFモデル" icon={<HardDrive size={18} />} description="ダウンロード済みのモデル一覧">
                {(['character', 'executor', 'embedding'] as const).map((role) => {
                    const roleModels = models.filter((m) => m.role === role);
                    const hasActive = roleModels.some((m) => m.is_active);
                    const status = requirements?.models[role];

                    return (
                        <div key={role} className="settings-model-card" style={{ marginBottom: '1rem' }}>
                            <div className="settings-model-card__header">
                                {status?.status === 'satisfied' ? (
                                    <CheckCircle size={18} className="text-green-400" />
                                ) : (
                                    <XCircle size={18} className="text-red-400" />
                                )}
                                <h3 className="settings-model-card__title">{roleLabel(role)}モデル</h3>
                                <div className="ml-auto flex gap-2">
                                    {!hasActive && (
                                        <button
                                            onClick={() => handleDownloadModel(role)}
                                            className="settings-list__add-button"
                                            disabled={downloading}
                                        >
                                            <Download size={16} />
                                            ダウンロード
                                        </button>
                                    )}
                                </div>
                            </div>

                            {roleModels.length > 0 ? (
                                <div className="settings-model-card__grid">
                                    {roleModels.map((model) => (
                                        <div
                                            key={model.id}
                                            className="settings-list__item"
                                            style={{
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                alignItems: 'center',
                                                padding: '0.75rem',
                                                background: model.is_active ? 'rgba(34, 197, 94, 0.1)' : 'transparent',
                                                borderRadius: '0.5rem',
                                                cursor: !model.is_active ? 'pointer' : 'default',
                                            }}
                                            onClick={() => !model.is_active && handleSetActiveModel(model.id, role)}
                                            title={!model.is_active ? 'クリックでアクティブにする' : undefined}
                                        >
                                            <div style={{ flex: 1 }}>
                                                <div className="settings-list__item-text" style={{ fontWeight: 500 }}>
                                                    {model.display_name}
                                                    {model.is_active && (
                                                        <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: 'rgb(34, 197, 94)' }}>
                                                            (アクティブ)
                                                        </span>
                                                    )}
                                                </div>
                                                <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)' }}>
                                                    {formatFileSize(model.file_size)} • {model.source}
                                                </div>
                                            </div>
                                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                                {!model.is_active && (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleSetActiveModel(model.id, role);
                                                        }}
                                                        className="settings-list__add-button"
                                                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                                        title="アクティブにする"
                                                    >
                                                        <CheckCircle size={12} />
                                                        選択
                                                    </button>
                                                )}
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleDeleteModel(model.id);
                                                    }}
                                                    className="settings-list__item-remove"
                                                    title="削除"
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div style={{ padding: '1rem', color: 'rgba(255,255,255,0.4)', fontSize: '0.875rem' }}>
                                    モデルがありません
                                </div>
                            )}
                        </div>
                    );
                })}

                {/* Add Local Model */}
                <div style={{ marginTop: '1rem' }}>
                    <button
                        className="settings-list__add-button"
                        style={{ width: '100%', justifyContent: 'center', padding: '0.75rem' }}
                        onClick={() => alert('ローカルファイル追加機能は開発中です')}
                    >
                        <FolderOpen size={16} />
                        ローカルファイルを追加
                    </button>
                </div>
            </SettingsSection>

            {/* Progress Bar */}
            {downloading && (
                <div style={{ marginTop: '1rem', padding: '1rem' }} className="settings-model-card">
                    <div style={{ marginBottom: '0.5rem', fontSize: '0.875rem' }}>{downloadProgress.message || 'ダウンロード中...'}</div>
                    <div style={{ height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div
                            style={{
                                height: '100%',
                                width: `${downloadProgress.progress * 100}%`,
                                background: 'linear-gradient(to right, #8a5a4c, #d4af37)',
                                transition: 'width 300ms',
                            }}
                        />
                    </div>
                </div>
            )}

            {/* Error */}
            {error && (
                <div style={{ marginTop: '1rem', padding: '1rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '0.5rem', color: '#fca5a5', fontSize: '0.875rem' }}>
                    {error}
                </div>
            )}
        </>
    );
};

export default ModelManagerSettings;
