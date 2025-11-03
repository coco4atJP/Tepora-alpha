# agent_core/em_llm_core.py
"""
EM-LLM (Episodic Memory for Large Language Models) の核心実装

このモジュールは以下のEM-LLM固有の機能を提供します：
1. 驚異度（Surprise）計算とセグメンテーション
2. 境界精密化（Boundary Refinement）
3. 階層的注意メカニズム
4. 2段階検索システム

論文: "Human-inspired Episodic Memory for Infinite Context LLMs" (ICLR 2025)
"""

import re
import numpy as np
import logging
import asyncio
import time
from typing import List, Dict, Tuple, Optional, Any, TYPE_CHECKING
from dataclasses import dataclass
import networkx as nx
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.metrics.pairwise import cosine_distances
import nltk

if TYPE_CHECKING:
    from .memory.memory_system import MemorySystem
else:
    MemorySystem = Any  # runtime fallback to avoid NameError in annotations

logger = logging.getLogger(__name__)

@dataclass
class EpisodicEvent:
    """EM-LLMにおける単一のエピソード事象を表現するデータクラス"""
    tokens: List[str]
    start_position: int
    end_position: int
    surprise_scores: List[float]
    attention_keys: Optional[np.ndarray] = None
    representative_tokens: Optional[List[int]] = None
    summary: Optional[str] = None
    representative_embeddings: Optional[np.ndarray] = None # (num_repr_tokens, hidden_dim)

@dataclass
class EMConfig:
    """EM-LLMの設定パラメータ"""
    # 驚異度関連
    surprise_window: int = 128  # 驚異度計算のウィンドウサイズ
    surprise_gamma: float = 1.0  # 閾値調整パラメータ
    min_event_size: int = 8     # 最小事象サイズ
    max_event_size: int = 128   # 最大事象サイズ
    
    # 検索関連
    similarity_buffer_ratio: float = 0.7  # 類似度バッファの比率
    contiguity_buffer_ratio: float = 0.3  # 連続性バッファの比率
    total_retrieved_events: int = 4    # 総検索事象数
    repr_topk: int = 4                 # 代表トークン数
    recency_weight: float = 0.1        # 時間的近接性の重み (0.0 - 1.0)
    
    # 境界精密化関連
    use_boundary_refinement: bool = True
    refinement_metric: str = "modularity"  # "modularity" or "conductance"
    refinement_search_range: int = 16      # 境界精密化の最大探索範囲

