import { useState, useEffect, useCallback } from 'react';
import { Download, CheckCircle, XCircle, Loader2, AlertTriangle, Cpu, HardDrive, PlayCircle, Settings, X, Save } from 'lucide-react';
import { getApiBase, getAuthHeaders } from '../utils/api';
import { useTranslation } from 'react-i18next';

interface DefaultModelConfig {
    repo_id: string;
    filename: string;
    display_name: string;
}

interface DefaultModelsConfig {
    character: DefaultModelConfig | null;
    executor: DefaultModelConfig | null;
    embedding: DefaultModelConfig | null;
}

interface RequirementsStatus {
    is_ready: boolean;
    has_missing: boolean;
    binary: {
        status: 'satisfied' | 'missing' | 'outdated' | 'error';
        version: string | null;
    };
    models: {
        character: { status: 'satisfied' | 'missing' | 'outdated' | 'error'; name: string | null };
        executor: { status: 'satisfied' | 'missing' | 'outdated' | 'error'; name: string | null };
        embedding: { status: 'satisfied' | 'missing' | 'outdated' | 'error'; name: string | null };
    };
}

interface ProgressState {
    status: string;
    progress: number;
    message: string;
}

type SetupStep = 'language' | 'checking' | 'ready' | 'binary' | 'models' | 'complete' | 'error';

interface SetupWizardProps {
    onComplete: () => void;
    onSkip?: () => void;
}

