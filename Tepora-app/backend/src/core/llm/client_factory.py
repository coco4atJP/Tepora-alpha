import logging
from typing import Any

from langchain_openai import ChatOpenAI, OpenAIEmbeddings

logger = logging.getLogger(__name__)


class ClientFactory:
    """
    LangChainのクライアント(ChatOpenAI, OpenAIEmbeddings)を生成するファクトリクラス。
    """

    def create_chat_client(self, model_key: str, port: int, model_config: Any) -> ChatOpenAI:
        """
        ChatOpenAIクライアントを生成する。
        """
        base_url = f"http://localhost:{port}/v1"
        init_kwargs = {
            "model": model_key,
            "base_url": base_url,
            "api_key": "dummy-key",
            "streaming": True,
        }

        # 標準のOpenAIパラメータ
        standard_params = ["temperature", "top_p", "max_tokens"]
        for param in standard_params:
            if hasattr(model_config, param) and getattr(model_config, param) is not None:
                init_kwargs[param] = getattr(model_config, param)

        # Llama.cpp固有パラメータのためのextra_body構築
        extra_body = {}

        # repeat_penalty
        if hasattr(model_config, "repeat_penalty") and model_config.repeat_penalty is not None:
            extra_body["repeat_penalty"] = model_config.repeat_penalty
            logger.debug(
                f"Client for '{model_key}' will use repeat_penalty={model_config.repeat_penalty} via extra_body."
            )

        # logprobs
        if hasattr(model_config, "logprobs") and model_config.logprobs:
            extra_body["logprobs"] = True
            logger.debug(f"Client for '{model_key}' will request logprobs via extra_body.")

        # top_k
        if hasattr(model_config, "top_k") and model_config.top_k is not None:
            extra_body["top_k"] = model_config.top_k
            logger.debug(
                f"Client for '{model_key}' will use top_k={model_config.top_k} via extra_body."
            )

        if extra_body:
            init_kwargs["extra_body"] = extra_body

        logger.info(f"Creating ChatOpenAI client for '{model_key}' at {base_url}")
        return ChatOpenAI(**init_kwargs)

    def create_embedding_client(self, model_key: str, port: int) -> OpenAIEmbeddings:
        """
        OpenAIEmbeddingsクライアントを生成する。
        """
        base_url = f"http://localhost:{port}/v1"
        logger.info(f"Creating OpenAIEmbeddings client for '{model_key}' at {base_url}")
        return OpenAIEmbeddings(
            model=model_key,
            base_url=base_url,
            api_key="dummy-key",
        )
