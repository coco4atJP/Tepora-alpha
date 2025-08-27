"""
Gemma 3N を Hugging Face Transformers でロードし、
LangChain の `ChatHuggingFace` として利用できる形にラップするヘルパー。

要点:
- GPU必須: CUDA が無い環境では実行を停止
- 任意でBitsAndBytesによる4bit量子化を適用
- `HuggingFacePipeline` -> `ChatHuggingFace` でチャット用モデルとして提供
"""

# agent_core/llm_loader.py

import torch
import logging
from langchain_huggingface.chat_models import ChatHuggingFace
from langchain_huggingface.llms import HuggingFacePipeline
from langchain_core.language_models.chat_models import BaseChatModel
from transformers import (
    Gemma3nForConditionalGeneration, AutoProcessor,
    pipeline as hf_pipeline, BitsAndBytesConfig
)

from . import config

def load_gemma_llm() -> BaseChatModel:
    """
    Gemma 3Nモデルをロードし、`ChatHuggingFace` ラッパーとして返す。
    
    処理の流れ:
    1. CUDA環境チェック: GPUが利用可能か確認
    2. モデル設定準備: データ型とデバイスマッピングを設定
    3. 量子化設定: 設定に応じて4bit量子化を適用
    4. モデルロード: Hugging Face HubからGemma 3Nをダウンロード
    5. プロセッサー準備: トークナイザーとパディング設定
    6. パイプライン構築: text-generation用の推論パイプライン
    7. LangChainラップ: HuggingFacePipeline -> ChatHuggingFace でチャット対応
    """
    # 1. CUDA環境チェック: GPUが利用可能か確認
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available. This prototype requires a GPU.")

    print(f"INFO: Loading model with Hugging Face Transformers on GPU: {config.GEMMA_3N_MODEL_ID}")

    # 2. モデル設定準備: データ型とデバイスマッピングを設定
    model_kwargs = {
        "torch_dtype": torch.bfloat16,  # メモリ効率の良い16bit精度を使用
        "device_map": "auto",           # 自動でGPUメモリに最適配置
    }
    
    # 3. 量子化設定: 設定に応じて4bit量子化を適用
    if config.USE_4BIT_QUANTIZATION:
        print("INFO: Applying 4-bit quantization (BitsAndBytes).")
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",           # 4bit量子化を有効化
            bnb_4bit_compute_dtype=torch.bfloat16,                   # 計算時は16bit精度を維持
            bnb_4bit_use_double_quant=True                           # 二重量子化でさらに圧縮
        )

    # 4. モデルロード: Hugging Face HubからGemma 3Nをダウンロード
    model = Gemma3nForConditionalGeneration.from_pretrained(
        config.GEMMA_3N_MODEL_ID, **model_kwargs
    ).eval()  # 推論モードに設定

    # 5. プロセッサー準備: トークナイザーとパディング設定
    processor = AutoProcessor.from_pretrained(config.GEMMA_3N_MODEL_ID)

    # パディングトークンが未設定の場合はEOSトークンで代用
    if processor.tokenizer.pad_token_id is None:
        processor.tokenizer.pad_token_id = processor.tokenizer.eos_token_id
    
    # 6. パイプライン構築: text-generation用の推論パイプライン
    pipe = hf_pipeline(
        "text-generation",                    # テキスト生成タスク
        model=model,                          # ロードしたGemma 3Nモデル
        tokenizer=processor.tokenizer,        # トークナイザー
        return_full_text=False,               # 新しく生成されたテキストのみを返す
        **config.GEMMA_PARAMS                 # 温度、top_p、top_k、最大トークン数など
    )

    # 7a. LangChainラップ: HuggingFacePipelineでラップ
    huggingface_pipeline = HuggingFacePipeline(
        pipeline=pipe
    )

    # 7b. チャット対応: ChatHuggingFaceでチャット用インターフェースを提供
    # モデル固有のチャットテンプレートが自動適用される
    chat_llm = ChatHuggingFace(llm=huggingface_pipeline)
    
    return chat_llm