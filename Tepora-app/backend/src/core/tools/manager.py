"""
Tool Manager for Tepora V2

MCPツールおよびネイティブツールを統合的に管理するクラス:
- 設定ファイルからMCP接続を構築し、ツールを発見
- ネイティブツール(DuckDuckGo検索など)の準備
- 同期/非同期に関わらず、ツール実行の統一APIを提供
- バックグラウンドのイベントループを維持し、非同期ツールを安全に実行

設計メモ:
- 非同期ツールは `asyncio` のイベントループで動作させ、同期コードからは
  `asyncio.run_coroutine_threadsafe` により安全に橋渡しします。
- ツール名の衝突を避けるため、MCPツールは「サーバー名_ツール名」に正規化します。
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from collections.abc import Callable, Coroutine, Iterable
from concurrent.futures import TimeoutError as FutureTimeoutError
from typing import TYPE_CHECKING, Any

from .base import ToolProvider

if TYPE_CHECKING:
    from langchain_core.tools import BaseTool

# Type alias for profile filter function
ProfileFilterFunc = Callable[[list[Any], str], Iterable[Any]]

logger = logging.getLogger(__name__)

# デフォルトのツール実行タイムアウト（秒）
DEFAULT_TOOL_TIMEOUT = 30


class ToolManager:
    """
    MCPツールおよびネイティブツールを統合的に管理するクラス

    責務:
    - 設定ファイルからMCP接続を構築し、ツールを発見
    - ネイティブツール(DuckDuckGo検索など)の準備
    - 同期/非同期に関わらず、ツール実行の統一APIを提供
    - バックグラウンドのイベントループを維持し、非同期ツールを安全に実行

    使用例:
        manager = ToolManager(providers=[NativeToolProvider(), MCPToolProvider()])
        manager.initialize()
        result = manager.execute_tool("search", {"query": "test"})
        manager.cleanup()
    """

    def __init__(
        self,
        providers: list[ToolProvider] | None = None,
        tool_timeout: int = DEFAULT_TOOL_TIMEOUT,
    ):
        """
        Args:
            providers: ツールを提供するToolProviderのリスト
            tool_timeout: ツール実行のタイムアウト（秒）
        """
        self.providers = providers or []
        self.tools: list[BaseTool] = []
        self.tool_map: dict[str, BaseTool] = {}
        self._all_tools: list[BaseTool] = []
        self._lock = threading.RLock()
        self._tool_timeout = tool_timeout

        self._profile_name: str = "default"
        self._profile_filter: ProfileFilterFunc | None = None

        # 非同期処理専用のイベントループを作成し、
        # デーモンスレッドで永続的に回し続ける
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self._thread.start()
        logger.info("Async task runner thread started.")

    def set_profile_filter(self, filter_func: ProfileFilterFunc | None) -> None:
        """
        プロファイルベースのツールフィルタリング関数を設定

        Args:
            filter_func: (tools, profile_name) -> filtered_tools のフィルタ関数
        """
        self._profile_filter = filter_func

    def _run_coroutine(self, coro: Coroutine[Any, Any, Any]) -> Any:
        """
        同期コードから非同期関数を安全に呼び出すためのブリッジメソッド

        バックグラウンドのイベントループにコルーチンを送信し、
        現在のスレッドで待機します。
        """
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return future.result(timeout=self._tool_timeout)
        except (FutureTimeoutError, TimeoutError):
            logger.error("Coroutine execution timed out after %d seconds.", self._tool_timeout)
            raise
        except Exception:
            raise

    def _make_error_response(self, error_code: str, message: str, **kwargs: Any) -> str:
        """
        フロントエンド翻訳用の構造化エラーレスポンスを作成

        Args:
            error_code: エラーコード
            message: エラーメッセージ
            **kwargs: 追加フィールド

        Returns:
            JSON文字列形式のエラーレスポンス
        """
        response = {
            "error": True,
            "error_code": error_code,
            "message": message,
            **kwargs,
        }
        return json.dumps(response, ensure_ascii=False)

    def execute_tool(self, tool_name: str, tool_args: dict[str, Any]) -> str | Any:
        """
        指定されたツールを同期/非同期を自動で判断して実行する

        graph.pyからはこのメソッドだけを呼び出せば良いです。

        処理の流れ:
        1. ツール名でツールインスタンスを取得
        2. `aexecute_tool`をコルーチンとして取得
        3. バックグラウンドのイベントループで実行し、結果を待つ

        Args:
            tool_name: 実行するツール名
            tool_args: ツールへの引数

        Returns:
            ツールの実行結果またはエラーレスポンス
        """
        try:
            logger.info("Executing tool '%s' via sync bridge.", tool_name)
            coro = self.aexecute_tool(tool_name, tool_args)
            return self._run_coroutine(coro)
        except (FutureTimeoutError, TimeoutError):
            logger.error("Tool '%s' execution timed out.", tool_name)
            return self._make_error_response(
                "tool_timeout",
                f"Tool '{tool_name}' execution timed out.",
                tool_name=tool_name,
            )
        except Exception as e:
            logger.error("Error executing tool %s: %s", tool_name, e, exc_info=True)
            return self._make_error_response(
                "tool_execution_error",
                f"Error executing tool {tool_name}: {e}",
                tool_name=tool_name,
                details=str(e),
            )

    async def aexecute_tool(self, tool_name: str, tool_args: dict[str, Any]) -> str | Any:
        """
        非同期コンテキストからツールを実行する

        Args:
            tool_name: 実行するツール名
            tool_args: ツールへの引数

        Returns:
            ツールの実行結果またはエラーレスポンス
        """
        tool_instance = self.get_tool(tool_name)
        if not tool_instance:
            logger.error("Tool '%s' not found.", tool_name)
            return self._make_error_response(
                "tool_not_found",
                f"Tool '{tool_name}' not found.",
                tool_name=tool_name,
            )

        try:
            if hasattr(tool_instance, "ainvoke"):
                logger.info("Executing ASYNC tool: %s", tool_name)
                return await tool_instance.ainvoke(tool_args)

            if hasattr(tool_instance, "invoke"):
                logger.info("Executing SYNC tool in executor: %s", tool_name)
                return await asyncio.to_thread(tool_instance.invoke, tool_args)

            return self._make_error_response(
                "tool_no_method",
                f"Tool '{tool_name}' has no callable invoke or ainvoke method.",
                tool_name=tool_name,
            )
        except Exception as exc:
            logger.error(
                "Error executing tool %s asynchronously: %s",
                tool_name,
                exc,
                exc_info=True,
            )
            return self._make_error_response(
                "tool_execution_error",
                f"Error executing tool {tool_name}: {exc}",
                tool_name=tool_name,
                details=str(exc),
            )

    def initialize(self) -> None:
        """
        登録されたプロバイダからツールを初期化する
        """
        logger.info("Initializing ToolManager...")
        loaded_tools: list[BaseTool] = []

        for provider in self.providers:
            # Defensive: use class name if name property is missing
            provider_name = getattr(provider, "name", None) or provider.__class__.__name__
            try:
                logger.info("Loading tools from provider: %s", provider_name)
                provider_tools = self._run_coroutine(provider.load_tools())
                loaded_tools.extend(provider_tools)
                logger.info("Loaded %d tools from %s.", len(provider_tools), provider_name)
            except Exception as e:
                logger.error(
                    "An error occurred while loading tools from %s: %s",
                    provider_name,
                    e,
                    exc_info=True,
                )

        # 全ツールリストを保持し、プロファイルでフィルタリング
        all_tools = list(loaded_tools)
        filtered = self._apply_profile_filter(all_tools)
        tool_map = {tool.name: tool for tool in filtered}

        # 差し替えはロック下で実施
        with self._lock:
            self._all_tools = all_tools
            self.tools = filtered
            self.tool_map = tool_map

        total_loaded = len(all_tools)

        logger.info(
            "ToolManager initialized with %d tools (profile '%s', %d total loaded): %s",
            len(filtered),
            self._profile_name,
            total_loaded,
            [t.name for t in filtered],
        )

    def _apply_profile_filter(self, tools: list[BaseTool]) -> list[BaseTool]:
        """プロファイルフィルタを適用"""
        if self._profile_filter is None:
            return tools
        return list(self._profile_filter(tools, self._profile_name))

    def set_profile(self, profile_name: str) -> int:
        """
        新しいエージェントプロファイルを適用し、ツールを再フィルタリング

        Args:
            profile_name: プロファイル名

        Returns:
            利用可能なツール数
        """
        with self._lock:
            self._profile_name = profile_name
            if not self._all_tools:
                self.tools = []
                self.tool_map = {}
                return 0

            filtered = self._apply_profile_filter(self._all_tools)
            self.tools = list(filtered)
            self.tool_map = {tool.name: tool for tool in self.tools}

        logger.info(
            "Tool profile switched to '%s' (%d tools available)",
            self._profile_name,
            len(self.tools),
        )
        return len(self.tools)

    def get_tool(self, tool_name: str) -> BaseTool | None:
        """
        指定された名前のツールを取得する

        Args:
            tool_name: ツール名

        Returns:
            ツールインスタンス、見つからない場合はNone
        """
        with self._lock:
            return self.tool_map.get(tool_name)

    def list_tools(self) -> list[str]:
        """
        利用可能なツール名のリストを取得

        Returns:
            ツール名のリスト
        """
        with self._lock:
            return list(self.tool_map.keys())

    @property
    def all_tools(self) -> list[BaseTool]:
        """
        すべての読み込み済みツールを取得（プロファイルフィルタ適用前）

        Returns:
            全ツールのリスト
        """
        with self._lock:
            return list(self._all_tools)

    def cleanup(self) -> None:
        """
        リソースのクリーンアップ

        - プロバイダのクリーンアップ
        - バックグラウンドイベントループを停止
        """
        # プロバイダのクリーンアップ
        for provider in self.providers:
            try:
                provider.cleanup()
            except Exception as e:
                logger.warning("Error during provider cleanup: %s", e, exc_info=True)

        if self._loop.is_running():
            logger.info("Stopping async task runner thread...")
            try:
                shutdown_future = asyncio.run_coroutine_threadsafe(
                    self._loop.shutdown_asyncgens(), self._loop
                )
                shutdown_future.result(timeout=5)
            except Exception as e:
                logger.warning(
                    "Failed to shutdown async generators gracefully: %s",
                    e,
                    exc_info=True,
                )

            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=5)
            if self._thread.is_alive():
                logger.warning("Async runner thread did not stop gracefully.")
            else:
                logger.info("Async task runner thread stopped.")

        if not self._loop.is_closed():
            logger.debug("Closing async event loop.")
            self._loop.close()