class EMEventSegmenter:
    """意味的な変化に基づいてテキストをイベントに分割するセグメンター"""
    
    def __init__(self, config: EMConfig):
        self.config = config
        self.sent_tokenizer = self._get_sentence_tokenizer()
        logger.info("EM-LLM Semantic Event Segmenter initialized")

    def _get_sentence_tokenizer(self):
        """NLTKの'punkt'トークナイザを安全にロードする。

        `nltk.sent_tokenize` を直接使わず、`nltk.data.load` を使用することで、
        NLTKのインストール状態に問題がある場合でも安定して動作させる。
        """
        try:
            return nltk.data.load('tokenizers/punkt/english.pickle')
        except LookupError:
            logger.info("NLTK 'punkt' tokenizer data not found. Downloading...")
            try:
                nltk.download('punkt', quiet=True)
                logger.info("'punkt' data downloaded successfully.")
                return nltk.data.load('tokenizers/punkt/english.pickle')
            except Exception as download_error:  # noqa: BLE001
                logger.warning("Failed to download 'punkt' tokenizer data: %s", download_error, exc_info=True)
                return self._fallback_sentence_tokenizer()
        except Exception as load_error:  # noqa: BLE001
            logger.warning("Unexpected error while loading NLTK 'punkt': %s", load_error, exc_info=True)
            return self._fallback_sentence_tokenizer()

    def _fallback_sentence_tokenizer(self):
        """ネットワーク無し環境向けの単純なフォールバックトークナイザ"""

        class _SimpleSentenceTokenizer:
            def tokenize(self, text: str) -> List[str]:
                # 句読点の後ろまたは改行で分割し、空文字を除外
                segments = re.split(r'(?:[\.!?]+\s+|\n+)', text)
                return [seg.strip() for seg in segments if seg.strip()]

        logger.warning(
            "Falling back to simple regex-based sentence tokenizer. EM segmentation quality may degrade."
        )
        return _SimpleSentenceTokenizer()

    def _split_into_sentences(self, text: str) -> List[str]:
        """NLTKを使用してテキストを文に分割する"""
        if not text:
            return []
        # 改行をスペースに置換して、NLTKが処理しやすくする
        text = re.sub(r'\n+', ' ', text).strip()
        return self.sent_tokenizer.tokenize(text)

    def calculate_surprise_from_logprobs(self, logprobs: List[Dict[str, Any]]) -> List[float]:
        """
        LLMの生成結果に含まれるlogprobsから驚異度スコアを計算する。
        これは論文の -log P(xt|...) に相当する。
        
        Args:
            logprobs: Llama.cppなどが出力するlogprobsのリスト。
                      各要素は {'token_str': str, 'logprob': float} のような辞書を想定。
        
        Returns:
            各トークンの驚異度スコアのリスト。
        """
        if not logprobs:
            return []
        # 論文の定義通り、負の対数尤度を驚異度とする
        # logprobは通常負の値なので、-1を掛けて正の値に変換する
        return [-item.get('logprob', 0.0) for item in logprobs]

    def segment_text_into_events(self, text: str, embedding_provider) -> Tuple[List[EpisodicEvent], Optional[np.ndarray]]:
        """テキストを意味的な変化に基づいてエピソード事象に分割する"""
        if not text or not embedding_provider:
            return [], None

        # 1. テキストを文に分割
        sentences = self._split_into_sentences(text)
        if not sentences or len(sentences) < 2:
            logger.info("Text too short for semantic segmentation, treating as a single event.")
            tokens = text.split()
            event = EpisodicEvent(
                tokens=tokens if tokens else [],
                start_position=0,
                end_position=len(tokens),
                surprise_scores=[0.0] * len(tokens) # 驚きなし
            )
            return [event], None

        # 2. 各文を埋め込みに変換
        sentence_embeddings = np.array(embedding_provider.encode(sentences))

        # 3. 隣接する文の埋め込み間のコサイン距離を計算
        distances = [
            cosine_distances(
                sentence_embeddings[i].reshape(1, -1),
                sentence_embeddings[i + 1].reshape(1, -1)
            )[0][0] for i in range(len(sentences) - 1)
        ]
        # 最初の文の変化スコアは0とする
        semantic_change_scores = [0.0] + distances

        # 4. 意味的変化スコアに基づいて境界を特定
        boundary_indices = self._identify_event_boundaries(semantic_change_scores, sentences)

        # 5. 境界からイベントを構築
        events = []
        total_token_offset = 0
        for i in range(len(boundary_indices) - 1):
            start_sentence_idx = boundary_indices[i]
            end_sentence_idx = boundary_indices[i+1]

            event_sentences = sentences[start_sentence_idx:end_sentence_idx]
            event_text = " ".join(event_sentences)
            event_tokens = event_text.split() # シンプルなトークナイザ

            # このイベントを代表する「驚き」スコア（境界開始点の意味的変化）
            event_surprise_score = semantic_change_scores[start_sentence_idx]

            event = EpisodicEvent(
                tokens=event_tokens,
                start_position=total_token_offset,
                end_position=total_token_offset + len(event_tokens),
                # イベント内の全トークンに同じ驚きスコアを割り当てる
                surprise_scores=[event_surprise_score] * len(event_tokens)
            )
            events.append(event)
            total_token_offset += len(event_tokens)

        logger.info(f"Created {len(events)} episodic events based on semantic change.")
        return events, sentence_embeddings

    def _identify_event_boundaries(self, scores: List[float], items: List[Any] = None) -> List[int]: # itemsをオプション引数にする
        """
        スコアの時系列データからイベント境界を特定する
        
        論文の式: T = μt−τ + γσt−τ
        """
        if len(scores) < self.config.surprise_window:
            logger.warning("Sequence too short for boundary detection")
            return [0, len(scores)]
        
        boundaries = [0]  # 最初は常に境界
        
        for i in range(self.config.surprise_window, len(scores)): # ループ開始位置をconfigから取得
            # 移動ウィンドウでの平均と標準偏差を計算
            window_scores = scores[i - self.config.surprise_window : i] # ウィンドウサイズをconfigから取得
            
            if len(window_scores) > 1: # ウィンドウが空でないことを確認
                mean_score = np.mean(window_scores)
                std_score = np.std(window_scores)
                
                # 閾値計算: T = μ + γσ
                threshold = mean_score + self.config.surprise_gamma * std_score
                
                # 現在のトークンが閾値を超えた場合、境界とする
                if scores[i] > threshold:
                    boundaries.append(i)
                    logger.debug(f"Boundary detected at item index {i}, score: {scores[i]:.3f}, threshold: {threshold:.3f}")
        
        boundaries.append(len(scores))  # 最後も境界
        
        # 重複削除とソート
        boundaries = sorted(list(set(boundaries)))
        logger.info(f"Identified {len(boundaries)-1} initial events from surprise")
        
        return boundaries

    def calculate_attention_similarity_matrix(self, attention_keys: np.ndarray) -> np.ndarray:
        """
        アテンションキーから類似度行列を計算
        
        Args:
            attention_keys: (seq_len, hidden_dim) のアテンションキー行列
            
        Returns:
            (seq_len, seq_len) の類似度行列
        """
        # コサイン類似度を使用（論文ではドット積だが、正規化された方が安定）
        similarity_matrix = cosine_similarity(attention_keys)
        return similarity_matrix

