# agent_core/llm_manager.py
import gc
import logging
from pathlib import Path
from langchain_community.chat_models import ChatLlamaCpp
from langchain_core.language_models.chat_models import BaseChatModel
from . import config

logger = logging.getLogger(__name__)

class LLMManager:
    """
    GGUFモデルをLlama.cppで動的にロード・アンロードするためのマネージャークラス。
    """
    def __init__(self):
        self._current_model_key = None
        self._chat_llm: BaseChatModel | None = None
        logger.info("LLMManager for Llama.cpp initialized.")

    def _unload_model(self):
        """現在ロードされているモデルを解放する。"""
        if self._current_model_key:
            logger.info(f"Unloading model: {self._current_model_key}")
            del self._chat_llm
            self._chat_llm = None
            self._current_model_key = None
            gc.collect() # ガベージコレクションを強制
            logger.info("Model unloaded.")

    def _load_model(self, key: str):
        """指定されたGGUFモデルをLlama.cppでロードする。"""
        if self._current_model_key == key:
            return

        self._unload_model()
        
        model_config = config.MODELS_GGUF[key]
        
        # プロジェクトのルートディレクトリを基準にモデルファイルの絶対パスを構築
        # これにより、どこからスクリプトを実行してもパスが安定します
        project_root = Path(__file__).parent.parent
        model_path = project_root / model_config["path"]

        if not model_path.exists():
            # デバッグしやすいように、エラーメッセージに絶対パスを含めます
            raise FileNotFoundError(f"Model file not found at the absolute path: {model_path.resolve()}")

        logger.info(f"Loading {key} model from: {model_path.resolve()}...")
        
        # LlamaCppのインスタンスを生成
        # ストリーミングを有効にする
        self._chat_llm = ChatLlamaCpp(
            # 内部ライブラリとの互換性のため、パスは文字列の絶対パスとして渡します
            model_path=str(model_path.resolve()),
            n_ctx=model_config["n_ctx"],
            n_gpu_layers=model_config["n_gpu_layers"],
            temperature=model_config["temperature"],
            top_p=model_config["top_p"],
            top_k=model_config["top_k"],
            max_tokens=model_config["max_tokens"],
            streaming=True, # ストリーミングを有効化 
            verbose=False,
        )
        self._current_model_key = key
        logger.info(f"{key} model loaded successfully (context size: {model_config['n_ctx']}).")

    def get_gemma_3n(self) -> BaseChatModel:
        """キャラクター・エージェント (Gemma 3N) を取得する。"""
        self._load_model("gemma_3n")
        return self._chat_llm

    def get_jan_nano(self) -> BaseChatModel:
        """プロフェッショナル・エージェント (Jan-nano) を取得する。"""
        self._load_model("jan_nano")
        return self._chat_llm

    def get_slm_summarizer(self) -> BaseChatModel:
        """EM-LLM用SLMを取得する。"""
        self._load_model("slm_summarizer")
        return self._chat_llm

    def cleanup(self):
        """アプリケーション終了時にモデルをアンロードする。"""
        logger.info("Cleaning up LLMManager...")
        self._unload_model()