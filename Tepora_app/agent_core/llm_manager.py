# agent_core/llm_manager.py
import gc
import logging
from typing import Dict, List
import threading
import subprocess
import time, os
import shutil
import requests
import sys
import platform
import re
from pathlib import Path
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_community.llms import LlamaCpp # トークンカウント用に維持
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.embeddings import Embeddings
from langchain_core.messages import BaseMessage
import torch # CUDAチェックのため
from . import config

logger = logging.getLogger(__name__)

class LLMManager:
    """
    GGUFモデルをLlama.cppで動的にロード・アンロードするためのマネージャークラス。
    """
    def __init__(self):
        self._lock = threading.RLock()  # モデルのロード/アンロード操作をスレッドセーフにする
        self._current_model_key = None
        self._chat_llm: ChatOpenAI | None = None
        self._active_process: subprocess.Popen | None = None # 起動中のサーバープロセスを保持
        self._embedding_process: subprocess.Popen | None = None # 埋め込みモデル専用のプロセス
        self._embedding_llm: Embeddings | None = None
        self._current_model_config: Dict | None = None # ロードされたモデルの設定を保持
        self._embedding_config: Dict | None = None # 埋め込みモデルの設定を保持
        self._tokenizer_llm: LlamaCpp | None = None # トークンカウント専用

        logger.info("LLMManager for Llama.cpp initialized.")

    def _unload_model(self):
        """現在ロードされているモデルを解放する。"""
        if not self._current_model_key and not self._active_process:
            return

        logger.info(f"Unloading model: {self._current_model_key or 'N/A'}")

        active_process = self._active_process
        self._active_process = None # 先にNoneに設定

        if active_process:
            logger.info(f"Terminating server process (PID: {active_process.pid})...")
            active_process.terminate()
            try:
                timeout_sec = config.LLAMA_CPP_CONFIG.get("process_terminate_timeout", 10)
                active_process.wait(timeout=timeout_sec)
                logger.info("Server process terminated gracefully.")
            except subprocess.TimeoutExpired:
                logger.warning("Process didn't terminate gracefully, forcing kill...")
                active_process.kill()
                active_process.wait()
                logger.info("Server process killed forcefully.")

        if hasattr(self, '_chat_llm'):
            del self._chat_llm

        self._chat_llm = None
        self._current_model_key = None
        self._current_model_config = None
        gc.collect()

    def _unload_embedding_model(self):
        """埋め込みモデルを解放する。"""
        if not self._embedding_process:
            return

        logger.info("Unloading embedding model...")

        embedding_process = self._embedding_process
        self._embedding_process = None # 先にNoneに設定

        logger.info(f"Terminating embedding server process (PID: {embedding_process.pid})...")
        embedding_process.terminate()
        try:
            timeout_sec = config.LLAMA_CPP_CONFIG.get("process_terminate_timeout", 10)
            embedding_process.wait(timeout=timeout_sec)
            logger.info("Embedding server process terminated gracefully.")
        except subprocess.TimeoutExpired:
            logger.warning("Embedding process didn't terminate gracefully, forcing kill...")
            embedding_process.kill()
            embedding_process.wait()

        self._embedding_llm = None
        self._embedding_config = None

    def _find_server_executable(self, llama_cpp_dir: Path) -> Path | None: # noqa: C901
        """
        システム環境に最適なllama.cppサーバー実行ファイルをインテリジェントに検索する。
        1. バージョン番号 (bXXXX) が新しいものを優先する。
        2. OSと計算環境 (CUDA, Metal, CPUなど) に最適なものを優先する。
        3. ファイルの更新日時を最終的な判断材料とする。
        """
        server_exe_name = "llama-server.exe" if sys.platform == "win32" else "llama-server"
        # 検索パスを柔軟にする: llama.cpp直下と、1階層下のサブディレクトリを検索
        search_patterns = [f"**/{server_exe_name}", f"*/{server_exe_name}"]
        found_files = []
        for pattern in search_patterns:
            found_files.extend(llama_cpp_dir.glob(pattern))

        if not found_files:
            return None

        # --- 環境に応じたバイナリの優先順位を定義 ---
        # リストのインデックスが小さいほど優先度が高い
        arch = platform.machine().lower()
        preferences = []
        if sys.platform == "win32":
            if torch.cuda.is_available():
                preferences.extend(["cuda", "vulkan", "sycl", "opencl", "cpu", "win"])
            else:
                preferences.extend(["vulkan", "sycl", "opencl", "cpu", "win"])
        elif sys.platform == "darwin": # macOS
            if "arm" in arch:
                preferences.extend(["arm64", "macos"]) # Apple Silicon
            else:
                preferences.extend(["x64", "macos"]) # Intel Mac
        elif sys.platform == "linux":
            if torch.cuda.is_available():
                 preferences.extend(["cuda", "vulkan", "x64", "linux"])
            else:
                 preferences.extend(["vulkan", "x64", "linux"])

        def get_file_score(p: Path) -> tuple[int, int, float]:
            """ファイルパスから (バージョン, 環境適合スコア, 更新日時) のタプルを返す。"""
            path_str = str(p.resolve()).lower()
            
            # 1. バージョン番号の抽出 (例: b2915 -> 2915)。正規表現でより堅牢に。
            version = 0
            # パス内に 'b' + 1桁以上の数字 のパターンを探す (例: b2915, b6869)
            match = re.search(r'b(\d+)', path_str)
            if match:
                version = int(match.group(1))
            
            # 2. 環境適合スコアの計算
            # 優先リストにマッチするキーワードのうち、最も優先度が高いもの（インデックスが小さい）を採用
            # スコアは (リストの長さ - インデックス) とし、高いほど良い
            env_score = 0
            for i, pref in enumerate(preferences):
                if pref in path_str:
                    env_score = len(preferences) - i
                    break # 最も優先度の高いものが見つかったら終了
            
            # 3. ファイルの更新日時
            mtime = p.stat().st_mtime
            return (version, env_score, mtime)

        latest_file = max(found_files, key=get_file_score)
        version, env_score, mtime = get_file_score(latest_file)
        
        if version > 0:
            logger.info(f"Found server executable (latest version b{version}): {latest_file.resolve()}")
        else:
            logger.info(f"Found server executable (latest by mtime): {latest_file.resolve()}")
        return latest_file
        
    def _perform_health_check(self, port: int, key: str, stderr_log_path: Path | None = None):
        """指定されたポートでサーバーのヘルスチェックを実行する。"""
        health_check_url = f"http://localhost:{port}/health"
        # キーに応じて設定からタイムアウト値を取得
        timeout_config_key = "embedding_health_check_timeout" if "embedding" in key else "health_check_timeout"
        timeout_seconds = config.LLAMA_CPP_CONFIG.get(timeout_config_key, 20)
        retry_interval = config.LLAMA_CPP_CONFIG.get("health_check_interval", 1.0)
        
        if retry_interval <= 0:
            retry_interval = 1.0 # ゼロ除算を避ける

        num_retries = int(timeout_seconds / retry_interval)

        logger.info(f"Performing health check for '{key}' on {health_check_url} (timeout: {timeout_seconds}s)...")

        for attempt in range(num_retries):
            # ログパスが指定されている場合のみ、管理下のプロセスの状態を確認
            # embedding_processもチェック対象に加える
            process_to_check = self._embedding_process if "embedding" in key else self._active_process
            if stderr_log_path and process_to_check and process_to_check.poll() is not None:
                if "embedding" in key:
                    self._embedding_process = None
                else:
                    self._active_process = None # プロセスハンドルをクリア
                error_detail = f"Review server log for details: {stderr_log_path}"
                raise RuntimeError(f"Server process for '{key}' terminated unexpectedly. {error_detail}")

            try:
                response = requests.get(health_check_url, timeout=0.5)
                if response.status_code == 200 and response.json().get("status") == "ok":
                    logger.info(f"Server for '{key}' is healthy and ready. (Attempt {attempt + 1}/{num_retries})")
                    return  # ヘルスチェック成功
                elif response.status_code == 503:
                    # サーバーがまだ準備中 - 正常なので待機を続ける
                    logger.debug(f"Server for '{key}' is still starting up (503 Service Unavailable). Waiting... (Attempt {attempt + 1}/{num_retries})")
                    pass
                else:
                    # 予期しないステータスコード
                    logger.warning(f"Unexpected health check response: {response.status_code} for '{key}'")
                    pass
            except requests.exceptions.RequestException:
                # 接続失敗はサーバーがまだ準備中である可能性が高い
                pass
            
            time.sleep(retry_interval)
        else:  # for-else: ループがbreakされずに完了した場合
            # ログパスがある場合は、管理下のプロセスなのでクリーンアップを試みる
            if stderr_log_path:
                if "embedding" in key:
                    self._unload_embedding_model()
                else:
                    self._unload_model()
            error_detail = f"Review server log for details: {stderr_log_path}" if stderr_log_path else ""
            raise TimeoutError(f"Server for '{key}' did not become healthy within {timeout_seconds} seconds. {error_detail.strip()}")

    def _load_model(self, key: str):
        """指定された対話用GGUFモデルをLlama.cppでロードする。"""
        with self._lock:
            if self._current_model_key == key:
                return

            # 現在の対話用モデルのみアンロード
            self._unload_model()
            
            model_config = config.MODELS_GGUF[key]
            self._current_model_config = model_config
            
            # プロジェクトのルートディレクトリを基準にパスを構築
            project_root = Path(__file__).parent.parent
            model_path = project_root / model_config["path"]

            # --- サーバー実行ファイルのパスを動的に決定 ---
            llama_cpp_dir = project_root / "llama.cpp"
            server_executable = self._find_server_executable(llama_cpp_dir)

            if not model_path.exists():
                raise FileNotFoundError(f"Model file not found at the absolute path: {model_path.resolve()}")
            if not server_executable:
                error_message = (
                    f"llama.cpp server executable not found in the '{llama_cpp_dir}' directory.\n"
                    "Please download the pre-built binary for your system from the official llama.cpp releases,\n"
                    "unzip it, and place the resulting folder (e.g., 'llama-b2915-bin-win-avx2-x64') inside the 'llama.cpp' directory."
                )
                logger.error(error_message)
                raise FileNotFoundError(error_message)

            # --- ログファイルの準備 ---
            log_dir = project_root / "logs"
            log_dir.mkdir(exist_ok=True)
            stderr_log_path = log_dir / f"llama_server_{key}_{int(time.time())}.log"

            # --- サーバープロセスの起動 ---
            port = model_config["port"]
            command = [
                str(server_executable),
                "-m", str(model_path),
                "--port", str(port),
                "-c", str(model_config.get("n_ctx", 4096)),
                "--n-gpu-layers", str(model_config.get("n_gpu_layers", -1)),
            ]
            # EM-LLMで驚異度計算にlogprobsが必要なモデルの場合、サーバー起動時にオプションを追加
            logger.info(f"Starting llama.cpp server for '{key}' on port {port}...")
            logger.debug(f"Executing command: {' '.join(command)}")
            logger.info(f"Server stderr will be logged to: {stderr_log_path}")

            with open(stderr_log_path, 'w', encoding='utf-8') as log_file:
                self._active_process = subprocess.Popen(
                    command, 
                    stdout=subprocess.DEVNULL, 
                    stderr=log_file
                )
            
            # --- ヘルスチェックの実行 ---
            self._perform_health_check(port, key, stderr_log_path)
            logger.info(f"Server for '{key}' started successfully with PID: {self._active_process.pid}")
            # --- ChatOpenAIクライアントの初期化 ---
            base_url = f"http://localhost:{port}/v1"
            init_kwargs = {
                "model": key,
                "base_url": base_url,
                "api_key": "dummy-key",
                "streaming": True,
            }

            # 標準のOpenAIパラメータ
            standard_params = [
                "temperature", "top_p", "max_tokens", "repeat_penalty"
            ]
            for param in standard_params:
                if param in model_config:
                    init_kwargs[param] = model_config[param]

            # 非標準だがLlama.cppがサポートするパラメータはextra_bodyに入れる
            extra_body = {}
            if model_config.get("logprobs"):
                extra_body["logprobs"] = True
                logger.info(f"Client for '{key}' will request logprobs via extra_body.")

            if "top_k" in model_config:
                extra_body["top_k"] = model_config["top_k"]
                logger.info(f"Client for '{key}' will use top_k={model_config['top_k']} via extra_body.")

            if extra_body:
                init_kwargs["extra_body"] = extra_body

            self._chat_llm = ChatOpenAI(**init_kwargs)
            self._current_model_key = key
            logger.info(f"LLM client for '{key}' connected to {base_url}")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.cleanup()

    def _load_tokenizer(self):
        """トークンカウント専用のLlamaCppインスタンスをロードする。"""
        if self._tokenizer_llm is None:
            logger.info("Loading tokenizer-only LLM instance...")
            # メインの対話モデルと同じトークナイザを使用する
            model_config = config.MODELS_GGUF["gemma_3n"]
            project_root = Path(__file__).parent.parent
            model_path = project_root / model_config["path"]

            if not model_path.exists():
                raise FileNotFoundError(f"Tokenizer model file not found: {model_path.resolve()}")

            # トークナイズのためだけにGPUメモリは使わない
            self._tokenizer_llm = LlamaCpp(
                model_path=str(model_path.resolve()),
                n_ctx=model_config.get("n_ctx", 4096),
                n_gpu_layers=0, # GPUオフロードなし
                verbose=False,
            )
            logger.info("Tokenizer-only LLM instance loaded.")

    def count_tokens_for_messages(self, messages: List[BaseMessage]) -> int:
        """メッセージリストの合計トークン数を数える。"""
        if not messages:
            return 0
            
        self._load_tokenizer()
        if self._tokenizer_llm:
            # ここでは単純に各メッセージのcontentのトークン数を合計する。
            # 実際のプロンプトテンプレートによる追加トークンは含まれないが、
            # 履歴の長さを管理する目的では十分な近似となる。
            total_tokens = 0
            for msg in messages:
                if isinstance(msg.content, str):
                    total_tokens += self._tokenizer_llm.get_num_tokens(msg.content)
            return total_tokens
        
        # フォールバックとして文字数ベースで概算
        logger.warning("Tokenizer LLM not available, falling back to character-based token estimation.")
        # 1トークンあたり平均4文字と仮定
        return sum(len(msg.content) for msg in messages if isinstance(msg.content, str)) // 4

    # 埋め込みモデルを取得するための専用メソッド 
    def get_embedding_model(self) -> Embeddings:
        """埋め込みモデルを取得またはロードする。"""
        if self._embedding_llm is None:
            with self._lock:
                # ダブルチェックロッキング
                if self._embedding_llm is None:
                    key = "embedding_model"
                    model_config = config.MODELS_GGUF[key]
                    self._embedding_config = model_config
                    
                    project_root = Path(__file__).parent.parent
                    model_path = project_root / model_config["path"]
                    llama_cpp_dir = project_root / "llama.cpp"
                    server_executable = self._find_server_executable(llama_cpp_dir)

                    if not model_path.exists():
                        raise FileNotFoundError(f"Embedding model file not found: {model_path.resolve()}")
                    if not server_executable:
                        raise FileNotFoundError("llama.cpp server executable not found.")

                    log_dir = project_root / "logs"
                    log_dir.mkdir(exist_ok=True)
                    stderr_log_path = log_dir / f"llama_server_{key}_{int(time.time())}.log"

                    port = model_config["port"]
                    command = [
                        str(server_executable),
                        "-m", str(model_path),
                        "--port", str(port),
                        "-c", str(model_config.get("n_ctx", 4096)),
                        "--n-gpu-layers", str(model_config.get("n_gpu_layers", -1)),
                        "--embedding" # 埋め込み専用モードで起動
                    ]

                    logger.info(f"Starting llama.cpp server for '{key}' on port {port}...")
                    logger.info(f"Server stderr will be logged to: {stderr_log_path}")

                    with open(stderr_log_path, 'w', encoding='utf-8') as log_file:
                        self._embedding_process = subprocess.Popen(
                            command, 
                            stdout=subprocess.DEVNULL, 
                            stderr=log_file
                        )

                    self._perform_health_check(port, key, stderr_log_path)
                    logger.info(f"Server for '{key}' started successfully with PID: {self._embedding_process.pid}")

                    base_url = f"http://localhost:{port}/v1"
                    self._embedding_llm = OpenAIEmbeddings(
                        model=key,
                        base_url=base_url,
                        api_key="dummy-key",
                    )
                    logger.info("Embedding model client initialized and cached.")
        return self._embedding_llm

    def unload_embedding_model_if_loaded(self):
        """
        このメソッドは埋め込みモデルを永続化する方針に変更されたため、何もしません。
        互換性のために残されています。
        """
        pass

    def get_current_model_config_for_diagnostics(self) -> Dict:
        """
        診断用に、現在ロードされているメインのChatLLMモデルの設定を返す。
        """
        if self._current_model_key and self._current_model_config:
            # インスタンス変数に保持した設定から診断情報を返す
            config_copy = self._current_model_config.copy()
            config_copy["key"] = self._current_model_key
            # streamingは常にTrueなので明示的に追加
            config_copy["streaming"] = True
            return config_copy
        return {}

    def get_character_agent(self) -> BaseChatModel:
        """キャラクター・エージェント (Gemma 3N) を取得する。"""
        self._load_model("gemma_3n")
        return self._chat_llm

    def get_professional_agent(self) -> BaseChatModel:
        """プロフェッショナル・エージェント (Jan-nano) を取得する。"""
        self._load_model("jan_nano")
        return self._chat_llm

    def cleanup(self):
        """アプリケーション終了時にモデルをアンロードする。"""
        logger.info("Cleaning up LLMManager...")
        # 対話用モデルと埋め込みモデルの両方をアンロード
        self._unload_model()
        self._unload_embedding_model()
        
        # トークナイザインスタンスも解放
        if self._tokenizer_llm:
            logger.info("Unloading tokenizer-only LLM instance.")
            del self._tokenizer_llm
            self._tokenizer_llm = None
        
        gc.collect()