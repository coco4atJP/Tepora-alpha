# agent_core/embedding_provider.py

from langchain_core.embeddings import Embeddings


class EmbeddingProvider:
    """
    LangChainの埋め込み機能を、SentenceTransformerのような
    シンプルな .encode() インターフェースに適合させるアダプター。
    """

    def __init__(self, llama_cpp_instance: Embeddings):
        self._llm = llama_cpp_instance

    def encode(self, texts: list[str]) -> list[list[float]]:
        """複数のテキストを一度にベクトル化する。"""
        # LlamaCppのembed_documentsメソッドは、テキストのリストを受け取る
        return self._llm.embed_documents(texts)