class EMBoundaryRefiner:
    """境界精密化によるセグメンテーション最適化"""
    
    def __init__(self, config: EMConfig):
        self.config = config

    def _calculate_similarity_matrix(self, vectors: np.ndarray) -> np.ndarray:
        """
        アテンションキーまたは文脈ベクトルから類似度行列を計算する。
        
        Args:
            vectors: (seq_len, hidden_dim) のベクトル行列

        Returns:
            (seq_len, seq_len) の類似度行列
        """
        # コサイン類似度を使用（論文ではドット積だが、正規化された方が安定）
        return cosine_similarity(vectors)

    def calculate_modularity(self, similarity_matrix: np.ndarray, boundaries: List[int]) -> float:
        """
        モジュラリティ（論文の式3）を計算
        """
        try:
            G = nx.from_numpy_array(similarity_matrix)
            
            # 境界に基づくコミュニティ作成
            communities = []
            for i in range(len(boundaries) - 1):
                community = list(range(boundaries[i], boundaries[i + 1]))
                if community:  # 空でない場合のみ追加
                    communities.append(community)
            
            if len(communities) <= 1:
                return 0.0
                
            # This can raise exceptions if communities are not a valid partition
            return nx.algorithms.community.modularity(G, communities, weight='weight')
        except (nx.NetworkXError, ValueError) as e:
            logger.warning(f"Modularity calculation failed: {e}", exc_info=True)
            return 0.0
    
    def calculate_conductance(self, similarity_matrix: np.ndarray, boundaries: List[int]) -> float:
        """
        伝導性（論文の式4）を計算
        """
        try:
            total_conductance = 0.0
            num_communities = len(boundaries) - 1
            
            for i in range(num_communities):
                start, end = boundaries[i], boundaries[i + 1]
                
                # コミュニティ内部の重み
                internal_weight = np.sum(similarity_matrix[start:end, start:end])
                
                # コミュニティ外部への重み
                external_weight = (
                    np.sum(similarity_matrix[start:end, :start]) +
                    np.sum(similarity_matrix[start:end, end:])
                )
                
                # 伝導性計算
                total_weight = internal_weight + external_weight
                if total_weight > 0:
                    conductance = external_weight / total_weight
                    total_conductance += conductance
            
            return total_conductance / max(1, num_communities)
        except (IndexError, ValueError) as e:
            logger.warning(f"Conductance calculation failed: {e}", exc_info=True)
            return 1.0  # 悪いスコア
    
    def refine_boundaries(
        self, 
        events: List[EpisodicEvent], 
        context_vectors: Optional[np.ndarray] = None,
        attention_keys: Optional[np.ndarray] = None
    ) -> List[EpisodicEvent]:
        """
        グラフ理論メトリクスを使用して境界を精密化。
        論文のコンセプトに基づき、アテンションキーが利用可能であればそれを優先的に使用する。
        なければ、文の埋め込みベクトル(context_vectors)でフォールバックする。
        """
        if not self.config.use_boundary_refinement or len(events) <= 1:
            return events

        # 論文のコンセプト: アテンションキーの類似度に基づく精密化
        if attention_keys is not None and attention_keys.shape[0] > 1:
            logger.info("Refining boundaries using attention key similarity (as per paper).")
            similarity_matrix = self._calculate_similarity_matrix(attention_keys)
        # フォールバック: 文の埋め込みベクトルに基づく精密化
        elif context_vectors is not None and context_vectors.shape[0] > 1:
            logger.info("Refining boundaries using sentence embedding similarity (fallback).")
            similarity_matrix = self._calculate_similarity_matrix(context_vectors)
        else:
            logger.warning("Neither attention keys nor context vectors available. Skipping boundary refinement.")
            return events
        
        logger.info("Refining event boundaries using graph-theoretic metrics")
        
        # 現在の境界を抽出
        current_boundaries = [event.start_position for event in events] + [events[-1].end_position]
        
        # 各境界ペアについて最適位置を探索
        refined_boundaries = [current_boundaries[0]]  # 最初の境界は固定
        
        for i in range(len(current_boundaries) - 2):
            start_boundary = refined_boundaries[-1]
            end_boundary = current_boundaries[i + 2]
            current_pos = current_boundaries[i + 1]
            
            best_pos = current_pos
            best_score = self._evaluate_boundary_position(
                similarity_matrix, refined_boundaries + [current_pos, end_boundary]
            )
            
            # 近隣位置を探索
            # イベント長に応じて探索範囲を動的に決定。設定ファイルの `refinement_search_range` を最大値とする。
            event_pair_length = end_boundary - start_boundary
            dynamic_range = event_pair_length // 4
            search_range = min(self.config.refinement_search_range, dynamic_range)
            
            for offset in range(-search_range, search_range + 1): # ステップを1にしてより細かく探索
                test_pos = current_pos + offset
                if start_boundary < test_pos < end_boundary:
                    test_boundaries = refined_boundaries + [test_pos, end_boundary]
                    score = self._evaluate_boundary_position(similarity_matrix, test_boundaries)
                    
                    if self._is_better_score(score, best_score):
                        best_score = score
                        best_pos = test_pos
            
            refined_boundaries.append(best_pos)
        
        refined_boundaries.append(current_boundaries[-1])  # 最後の境界も固定
        
        # 精密化された境界で事象を再構築
        return self._rebuild_events_from_boundaries(events, refined_boundaries)
    
    def _evaluate_boundary_position(self, similarity_matrix: np.ndarray, boundaries: List[int]) -> float:
        """境界位置の評価"""
        if self.config.refinement_metric == "modularity":
            return self.calculate_modularity(similarity_matrix, boundaries)
        else:
            return -self.calculate_conductance(similarity_matrix, boundaries)  # 負の値（小さいほど良い）
    
    def _is_better_score(self, new_score: float, current_best: float) -> bool:
        """スコアの改善判定"""
        return new_score > current_best
    
    def _rebuild_events_from_boundaries(self, original_events: List[EpisodicEvent], boundaries: List[int]) -> List[EpisodicEvent]:
        """精密化された境界から事象を再構築"""
        refined_events = []
        all_tokens = []
        all_surprises = []
        
        # 全トークンと驚異度を結合
        for event in original_events:
            all_tokens.extend(event.tokens)
            all_surprises.extend(event.surprise_scores)
        
        for i in range(len(boundaries) - 1):
            start_pos = boundaries[i]
            end_pos = boundaries[i + 1]
            
            refined_event = EpisodicEvent(
                tokens=all_tokens[start_pos:end_pos],
                start_position=start_pos,
                end_position=end_pos,
                surprise_scores=all_surprises[start_pos:end_pos]
            )
            refined_events.append(refined_event)
        
        logger.info(f"Boundary refinement completed: {len(original_events)} -> {len(refined_events)} events")
        return refined_events

