"""
複数のLLMをGPUメモリ上で動的にロード/アンロードし、
Hugging Faceのパイプラインとして提供するマネージャー。

主な機能:
- 既存モデルの解放(VRAM回収)と安全な再ロード
- モデルごとの量子化適用の可否切り替え
- 生成停止トークンを指定し、不要な出力を早期停止
"""

# agent_core/llm_manager.py
import torch
import gc
import logging
from langchain_huggingface.chat_models import ChatHuggingFace
from langchain_huggingface.llms import HuggingFacePipeline
from langchain_core.language_models.chat_models import BaseChatModel
from transformers import (
    AutoModelForCausalLM, AutoTokenizer,
    pipeline as hf_pipeline, BitsAndBytesConfig
)
from . import config

logger = logging.getLogger(__name__)

class LLMManager:
    """
    Gemma 3NとJan-nanoを動的にロード・アンロードするためのマネージャークラス。
    """
    def __init__(self):
        self._current_model_key = None
        self._pipe = None
        self._chat_llm = None
        logger.info("LLMManager initialized.")

    def _unload_model(self):
        """現在ロードされているモデルをVRAMから解放する。"""
        if self._current_model_key:
            logger.info(f"Unloading model: {self._current_model_key}")
            del self._pipe
            del self._chat_llm
            self._pipe = None
            self._chat_llm = None
            self._current_model_key = None
            gc.collect()
            torch.cuda.empty_cache()
            logger.info("Model unloaded and VRAM cache cleared.")

    def _load_model(self, key: str, model_id: str, params: dict, apply_quantization: bool):
        """指定されたモデルをロードし、ChatHuggingFaceラッパーを生成する。"""
        if self._current_model_key == key:
            logger.info(f"{key} model is already loaded.")
            return

        self._unload_model()
        logger.info(f"Loading {key} model: {model_id}...")

        has_gpu = torch.cuda.is_available() # PyTorchではROCmもこれで検出される
        if has_gpu:
            device_map = "auto"
            torch_dtype = torch.bfloat16
            logger.info(f"GPU detected. Using device_map='{device_map}' and dtype={torch_dtype}.")
        else:
            device_map = "cpu"
            torch_dtype = torch.float32 # CPUはfloat32の方が安定することが多い
            apply_quantization = False # 量子化は通常CUDA依存
            logger.warning("No GPU detected. Falling back to CPU. This will be very slow.")
            logger.info("4-bit quantization has been disabled for CPU execution.")

        model_kwargs = {"torch_dtype": torch_dtype, "device_map": device_map}
        
        if apply_quantization and not has_gpu:
            logger.warning("Quantization was requested but no GPU is available. Disabling.")
            apply_quantization = False

        if apply_quantization:
            logger.info(f"Applying 4-bit quantization for {key}.")
            quantization_config = BitsAndBytesConfig(
                load_in_4bit=True,
            )
            model_kwargs["quantization_config"] = quantization_config
            # ROCm環境下でのbitsandbytesのサポートは実験的な場合があることを示唆
            if torch.version.hip:
                 logger.info("ROCm (AMD GPU) detected. Bitsandbytes quantization support may be experimental.")


        model = AutoModelForCausalLM.from_pretrained(model_id, **model_kwargs).eval()
        tokenizer = AutoTokenizer.from_pretrained(model_id)
        if tokenizer.pad_token_id is None:
            tokenizer.pad_token_id = tokenizer.eos_token_id

        pipe = hf_pipeline(
            "text-generation", model=model, tokenizer=tokenizer,
            return_full_text=False, **params
        )
        
        self._pipe = HuggingFacePipeline(pipeline=pipe)
        self._chat_llm = ChatHuggingFace(llm=self._pipe)
        self._current_model_key = key
        logger.info(f"{key} model loaded successfully.")

    def get_gemma_3n(self) -> BaseChatModel:
        """キャラクター・エージェント (Gemma 3N) を取得する。"""
        self._load_model(
            key="gemma_3n",
            model_id=config.GEMMA_3N_MODEL_ID,
            params=config.GEMMA_PARAMS,
            apply_quantization=config.USE_GEMMA_3N_4BIT_QUANTIZATION
        )
        return self._chat_llm

    def get_jan_nano(self) -> BaseChatModel:
        """プロフェッショナル・エージェント (Jan-nano) を取得する。"""
        self._load_model(
            key="jan_nano",
            model_id=config.JAN_NANO_MODEL_ID,
            params=config.JAN_PARAMS,
            apply_quantization=config.USE_JAN_NANO_4BIT_QUANTIZATION
        )
        return self._chat_llm

    def cleanup(self):
        """アプリケーション終了時にモデルをアンロードする。"""
        logger.info("Cleaning up LLMManager...")
        self._unload_model()