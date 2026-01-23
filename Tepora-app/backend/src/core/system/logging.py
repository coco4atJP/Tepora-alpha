"""
Logging Module for Tepora V2

ログ設定とメンテナンス機能を提供:
- アプリケーションログ設定
- ログローテーション
- PIIリダクション (オプション)
- 古いログファイルのクリーンアップ
"""

from __future__ import annotations

import logging
import re
import sys
from datetime import datetime, timedelta
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from logging import Logger

# PIIパターン（メール、電話番号、IPアドレス等）
PII_PATTERNS = [
    # メールアドレス
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b"), "[EMAIL]"),
    # 電話番号（日本形式）
    (re.compile(r"\b0\d{1,4}-\d{1,4}-\d{4}\b"), "[PHONE]"),
    # 電話番号（国際形式）
    (re.compile(r"\+\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,9}\b"), "[PHONE]"),
    # IPアドレス
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[IP]"),
    # クレジットカード番号（簡易）
    (re.compile(r"\b(?:\d{4}[-\s]?){3}\d{4}\b"), "[CC]"),
]


class PIIFilter(logging.Filter):
    """ログメッセージからPII（個人識別情報）を除去するフィルター"""

    def __init__(self, name: str = "", enabled: bool = True):
        super().__init__(name)
        self.enabled = enabled

    def filter(self, record: logging.LogRecord) -> bool:
        if self.enabled and record.msg:
            record.msg = self._redact_pii(str(record.msg))
            if record.args:
                record.args = tuple(
                    self._redact_pii(str(arg)) if isinstance(arg, str) else arg
                    for arg in record.args
                )
        return True

    def _redact_pii(self, text: str) -> str:
        """テキストからPIIをリダクト"""
        for pattern, replacement in PII_PATTERNS:
            text = pattern.sub(replacement, text)
        return text


def setup_logging(
    *,
    log_dir: Path | None = None,
    level: int = logging.INFO,
    log_to_console: bool = True,
    log_to_file: bool = True,
    max_bytes: int = 10 * 1024 * 1024,  # 10MB
    backup_count: int = 5,
    pii_redaction: bool = False,
    app_name: str = "tepora",
) -> Logger:
    """
    アプリケーションロガーを設定する

    Args:
        log_dir: ログディレクトリのパス（Noneの場合ファイル出力なし）
        level: ログレベル
        log_to_console: コンソール出力の有効/無効
        log_to_file: ファイル出力の有効/無効
        max_bytes: ログファイルの最大サイズ
        backup_count: ローテーションで保持するファイル数
        pii_redaction: PIIリダクションの有効/無効
        app_name: アプリケーション名（ログファイル名に使用）

    Returns:
        設定されたルートロガー
    """
    # ルートロガー取得
    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    # 既存ハンドラをクリア
    root_logger.handlers.clear()

    # フォーマッター
    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # コンソールハンドラ
    if log_to_console:
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(level)
        console_handler.setFormatter(formatter)
        if pii_redaction:
            console_handler.addFilter(PIIFilter(enabled=True))
        root_logger.addHandler(console_handler)

    # ファイルハンドラ
    if log_to_file and log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / f"{app_name}.log"

        file_handler = RotatingFileHandler(
            log_file,
            maxBytes=max_bytes,
            backupCount=backup_count,
            encoding="utf-8",
        )
        file_handler.setLevel(level)
        file_handler.setFormatter(formatter)
        if pii_redaction:
            file_handler.addFilter(PIIFilter(enabled=True))
        root_logger.addHandler(file_handler)

    return root_logger


def get_logger(name: str) -> Logger:
    """
    指定された名前のロガーを取得する

    Args:
        name: ロガー名（通常は__name__）

    Returns:
        ロガーインスタンス
    """
    return logging.getLogger(name)


# ============================================================
# Log Maintenance Functions
# ============================================================


def cleanup_old_logs(
    log_dir: Path,
    max_age_days: int = 7,
    patterns: list[str] | None = None,
) -> int:
    """
    指定日数より古いログファイルを削除する

    Args:
        log_dir: ログファイルのディレクトリ
        max_age_days: 削除するまでの最大日数
        patterns: マッチさせるglobパターン（デフォルト: ["*.log"]）

    Returns:
        削除されたファイル数
    """
    logger = get_logger(__name__)

    if patterns is None:
        patterns = ["*.log"]

    if not log_dir.exists():
        logger.debug("Log directory does not exist: %s", log_dir)
        return 0

    cutoff = datetime.now() - timedelta(days=max_age_days)
    deleted_count = 0

    for pattern in patterns:
        for log_file in log_dir.glob(pattern):
            if not log_file.is_file():
                continue

            mtime = datetime.fromtimestamp(log_file.stat().st_mtime)
            if mtime < cutoff:
                try:
                    log_file.unlink()
                    deleted_count += 1
                    logger.info(
                        "Deleted old log file: %s (age: %s days)",
                        log_file.name,
                        (datetime.now() - mtime).days,
                    )
                except OSError as e:
                    logger.warning("Failed to delete log file %s: %s", log_file, e)

    if deleted_count > 0:
        logger.info("Cleaned up %d old log files from %s", deleted_count, log_dir)

    return deleted_count


def cleanup_llama_server_logs(log_dir: Path, max_files: int = 20) -> int:
    """
    llama_server_*.log ファイルをクリーンアップし、最新のmax_filesのみ保持

    Args:
        log_dir: ログファイルのディレクトリ
        max_files: モデルタイプごとに保持するファイル数

    Returns:
        削除されたファイル数
    """
    logger = get_logger(__name__)

    if not log_dir.exists():
        return 0

    deleted_count = 0

    for model_type in ["character_model", "embedding_model", "executor_model"]:
        pattern = f"llama_server_{model_type}_*.log"
        files = sorted(
            log_dir.glob(pattern),
            key=lambda f: f.stat().st_mtime,
            reverse=True,
        )

        for old_file in files[max_files:]:
            try:
                old_file.unlink()
                deleted_count += 1
                logger.debug("Deleted excess llama log: %s", old_file.name)
            except OSError as e:
                logger.warning("Failed to delete %s: %s", old_file, e)

    if deleted_count > 0:
        logger.info("Cleaned up %d excess llama server log files", deleted_count)

    return deleted_count