class EMTwoStageRetrieval:
    """EM-LLMの2段階検索システム（類似度バッファ + 連続性バッファ）"""
    
    def __init__(self, config: EMConfig, memory_system: "MemorySystem"):
        self.config = config
        self.memory_system = memory_system
        logger.info("EMTwoStageRetrieval initialized with ChromaDB backend.")
    
    def add_events(self, events: List[EpisodicEvent]):
        """新しい事象をメモリに追加"""
        if not events:
            return

        for event in events:
            # ChromaDBに保存する形式に変換
            doc_id = f"em_event_{event.start_position}_{event.end_position}"
            summary = " ".join(event.tokens)
            # 代表埋め込みの平均をイベントの埋め込みとする
            if event.representative_embeddings is not None and event.representative_embeddings.shape[0] > 0:
                embedding = np.mean(event.representative_embeddings, axis=0).tolist()
                
                # ★驚異度をメタデータとして追加
                avg_surprise = 0.0
                if event.surprise_scores:
                    avg_surprise = float(np.mean(event.surprise_scores))

                metadata = {
                    "start_position": event.start_position,
                    "end_position": event.end_position,
                    "created_ts": time.time(),
                    "avg_surprise": avg_surprise
                }
                self.memory_system.collection.add(
                    ids=[doc_id],
                    embeddings=[embedding],
                    documents=[summary],
                    metadatas=[metadata]
                )
        logger.info(f"Added {len(events)} EM-LLM events to ChromaDB. Total events: {self.memory_system.count()}")
    

    def retrieve_relevant_events(self, query_embedding: np.ndarray, k: Optional[int] = None) -> List[EpisodicEvent]:
        """2段階検索をChromaDBに対して実行"""
        if self.memory_system.count() == 0:
            return []
        
        total_k = k or self.config.total_retrieved_events
        ks = int(total_k * self.config.similarity_buffer_ratio)  # 類似度バッファサイズ
        kc = total_k - ks  # 連続性バッファサイズ
        
        # Stage 1: 類似度ベース検索
        similarity_events = self._similarity_based_retrieval(query_embedding, ks)
        
        # Stage 2: 時間的連続性バッファ
        contiguity_events = self._contiguity_based_retrieval(similarity_events, kc)
        
        # 結合して重複除去
        all_retrieved = similarity_events + contiguity_events
        unique_events = self._deduplicate_events(all_retrieved)
        
        logger.debug(f"Retrieved {len(unique_events)} unique events (similarity: {len(similarity_events)}, contiguity: {len(contiguity_events)})")
        
        # 最終的なイベントリストを時間順（古い順）にソートして返す
        sorted_events = sorted(unique_events, key=lambda e: e.start_position)
        return sorted_events[:total_k]

    def _results_to_events(self, results: List[Dict]) -> List[EpisodicEvent]:
        """ChromaDBの検索結果をEpisodicEventオブジェクトのリストに変換する"""
        events = []
        for result in results:
            try:
                # メタデータからpositionを取得
                metadata = result.get('metadata', {})
                start_pos = metadata.get('start_position')
                end_pos = metadata.get('end_position')

                # メタデータにない場合、IDからフォールバック
                if start_pos is None or end_pos is None:
                    parts = result['id'].split('_')
                    start_pos = int(parts[2])
                    end_pos = int(parts[3])
                
                event = EpisodicEvent(
                    tokens=result['summary'].split(),
                    start_position=start_pos,
                    end_position=end_pos,
                    surprise_scores=[]  # ChromaDBからは復元不可
                )
                events.append(event)
            except (IndexError, ValueError, TypeError) as e:
                logger.warning(f"Could not parse event position from id: {result['id']}")
                continue
        return events

    def _deduplicate_events(self, events: List[EpisodicEvent]) -> List[EpisodicEvent]:
        """事象のリストから重複を除去する"""
        seen_positions = set()
        unique_events = []
        for event in events:
            position_key = (event.start_position, event.end_position)
            if position_key not in seen_positions:
                unique_events.append(event)
                seen_positions.add(position_key)
        return unique_events

    def _similarity_based_retrieval(self, query_embedding: np.ndarray, ks: int) -> List[EpisodicEvent]:
        """ChromaDBに対して類似度検索を実行"""
        if ks <= 0 or self.memory_system.count() == 0:
            return []
        
        # retrieveメソッドはtemporality_boostを適用するため、それを利用する
        results = self.memory_system.retrieve(
            query="", # クエリ文字列は使わない
            k=ks,
            temporality_boost=self.config.recency_weight,
            query_embedding_override=query_embedding.tolist() # 埋め込みを直接渡す
        )
        return self._results_to_events(results)

    def _contiguity_based_retrieval(self, similarity_events: List[EpisodicEvent], kc: int) -> List[EpisodicEvent]:
        """
        ChromaDBのメタデータ検索を使用して、時間的に連続したイベントを効率的に取得する。
        $or演算子を使い、複数の隣接イベント検索を単一のDBクエリにまとめる。
        """
        if kc <= 0 or not similarity_events:
            return []

        # 1. 複数の検索条件を一度にまとめるためのフィルタリストを構築
        or_filters = []
        for event in similarity_events:
            # 前のイベントを検索する条件: end_positionが現在のstart_positionと一致
            or_filters.append({"end_position": event.start_position})
            # 後のイベントを検索する条件: start_positionが現在のend_positionと一致
            or_filters.append({"start_position": event.end_position})
        
        if not or_filters:
            return []

        # 2. $or を使って一度に問い合わせ
        combined_filter = {"$or": or_filters}
        results = self.memory_system.collection.get(where=combined_filter, include=["metadatas", "documents"])

        if not results or not results['ids']:
            return []

        # 3. 検索結果から、類似検索の結果と重複しないものを抽出
        # 取得済みのイベントIDをセットにして、重複検索を避ける
        similarity_event_ids = {f"em_event_{e.start_position}_{e.end_position}" for e in similarity_events}
        
        contiguity_results = []
        for i in range(len(results['ids'])):
            if results['ids'][i] not in similarity_event_ids:
                contiguity_results.append({
                    "id": results['ids'][i], 
                    "summary": results['documents'][i], 
                    "metadata": results['metadatas'][i]
                })

        # 4. EpisodicEventに変換し、重複を除去して返す
        contiguity_events = self._results_to_events(contiguity_results)
        unique_contiguity_events = self._deduplicate_events(contiguity_events)
        logger.debug(f"Found {len(unique_contiguity_events)} contiguous events via batch query.")
        
        return unique_contiguity_events[:kc]


