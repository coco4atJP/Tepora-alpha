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
from langchain_huggingface import HuggingFacePipeline
from transformers import (
    Gemma3nForConditionalGeneration, AutoProcessor,
    AutoModelForCausalLM, AutoTokenizer,
    pipeline as hf_pipeline, BitsAndBytesConfig
)
from transformers import StoppingCriteria, StoppingCriteriaList

from . import config

class StopOnTokens(StoppingCriteria):
    """指定したトークンIDが末尾に現れたら生成を停止するための条件クラス。"""
    def __init__(self, stop_token_ids):
        self.stop_token_ids = stop_token_ids

    def __call__(self, input_ids: torch.LongTensor, scores: torch.FloatTensor, **kwargs) -> bool:
        for stop_id in self.stop_token_ids:
            if input_ids[0][-1] == stop_id:
                return True
        return False

class LLMManager:
    """
    複数のLLMを動的にロード・アンロードするためのマネージャークラス。
    """
    def __init__(self):
        self.current_model = None
        self.current_tokenizer_or_processor = None
        self.current_model_id = None

    def unload_model(self):
        """現在VRAMにロードされているモデルを解放する。"""
        if self.current_model:
            print(f"INFO: Unloading model: {self.current_model_id}")
            del self.current_model
            del self.current_tokenizer_or_processor
            self.current_model = None
            self.current_tokenizer_or_processor = None
            self.current_model_id = None
            gc.collect()
            torch.cuda.empty_cache()
            print("INFO: Model unloaded and VRAM cache cleared.")

    def _load_model(self, model_id, model_class, processor_class, params, *, apply_quantization: bool):
        """
        汎用的なモデルロード処理。
        apply_quantizationフラグで量子化の適用を制御する。
        """
        if self.current_model_id == model_id:
            print(f"INFO: {model_id} is already loaded.")
        else:
            self.unload_model()
            print(f"INFO: Loading model: {model_id}")
            self.current_model_id = model_id
            
            model_kwargs = {"torch_dtype": torch.bfloat16, "device_map": "auto"}
            
            if apply_quantization:
                print("INFO: Applying 4-bit quantization.")
                model_kwargs["quantization_config"] = BitsAndBytesConfig(
                    load_in_4bit=True, bnb_4bit_quant_type="nf4",
                    bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True
                )
            else:
                print("INFO: 4-bit quantization is NOT applied for this model.")

            self.current_model = model_class.from_pretrained(model_id, **model_kwargs).eval()
            self.current_tokenizer_or_processor = processor_class.from_pretrained(model_id)

        tokenizer = getattr(self.current_tokenizer_or_processor, 'tokenizer', self.current_tokenizer_or_processor)
        if tokenizer.pad_token_id is None:
            tokenizer.pad_token_id = tokenizer.eos_token_id

        stop_token_ids = [
            tokenizer.eos_token_id,
            tokenizer.convert_tokens_to_ids("<end_of_turn>"),
            tokenizer.convert_tokens_to_ids("<start_of_turn>user"),
            tokenizer.convert_tokens_to_ids("<start_of_turn>model"),
        ]
        # Noneをフィルタリング
        stop_token_ids = [tid for tid in stop_token_ids if tid is not None and not isinstance(tid, list)]
        stopping_criteria = StoppingCriteriaList([StopOnTokens(stop_token_ids)])

        pipe = hf_pipeline(
            "text-generation", model=self.current_model, tokenizer=tokenizer,
            return_full_text=False,
            # ★★★ 修正点: stopping_criteria をパイプラインに渡す ★★★
            stopping_criteria=stopping_criteria,
            **params
        )
        return HuggingFacePipeline(pipeline=pipe)

    def load_gemma_3n(self):
        """Gemma 3Nモデルをロードまたは取得する。"""
        return self._load_model(
            config.GEMMA_3N_MODEL_ID,
            Gemma3nForConditionalGeneration,
            AutoProcessor,
            config.GEMMA_PARAMS,
            # ★★★ 修正点: Gemma 3Nでは量子化を適用しない ★★★
            apply_quantization=False 
        )

    def load_jan_nano(self):
        """jan-nano-128kモデルをロードまたは取得する。"""
        return self._load_model(
            config.JAN_NANO_MODEL_ID,
            AutoModelForCausalLM,
            AutoTokenizer,
            config.JAN_PARAMS,
            apply_quantization=config.USE_JAN_NANO_4BIT_QUANTIZATION
        )