export default function SetupWizard({ onComplete, onSkip }: SetupWizardProps) {
    const { t, i18n } = useTranslation();
    const [step, setStep] = useState<SetupStep>('language'); // Start with language
    const [requirements, setRequirements] = useState<RequirementsStatus | null>(null);
    const [progress, setProgress] = useState<ProgressState>({ status: 'idle', progress: 0, message: '' });
    const [error, setError] = useState<string | null>(null);
    const [isDownloading, setIsDownloading] = useState(false);

    // Config Modal
    const [showConfig, setShowConfig] = useState(false);
    const [customModels, setCustomModels] = useState<DefaultModelsConfig | null>(null);

    // Language selection handler
    const handleLanguageSelect = async (lang: string) => {
        await i18n.changeLanguage(lang);
        // Save language preference to backend
        try {
            await fetch(`${getApiBase()}/api/config`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    ...getAuthHeaders()
                },
                body: JSON.stringify({ language: lang })
            });
        } catch (err) {
            console.error('Failed to save language preference:', err);
        }
        setStep('checking');
        checkRequirements();
    };

    // Fetch default models
    const fetchDefaultModels = useCallback(async () => {
        try {
            const response = await fetch(`${getApiBase()}/api/setup/default-models`, {
                headers: { ...getAuthHeaders() }
            });
            if (response.ok) {
                const data: DefaultModelsConfig = await response.json();
                setCustomModels(data);
            }
        } catch (err) {
            console.error('Failed to fetch default models:', err);
        }
    }, []);

    useEffect(() => {
        fetchDefaultModels();
    }, [fetchDefaultModels]);

    // Check requirements
    const checkRequirements = useCallback(async () => {
        try {
            // Don't check if we are in language selection step
            if (step === 'language') return;

            setStep('checking');
            const response = await fetch(`${getApiBase()}/api/setup/requirements`, {
                headers: { ...getAuthHeaders() }
            });
            if (!response.ok) throw new Error('Failed to check requirements');

            const data: RequirementsStatus = await response.json();
            setRequirements(data);

            if (data.is_ready) {
                setStep('ready');
            } else {
                // Determine next step
                if (data.binary.status === 'missing') {
                    setStep('binary');
                } else if (Object.values(data.models).some(m => m.status === 'missing')) {
                    setStep('models');
                }
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
            setStep('error');
        }
    }, [step]); // Dependency on step to avoid loops if called incorrectly

    // Poll progress
    const pollProgress = useCallback(async () => {
        try {
            const response = await fetch(`${getApiBase()}/api/setup/progress`, {
                headers: { ...getAuthHeaders() }
            });
            if (response.ok) {
                const data: ProgressState = await response.json();
                setProgress(data);
                return data.status === 'completed' || data.status === 'failed';
            }
        } catch {
            // Ignore polling errors
        }
        return false;
    }, []);

    // Run setup
    const runFullSetup = useCallback(async () => {
        try {
            setIsDownloading(true);
            setError(null);

            const body = customModels ? { custom_models: customModels } : {};

            const response = await fetch(`${getApiBase()}/api/setup/run`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...getAuthHeaders()
                },
                body: JSON.stringify(body)
            });
            if (!response.ok) throw new Error(t('setup.error'));

            const result = await response.json();

            if (result.success) {
                setStep('complete');
            } else {
                setError(result.errors?.join(', ') || t('setup.error'));
                setStep('error');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
            setStep('error');
        } finally {
            setIsDownloading(false);
        }
    }, [customModels, t]);

    // Polling effect
    useEffect(() => {
        if (!isDownloading) return;

        const interval = setInterval(async () => {
            const done = await pollProgress();
            if (done) {
                clearInterval(interval);
            }
        }, 500);

        return () => clearInterval(interval);
    }, [isDownloading, pollProgress]);

    // Initial check (only if not choosing language)
    // Removed automatic check on mount to allow Language step to be first

    const StatusIcon = ({ status }: { status: string }) => {
        switch (status) {
            case 'satisfied':
            case 'installed':
                return <CheckCircle className="w-5 h-5 text-green-400" />;
            case 'missing':
            case 'not_downloaded':
                return <XCircle className="w-5 h-5 text-red-400" />;
            case 'outdated':
                return <AlertTriangle className="w-5 h-5 text-yellow-400" />;
            default:
                return <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />;
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
            <div className="glass-panel w-full max-w-lg mx-4 p-6 space-y-6">
                {/* Header */}
                <div className="text-center space-y-2">
                    <h1 className="text-2xl font-display text-gradient-gemini">{t('setup.title')}</h1>
                    <p className="text-gray-400 text-sm">
                        {step === 'language' && t('setup.steps.language')}
                        {step === 'checking' && t('setup.checking')}
                        {step === 'ready' && t('setup.ready')}
                        {step === 'binary' && t('setup.binary_needed')}
                        {step === 'models' && t('setup.models_needed')}
                        {step === 'complete' && t('setup.complete')}
                        {step === 'error' && t('setup.error')}
                    </p>
                </div>

                {/* Content */}
                <div className="space-y-4">
                    {/* Language Selection */}
                    {step === 'language' && (
                        <div className="grid grid-cols-2 gap-4 py-8">
                            <button
                                onClick={() => handleLanguageSelect('en')}
                                className="glass-button p-6 flex flex-col items-center gap-3 hover:bg-white/5 transition-all"
                            >
                                <span className="text-2xl">🇺🇸</span>
                                <span className="text-lg">English</span>
                            </button>
                            <button
                                onClick={() => handleLanguageSelect('ja')}
                                className="glass-button p-6 flex flex-col items-center gap-3 hover:bg-white/5 transition-all"
                            >
                                <span className="text-2xl">🇯🇵</span>
                                <span className="text-lg">日本語</span>
                            </button>
                            <button
                                onClick={() => handleLanguageSelect('zh')}
                                className="glass-button p-6 flex flex-col items-center gap-3 hover:bg-white/5 transition-all"
                            >
                                <span className="text-2xl">🇨🇳</span>
                                <span className="text-lg">中文</span>
                            </button>
                            <button
                                onClick={() => handleLanguageSelect('es')}
                                className="glass-button p-6 flex flex-col items-center gap-3 hover:bg-white/5 transition-all"
                            >
                                <span className="text-2xl">🇪🇸</span>
                                <span className="text-lg">Español</span>
                            </button>
                        </div>
                    )}

                    {/* Loading */}
                    {step === 'checking' && (
                        <div className="flex justify-center py-8">
                            <Loader2 className="w-12 h-12 text-gold-400 animate-spin" />
                        </div>
                    )}

                    {/* Requirements Status */}
                    {requirements && step !== 'language' && step !== 'checking' && step !== 'complete' && (
                        <div className="space-y-3">
                            {/* Binary */}
                            <div className="flex items-center justify-between p-3 rounded-lg bg-black/30">
                                <div className="flex items-center gap-3">
                                    <Cpu className="w-5 h-5 text-coffee-400" />
                                    <div>
                                        <div className="text-sm font-medium">{t('setup.steps.binary')}</div>
                                        <div className="text-xs text-gray-500">
                                            {requirements.binary.version || t('setup.status.missing')}
                                        </div>
                                    </div>
                                </div>
                                <StatusIcon status={requirements.binary.status} />
                            </div>

                            {/* Models */}
                            {Object.entries(requirements.models).map(([role, model]) => (
                                <div key={role} className="flex items-center justify-between p-3 rounded-lg bg-black/30">
                                    <div className="flex items-center gap-3">
                                        <HardDrive className="w-5 h-5 text-coffee-400" />
                                        <div>
                                            <div className="text-sm font-medium capitalize">{role} {t('setup.model')}</div>
                                            <div className="text-xs text-gray-500">
                                                {model.name || t('setup.status.not_downloaded')}
                                            </div>
                                        </div>
                                    </div>
                                    <StatusIcon status={model.status} />
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Progress Bar */}
                    {isDownloading && (
                        <div className="space-y-2">
                            <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-coffee-500 to-gold-400 transition-all duration-300"
                                    style={{ width: `${progress.progress * 100}%` }}
                                />
                            </div>
                            <div className="text-xs text-gray-400 text-center">{progress.message}</div>
                        </div>
                    )}

                    {/* Error Message */}
                    {error && (
                        <div className="p-3 rounded-lg bg-red-900/30 border border-red-500/30 text-red-300 text-sm">
                            {error}
                        </div>
                    )}

                    {/* Complete */}
                    {step === 'complete' && (
                        <div className="text-center py-8">
                            <CheckCircle className="w-16 h-16 text-green-400 mx-auto mb-4" />
                            <p className="text-gray-300">{t('setup.complete')}</p>
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="flex gap-3 justify-center">
                    {step === 'ready' && (
                        <button
                            onClick={onComplete}
                            className="glass-button px-6 py-2 flex items-center gap-2 text-green-400"
                        >
                            <PlayCircle className="w-4 h-4" />
                            {t('setup.start')}
                        </button>
                    )}

                    {(step === 'binary' || step === 'models') && !isDownloading && (
                        <>
                            <button
                                onClick={runFullSetup}
                                className="glass-button px-6 py-2 flex items-center gap-2 bg-coffee-700/50"
                            >
                                <Download className="w-4 h-4" />
                                {t('setup.auto_setup')}
                            </button>
                            {onSkip && (
                                <button
                                    onClick={onSkip}
                                    className="glass-button px-4 py-2 text-gray-400 text-sm"
                                >
                                    {t('setup.skip')}
                                </button>
                            )}
                        </>
                    )}

                    {step === 'complete' && (
                        <button
                            onClick={onComplete}
                            className="glass-button px-6 py-2 flex items-center gap-2 bg-coffee-700/50"
                        >
                            <PlayCircle className="w-4 h-4" />
                            {t('setup.start')}
                        </button>
                    )}

                    {step === 'error' && (
                        <>
                            <button
                                onClick={checkRequirements} // Retry check
                                className="glass-button px-4 py-2"
                            >
                                {t('setup.retry')}
                            </button>
                            {onSkip && (
                                <button
                                    onClick={onSkip}
                                    className="glass-button px-4 py-2 text-gray-400 text-sm"
                                >
                                    {t('setup.skip')}
                                </button>
                            )}
                        </>
                    )}

                    {isDownloading && (
                        <button
                            disabled
                            className="glass-button px-6 py-2 flex items-center gap-2 opacity-50 cursor-not-allowed"
                        >
                            <Loader2 className="w-4 h-4 animate-spin" />
                            {t('setup.downloading')}
                        </button>
                    )}
                </div>

                {/* Advanced Settings Toggle */}
                {!isDownloading && step !== 'language' && step !== 'checking' && step !== 'ready' && step !== 'complete' && (
                    <div className="flex justify-center">
                        <button
                            onClick={() => setShowConfig(true)}
                            className="text-xs text-gray-500 hover:text-coffee-400 flex items-center gap-1 transition-colors"
                        >
                            <Settings className="w-3 h-3" />
                            {t('setup.advanced_settings')}
                        </button>
                    </div>
                )}
            </div>

            {/* Config Modal */}
            {showConfig && customModels && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 backdrop-blur-md p-4">
                    <div className="glass-panel w-full max-w-2xl p-6 space-y-6 max-h-[90vh] overflow-y-auto">
                        <div className="flex items-center justify-between">
                            <h2 className="text-xl font-display text-gradient-gemini">{t('setup.model_settings')}</h2>
                            <button onClick={() => setShowConfig(false)} className="text-gray-400 hover:text-white">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="space-y-6">
                            {(['character', 'executor', 'embedding'] as const).map((role) => (
                                <div key={role} className="space-y-3 p-4 bg-black/30 rounded-lg border border-white/5">
                                    <div className="flex items-center gap-2 mb-2">
                                        <HardDrive className="w-4 h-4 text-coffee-400" />
                                        <h3 className="text-sm font-medium capitalize text-coffee-100">{role} {t('setup.model')}</h3>
                                    </div>

                                    <div className="grid gap-3">
                                        <div>
                                            <label className="text-xs text-gray-500 block mb-1">Repo ID (HuggingFace)</label>
                                            <input
                                                type="text"
                                                value={customModels[role]?.repo_id || ''}
                                                onChange={(e) => setCustomModels({
                                                    ...customModels,
                                                    [role]: { ...customModels[role]!, repo_id: e.target.value }
                                                })}
                                                className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm text-gray-200 focus:border-coffee-400 focus:outline-none"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-xs text-gray-500 block mb-1">Filename (.gguf)</label>
                                            <input
                                                type="text"
                                                value={customModels[role]?.filename || ''}
                                                onChange={(e) => setCustomModels({
                                                    ...customModels,
                                                    [role]: { ...customModels[role]!, filename: e.target.value }
                                                })}
                                                className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm text-gray-200 focus:border-coffee-400 focus:outline-none"
                                            />
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="flex justify-end gap-3 pt-4 border-t border-white/10">
                            <button
                                onClick={() => setShowConfig(false)}
                                className="glass-button px-4 py-2 text-sm"
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                onClick={() => setShowConfig(false)}
                                className="glass-button px-4 py-2 flex items-center gap-2 bg-coffee-700/50 text-sm"
                            >
                                <Save className="w-4 h-4" />
                                {t('common.save')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