class EMLLMIntegrator:
    """既存システムとEM-LLMの統合クラス"""
    
    def __init__(self, llm_manager, embedding_provider, config: EMConfig, memory_system: MemorySystem): # memory_systemを追加
        self.llm_manager = llm_manager
        self.embedding_provider = embedding_provider
        self.config = config # 受け取ったconfigをセット
        self.memory_system = memory_system # memory_systemをセット
        
        # EM-LLMメモリシステム初期化
        self.segmenter = EMEventSegmenter(self.config)
        self.boundary_refiner = EMBoundaryRefiner(self.config)
        self.retrieval_system = EMTwoStageRetrieval(self.config, self.memory_system)
        
        logger.info("EM-LLM Integrator initialized")
    
    def get_current_llm_config_for_diagnostics(self) -> Dict:
        """診断用に現在のLLM設定を取得する"""
        if self.llm_manager and hasattr(self.llm_manager, 'get_current_model_config_for_diagnostics'):
            return self.llm_manager.get_current_model_config_for_diagnostics()
        logger.warning("LLMManager not available or does not have the required diagnostics method.")
        return {}

    async def _finalize_and_store_events(self, events: List[EpisodicEvent]) -> List[EpisodicEvent]:
        """
        セグメンテーション後のイベントを受け取り、代表トークン選出、埋め込み計算、
        メモリへの格納という共通の後処理を行う。
        """
        if not events:
            return []
        
        # 各事象の代表トークン選出と埋め込み計算
        for event in events:
            event.representative_tokens = self._select_representative_tokens(event)
            if self.embedding_provider and event.representative_tokens:
                repr_texts = [event.tokens[i] for i in event.representative_tokens]
                if repr_texts:
                    # 埋め込み計算は非同期ではないため、asyncio.to_threadで実行
                    embeddings = await asyncio.to_thread(self.embedding_provider.encode, repr_texts)
                    event.representative_embeddings = np.array(embeddings)
        
        # メモリに格納
        self.retrieval_system.add_events(events)
        
        return events

    async def process_logprobs_for_memory(self, logprobs_content: List[Dict], state: Optional[Dict] = None) -> List[EpisodicEvent]:
        """
        LLMから得られたlogprobsを直接処理して、驚き度に基づきメモリを形成する。
        これがEM-LLMの論文における主要な記憶形成パス。
        """
        logger.info("Processing logprobs for surprisal-based memory formation.")
        try:
            if not logprobs_content:
                logger.warning("logprobs_content is empty. Skipping memory formation.")
                return []

            normalized_entries = []
            for idx, entry in enumerate(logprobs_content):
                token = entry.get('token') or entry.get('token_str')
                logprob = entry.get('logprob')
                if token is None or logprob is None:
                    logger.debug(
                        "Skipping logprob entry %d due to missing token/logprob fields: %s",
                        idx,
                        entry,
                    )
                    continue
                normalized_entries.append({'token': token, 'logprob': logprob})

            if not normalized_entries:
                logger.warning("No valid logprob entries after normalization. Skipping memory formation.")
                return []

            surprise_scores = self.segmenter.calculate_surprise_from_logprobs(normalized_entries)
            tokens = [item['token'] for item in normalized_entries]
            
            # 2. 驚き度スコアに基づいて境界を特定
            boundaries = self.segmenter._identify_event_boundaries(surprise_scores, tokens)
            
            # 3. 境界からイベントを構築
            events = []
            for i in range(len(boundaries) - 1):
                start, end = boundaries[i], boundaries[i+1]
                event = EpisodicEvent(
                    tokens=tokens[start:end],
                    start_position=start,
                    end_position=end,
                    surprise_scores=surprise_scores[start:end]
                )
                events.append(event)
            
            # --- 境界精密化 (アテンションキー利用) ---
            # このパスでは、logprobsと同時にアテンションキーが取得できていると仮定する
            # attention_keys = ... (logprobsと一緒に渡される想定の変数)
            attention_keys = None # 現状はダミー
            if self.config.use_boundary_refinement and attention_keys is not None:
                logger.info("Applying boundary refinement using attention keys.")
                events = self.boundary_refiner.refine_boundaries(
                    events, attention_keys=attention_keys
                )

            return await self._finalize_and_store_events(events)
        except Exception as e:
            logger.error(f"EM-LLM logprobs processing failed: {e}", exc_info=True)
            return []

    async def process_conversation_turn_for_memory(self, user_input: str, ai_response: str) -> List[EpisodicEvent]:
        """
        対話ターンをEM-LLMメモリ形成パイプラインで非同期に処理する。
        """
        logger.info("Processing conversation turn for EM-LLM memory formation (semantic change based).")
        
        try:
            if not ai_response:
                logger.warning("AI response is empty. Aborting memory formation.")
                return []

            # --- 意味的変化に基づくメモリ形成パイプライン ---
            logger.info(f"Processing text of {len(ai_response)} chars for memory formation")

            # Step 1 & 2: セマンティック変化に基づくセグメンテーション
            events, sentence_embeddings = self.segmenter.segment_text_into_events(ai_response, self.embedding_provider)
            if not events:
                return []

            # Step 3: 境界精密化
            if self.config.use_boundary_refinement and sentence_embeddings is not None:
                events = self.boundary_refiner.refine_boundaries(
                    events, 
                    context_vectors=sentence_embeddings,
                    attention_keys=None
                )
            
            # Step 4 & 5: 共通の後処理とメモリ格納
            final_events = await self._finalize_and_store_events(events)
            
            logger.info(f"Created {len(final_events)} episodic events from conversation turn via semantic segmentation.")
            return final_events
            
        except Exception as e:
            logger.error(f"EM-LLM memory formation failed: {e}", exc_info=True)
            return []

    def _select_representative_tokens(self, event: EpisodicEvent) -> List[int]:
        """事象内の代表的なトークンを選出（驚異度が高い順）"""
        if not event.surprise_scores:
            return []
        
        indexed_scores = [(score, i) for i, score in enumerate(event.surprise_scores)]
        indexed_scores.sort(key=lambda x: x[0], reverse=True)
        representative_indices = [i for _, i in indexed_scores[:self.config.repr_topk]]
        return sorted(representative_indices)

    def retrieve_relevant_memories_for_query(self, query: str) -> List[Dict]:
        """
        クエリに対してEM-LLM方式で関連記憶を検索
        
        Returns:
            既存のメモリシステムと互換性のある辞書形式のリスト
        """
        logger.info("Retrieving memories using EM-LLM two-stage retrieval")
        
        try:
            if not self.embedding_provider:
                logger.warning("No embedding provider available for retrieval")
                return []
            
            # EM-LLMの2段階検索を実行
            query_embedding = np.array(self.embedding_provider.encode([query])[0])
            relevant_events = self.retrieval_system.retrieve_relevant_events(query_embedding)
            
            # 既存システムとの互換性のため辞書形式に変換
            memory_entries = []
            for i, event in enumerate(relevant_events):
                memory_entry = {
                    'id': f"em_event_{event.start_position}_{event.end_position}",
                    'content': " ".join(event.tokens),
                    'summary': event.summary or f"Episodic event from position {event.start_position} to {event.end_position}",
                    'surprise_stats': {
                        'mean_surprise': float(np.mean(event.surprise_scores)),
                        'max_surprise': float(np.max(event.surprise_scores)),
                        'event_size': len(event.tokens)
                    },
                    'representative_tokens': event.representative_tokens or [],
                    'retrieval_rank': i + 1
                }
                memory_entries.append(memory_entry)
            
            logger.info(f"Retrieved {len(memory_entries)} EM-LLM memories")
            return memory_entries
        
        except AttributeError as e:
            logger.error(f"EM-LLM memory retrieval failed due to a missing component (e.g., embedding_provider): {e}", exc_info=True)
            return []
        except Exception as e:
            logger.error(f"An unexpected error occurred during EM-LLM memory retrieval: {e}", exc_info=True)
            return []

    def get_memory_statistics(self) -> Dict:
        """EM-LLMメモリシステムの現在の統計情報を取得する"""
        stats = {}
        try:
            stored_events = self.retrieval_system.memory_system.get_all()
            if not stored_events:
                return {"status": "No events in memory."}

            total_events = len(stored_events)
            total_tokens = sum(len(event.tokens) for event in stored_events)
            all_surprise_scores = [score for event in stored_events for score in event.surprise_scores if event.surprise_scores]

            # get_all()はChromaDBから取得するため、surprise_scoresは含まれない。
            # 統計情報はChromaDBのカウント機能から取得する。
            total_events_from_db = self.memory_system.count()

            surprise_stats = {}
            if all_surprise_scores:
                surprise_stats = {
                    "mean": float(np.mean(all_surprise_scores)),
                    "std": float(np.std(all_surprise_scores)),
                    "max": float(np.max(all_surprise_scores)),
                }
            
            stats = {
                "total_events": total_events_from_db,
                "total_tokens_in_memory": "N/A (persisted)", # 永続化後は正確なトークン数追跡が困難
                "mean_event_size": "N/A (persisted)",
                "surprise_statistics": surprise_stats, # これは最後の対話ターンの統計になる
                "configuration": {
                    "surprise_gamma": self.config.surprise_gamma,
                    "min_event_size": self.config.min_event_size,
                    "max_event_size": self.config.max_event_size,
                    "total_retrieved_events": self.config.total_retrieved_events,
                },
                "llm_config": self.get_current_llm_config_for_diagnostics()
            }
            return stats
        except Exception as e:
            logger.error(f"Failed to get memory statistics: {e}", exc_info=True)
            return {"status": f"Error retrieving statistics: {e}"}