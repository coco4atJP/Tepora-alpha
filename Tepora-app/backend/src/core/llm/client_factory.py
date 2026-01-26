import logging
from typing import Any

from langchain_openai import ChatOpenAI, OpenAIEmbeddings

logger = logging.getLogger(__name__)


class ClientFactory:
    """
    LangChainのクライアント(ChatOpenAI, OpenAIEmbeddings)を生成するファクトリクラス。
    """

    def create_chat_client(self, model_key: str, base_url: str, model_config: Any) -> ChatOpenAI:
        """
        ChatOpenAIクライアントを生成する。
        """
        # base_urlが /v1 で終わっていない場合は追加
        if not base_url.endswith("/v1"):
            api_base = f"{base_url}/v1"
        else:
            api_base = base_url

        init_kwargs = {
            "model": model_key,
            "base_url": api_base,
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
                "Client for '%s' will use repeat_penalty=%s via extra_body.",
                model_key,
                model_config.repeat_penalty,
            )

        # logprobs
        if hasattr(model_config, "logprobs") and model_config.logprobs:
            extra_body["logprobs"] = True
            logger.debug("Client for '%s' will request logprobs via extra_body.", model_key)

        # top_k
        if hasattr(model_config, "top_k") and model_config.top_k is not None:
            extra_body["top_k"] = model_config.top_k
            logger.debug(
                "Client for '%s' will use top_k=%s via extra_body.",
                model_key,
                model_config.top_k,
            )

        if extra_body:
            init_kwargs["extra_body"] = extra_body

        logger.info("Creating ChatOpenAI client for '%s' at %s", model_key, base_url)
        return ChatOpenAI(**init_kwargs)

    def create_embedding_client(self, model_key: str, base_url: str) -> OpenAIEmbeddings:
        """
        OpenAIEmbeddingsクライアントを生成する。
        """
        # base_urlが /v1 で終わっていない場合は追加
        if not base_url.endswith("/v1"):
            api_base = f"{base_url}/v1"
        else:
            api_base = base_url

        logger.info("Creating OpenAIEmbeddings client for '%s' at %s", model_key, api_base)
        return OpenAIEmbeddings(
            model=model_key,
            base_url=api_base,
            api_key="dummy-key",
        )
