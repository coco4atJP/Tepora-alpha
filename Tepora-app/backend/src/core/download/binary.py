"""
Binary Manager - llama.cpp バイナリの管理

機能:
- GitHubからのダウンロード
- バージョン管理
- 更新チェック
- フォールバック（同梱CPU版）
"""

import asyncio
import json
import logging
import platform
import re
import shutil
import sys
import tarfile
import zipfile
from datetime import datetime
from pathlib import Path

import httpx

from src.core.common.gpu_detect import get_cuda_version, is_cuda_available

from .progress import DownloadProgressManager
from .types import (
    BinaryRegistry,
    BinaryVariant,
    BinaryVersionInfo,
    DownloadStatus,
    InstallResult,
    ProgressCallback,
    ProgressEvent,
    UpdateInfo,
)

logger = logging.getLogger(__name__)


class BinaryManager:
    """
    llama.cpp バイナリの管理

    - ダウンロード
    - バージョン管理
    - 更新チェック
    - フォールバック
    """

    GITHUB_API_URL = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
    GITHUB_RELEASES_URL = "https://github.com/ggml-org/llama.cpp/releases/download"
    REGISTRY_FILENAME = "binary_versions.json"

    def __init__(self, bin_dir: Path, bundled_fallback: Path | None = None):
        """
        Args:
            bin_dir: バイナリを保存するディレクトリ (e.g., %LOCALAPPDATA%/Tepora/bin)
            bundled_fallback: 同梱CPU版のパス (オプション)
        """
        self.bin_dir = bin_dir
        self.llama_dir = bin_dir / "llama.cpp"
        self.versions_dir = self.llama_dir / "versions"
        self.current_dir = self.llama_dir / "current"
        self.downloads_dir = self.llama_dir / "downloads"  # レジューム用
        self.bundled_fallback = bundled_fallback
        self._registry: BinaryRegistry | None = None
        self._progress_callbacks: list[ProgressCallback] = []
        self._progress_manager = DownloadProgressManager(self.llama_dir)

    def _ensure_dirs(self) -> None:
        """必要なディレクトリを作成"""
        self.versions_dir.mkdir(parents=True, exist_ok=True)
        self.downloads_dir.mkdir(parents=True, exist_ok=True)

    def _get_registry_path(self) -> Path:
        return self.llama_dir / self.REGISTRY_FILENAME

    def _load_registry(self) -> BinaryRegistry:
        """レジストリをロード"""
        registry_path = self._get_registry_path()
        if registry_path.exists():
            try:
                with open(registry_path, encoding="utf-8") as f:
                    data = json.load(f)
                    # Parse installed versions
                    installed = []
                    for v in data.get("installed_versions", []):
                        installed.append(
                            BinaryVersionInfo(
                                version=v["version"],
                                variant=BinaryVariant(v["variant"]),
                                path=Path(v["path"]),
                                installed_at=datetime.fromisoformat(v["installed_at"]),
                                is_bundled=v.get("is_bundled", False),
                            )
                        )
                    return BinaryRegistry(
                        current_version=data.get("current_version"),
                        current_variant=BinaryVariant(data["current_variant"])
                        if data.get("current_variant")
                        else None,
                        installed_versions=installed,
                        last_update_check=datetime.fromisoformat(data["last_update_check"])
                        if data.get("last_update_check")
                        else None,
                    )
            except Exception as e:
                logger.warning(f"Failed to load binary registry: {e}")
        return BinaryRegistry()

    def _save_registry(self, registry: BinaryRegistry) -> None:
        """レジストリを保存"""
        self._ensure_dirs()
        registry_path = self._get_registry_path()
        data = {
            "current_version": registry.current_version,
            "current_variant": registry.current_variant.value if registry.current_variant else None,
            "installed_versions": [
                {
                    "version": v.version,
                    "variant": v.variant.value,
                    "path": str(v.path),
                    "installed_at": v.installed_at.isoformat(),
                    "is_bundled": v.is_bundled,
                }
                for v in registry.installed_versions
            ],
            "last_update_check": registry.last_update_check.isoformat()
            if registry.last_update_check
            else None,
        }
        with open(registry_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    @property
    def registry(self) -> BinaryRegistry:
        if self._registry is None:
            self._registry = self._load_registry()
        return self._registry

    def reload_registry(self) -> None:
        """レジストリを強制的に再ロードする"""
        self._registry = self._load_registry()
        logger.debug("Binary registry reloaded from disk.")

    def on_progress(self, callback: ProgressCallback) -> None:
        """進捗コールバックを登録"""
        self._progress_callbacks.append(callback)

    def _emit_progress(self, event: ProgressEvent) -> None:
        """進捗イベントを発火"""
        for callback in self._progress_callbacks:
            try:
                callback(event)
            except Exception as e:
                logger.warning(f"Progress callback error: {e}")

    def _detect_best_variant(self) -> BinaryVariant:
        """現在の環境に最適なバリアントを検出"""
        if sys.platform == "darwin":
            # macOS
            if platform.machine() == "arm64":
                return BinaryVariant.METAL
            return BinaryVariant.CPU_AVX2

        if sys.platform == "win32":
            # Windows
            if is_cuda_available():
                # CUDA バージョンを確認
                cuda_version = get_cuda_version()
                if cuda_version and cuda_version.startswith("12"):
                    return BinaryVariant.CUDA_12_4
                return BinaryVariant.CUDA_11_8
            # GPUなしの場合はCPU
            return BinaryVariant.CPU_AVX2

        # Linux
        if is_cuda_available():
            return BinaryVariant.CUDA_12_4
        return BinaryVariant.CPU_AVX2

    def _get_asset_regex(self, variant: BinaryVariant) -> str:
        """バリアントに対応するアセット名マッチング用正規表現を取得"""
        # Common pattern parts
        # e.g., llama-b4409-bin-...
        prefix = r"llama-b\d+-bin-"

        if sys.platform == "darwin":
            patterns = {
                BinaryVariant.METAL: r"macos-arm64\.tar\.gz$",
                BinaryVariant.CPU_AVX2: r"macos-x64\.tar\.gz$",
            }
            suffix = patterns.get(variant, r"macos-arm64\.tar\.gz$")
            return prefix + suffix

        elif sys.platform == "win32":
            # Windows ARM64 check (less common for basic llama.cpp generic bins but exists)
            is_arm64 = platform.machine().lower() in ("arm64", "aarch64")

            if is_arm64:
                return prefix + r"win-cpu-arm64\.zip$"

            patterns = {
                BinaryVariant.CUDA_12_4: r"win-cuda-12\.4-x64\.zip$",
                BinaryVariant.CUDA_11_8: r"win-cuda-11\.\d+(\.\d+)?-x64\.zip$",  # Check if actually exists
                BinaryVariant.VULKAN: r"win-vulkan-x64\.zip$",
                BinaryVariant.CPU_AVX2: r"win-cpu-x64\.zip$",
                BinaryVariant.CPU_AVX: r"win-cpu-x64\.zip$",
                BinaryVariant.CPU_SSE42: r"win-cpu-x64\.zip$",
            }
            # Fallback for CUDA 11 check if naming varies
            if variant == BinaryVariant.CUDA_11_8:
                # Catch-all for 11.x?
                return prefix + r"win-cuda-cu11\.\d+(\.\d+)?-x64\.zip$"

            return prefix + patterns.get(variant, r"win-cpu-x64\.zip$")

        else:
            # Linux
            patterns = {
                BinaryVariant.CUDA_12_4: r"linux-cuda-12\.4-x64\.tar\.gz$",
                BinaryVariant.CUDA_11_8: r"linux-cuda-11\.\d+(\.\d+)?-x64\.tar\.gz$",
                BinaryVariant.VULKAN: r"ubuntu-vulkan-x64\.tar\.gz$",
                BinaryVariant.CPU_AVX2: r"ubuntu-x64\.tar\.gz$",
            }
            return prefix + patterns.get(variant, r"ubuntu-x64\.tar\.gz$")

    async def get_current_version(self) -> str | None:
        """現在インストール済みのバージョンを取得"""
        return self.registry.current_version

    async def check_for_updates(self) -> UpdateInfo | None:
        """新しいバージョンがあるかチェック"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.GITHUB_API_URL}/latest",
                    headers={"Accept": "application/vnd.github.v3+json"},
                    timeout=30.0,
                )
                response.raise_for_status()
                data = response.json()

                latest_version = data["tag_name"]
                current_version = self.registry.current_version

                # バージョン比較 (e.g., "b7211" -> 7211)
                def parse_version(v: str) -> int:
                    if v and v.startswith("b"):
                        try:
                            return int(v[1:])
                        except ValueError:
                            pass
                    return 0

                latest_num = parse_version(latest_version)
                current_num = parse_version(current_version) if current_version else 0

                if latest_num > current_num:
                    # 適切なアセットを検索
                    variant = self._detect_best_variant()
                    regex_pattern = self._get_asset_regex(variant)

                    for asset in data.get("assets", []):
                        if re.search(regex_pattern, asset["name"]):
                            # レジストリの更新チェック時刻を更新
                            self._registry = self.registry
                            self._registry.last_update_check = datetime.now()
                            self._save_registry(self._registry)

                            return UpdateInfo(
                                current_version=current_version or "none",
                                latest_version=latest_version,
                                download_url=asset["browser_download_url"],
                                release_notes=data.get("body", ""),
                                file_size=asset.get("size", 0),
                            )

                return None

        except Exception as e:
            logger.error(f"Failed to check for updates: {e}")
            return None

    async def download_and_install(
        self,
        version: str | None = None,
        variant: BinaryVariant = BinaryVariant.AUTO,
    ) -> InstallResult:
        """
        バイナリをダウンロードしてインストール

        Args:
            version: バージョン (None = latest)
            variant: バリアント (AUTO = 自動検出)
        """
        self._ensure_dirs()

        if variant == BinaryVariant.AUTO:
            variant = self._detect_best_variant()

        try:
            self._emit_progress(
                ProgressEvent(
                    status=DownloadStatus.PENDING,
                    progress=0.0,
                    message="リリース情報を取得中...",
                )
            )

            # リリース情報を取得
            async with httpx.AsyncClient(follow_redirects=True) as client:
                if version:
                    url = f"{self.GITHUB_API_URL}/tags/{version}"
                else:
                    url = f"{self.GITHUB_API_URL}/latest"

                response = await client.get(
                    url,
                    headers={"Accept": "application/vnd.github.v3+json"},
                    timeout=30.0,
                )
                response.raise_for_status()
                release_data = response.json()

                version = release_data["tag_name"]
                regex_pattern = self._get_asset_regex(variant)

                # アセットを検索
                download_url = None
                file_size = 0
                for asset in release_data.get("assets", []):
                    if re.search(regex_pattern, asset["name"]):
                        download_url = asset["browser_download_url"]
                        file_size = asset.get("size", 0)
                        break

                if not download_url:
                    return InstallResult(
                        success=False,
                        error_message=f"No suitable asset found for variant {variant.value}",
                    )

                # ダウンロード
                self._emit_progress(
                    ProgressEvent(
                        status=DownloadStatus.DOWNLOADING,
                        progress=0.0,
                        message=f"ダウンロード中: {version} ({variant.value})",
                        total_bytes=file_size,
                    )
                )

                # レジューム対応: downloads_dir に永続的なファイルを保存
                ext = ".zip"
                if "tar.gz" in download_url:
                    ext = ".tar.gz"
                elif download_url.endswith(".zip"):
                    ext = ".zip"

                zip_filename = f"llama-{version}-{variant.value}{ext}"
                target_path = self.downloads_dir / zip_filename
                # .tar.gz の場合、with_suffix は .gz のみを置換するため、文字列連結を使用
                partial_path = self.downloads_dir / (zip_filename + ".part")

                # 既存の部分ダウンロードがあるか確認
                downloaded = 0
                if partial_path.exists():
                    downloaded = partial_path.stat().st_size
                    logger.info(f"Resuming download from {downloaded} bytes")

                # ダウンロードジョブを作成/更新
                job = self._progress_manager.create_job(
                    target_url=download_url,
                    target_path=target_path,
                    total_bytes=file_size,
                )
                job_id = job.job_id

                headers = {}
                if downloaded > 0:
                    headers["Range"] = f"bytes={downloaded}-"

                try:
                    async with client.stream(
                        "GET", download_url, headers=headers, timeout=600.0
                    ) as stream:
                        # 206 Partial Content または 200 OK
                        if stream.status_code == 200 and downloaded > 0:
                            # サーバーがRange未対応、最初からやり直し
                            downloaded = 0
                            partial_path.unlink(missing_ok=True)

                        stream.raise_for_status()

                        # Content-Rangeヘッダーから合計サイズを取得
                        content_range = stream.headers.get("content-range")
                        if content_range:
                            # "bytes 12345-67890/123456" 形式
                            total = int(content_range.split("/")[-1])
                        else:
                            total = (
                                int(stream.headers.get("content-length", file_size)) + downloaded
                            )

                        start_time = asyncio.get_event_loop().time()

                        # 追記モードでファイルを開く
                        mode = "ab" if downloaded > 0 else "wb"
                        with open(partial_path, mode) as f:
                            async for chunk in stream.aiter_bytes(chunk_size=8192):
                                # キャンセル/一時停止チェック
                                if self._progress_manager.is_cancelled(job_id):
                                    raise asyncio.CancelledError("Download cancelled")
                                if self._progress_manager.is_paused(job_id):
                                    # 一時停止時は状態を保存して終了
                                    self._progress_manager.update_job_progress(
                                        job_id, downloaded, total
                                    )
                                    return InstallResult(
                                        success=False,
                                        error_message="Download paused",
                                    )

                                f.write(chunk)
                                downloaded += len(chunk)

                                elapsed = asyncio.get_event_loop().time() - start_time
                                speed = (
                                    (downloaded - job.downloaded_bytes) / elapsed
                                    if elapsed > 0
                                    else 0
                                )
                                eta = (total - downloaded) / speed if speed > 0 else 0

                                self._emit_progress(
                                    ProgressEvent(
                                        status=DownloadStatus.DOWNLOADING,
                                        progress=downloaded / total if total > 0 else 0,
                                        message=f"ダウンロード中: {downloaded // (1024 * 1024)}MB / {total // (1024 * 1024)}MB",
                                        job_id=job_id,
                                        current_bytes=downloaded,
                                        total_bytes=total,
                                        speed_bps=speed,
                                        eta_seconds=eta,
                                    )
                                )

                    # ダウンロード完了、.partを最終ファイルにリネーム
                    partial_path.rename(target_path)

                except asyncio.CancelledError:
                    self._progress_manager.cancel_job(job_id)
                    raise

                # 解凍
                self._emit_progress(
                    ProgressEvent(
                        status=DownloadStatus.EXTRACTING,
                        progress=0.8,
                        message="解凍中...",
                    )
                )

                version_dir = self.versions_dir / f"{version}-{variant.value}"
                if version_dir.exists():
                    shutil.rmtree(version_dir)

                # Check for tar.gz vs zip
                if target_path.suffix == ".gz" and target_path.with_suffix("").suffix == ".tar":
                    # .tar.gz
                    with tarfile.open(target_path, "r:gz") as tf:
                        # Tar Slip check
                        for member in tf.getmembers():
                            extract_target = version_dir / member.name
                            abs_target = extract_target.resolve()
                            abs_root = version_dir.resolve()

                            try:
                                abs_target.relative_to(abs_root)
                            except ValueError:
                                logger.error(f"Tar Slip attempt detected: {member.name}")
                                raise RuntimeError(f"Tar Slip attempt detected: {member.name}")

                        import sys
                        if sys.version_info >= (3, 12):
                            tf.extractall(version_dir, filter='data')
                        else:
                             # Legacy support or warning
                            tf.extractall(version_dir)
                else:
                    # zip
                    with zipfile.ZipFile(target_path, "r") as zf:
                        # Zip Slip 対策: 安全な解凍を行う
                        for member in zf.infolist():
                            # ターゲットパスを解決
                            extract_target = version_dir / member.filename
                            # 絶対パスに正規化し、シンボリックリンクを解決
                            abs_target = extract_target.resolve()
                            abs_root = version_dir.resolve()

                            # 抽出先がversion_dirの外になっていないかチェック
                            try:
                                abs_target.relative_to(abs_root)
                            except ValueError:
                                logger.error(
                                    f"Zip Slip attempt detected: {member.filename} -> {extract_target}"
                                )
                                raise RuntimeError(f"Zip Slip attempt detected: {member.filename}")

                            # 安全であれば解凍
                            zf.extract(member, version_dir)

                # ダウンロードしたアーカイブを削除
                target_path.unlink(missing_ok=True)

                # currentディレクトリを更新（リトライ付き）
                retry_count = 0
                max_retries = 5
                last_error = None

                while retry_count < max_retries:
                    try:
                        if self.current_dir.exists():
                            if self.current_dir.is_symlink():
                                self.current_dir.unlink()
                            else:
                                # Rename strategy for atomic-ish replacement
                                timestamp = int(asyncio.get_event_loop().time())
                                old_path = self.current_dir.with_name(
                                    f"old_{self.current_dir.name}_{timestamp}"
                                )

                                # Try rename first (fast)
                                try:
                                    self.current_dir.rename(old_path)
                                    # Schedule old path deletion (ignore errors)
                                    shutil.rmtree(old_path, ignore_errors=True)
                                except OSError:
                                    # Fallback to direct delete if rename fails
                                    shutil.rmtree(self.current_dir)

                        # Windowsではシンボリックリンクに管理者権限が必要な場合があるのでコピー
                        shutil.copytree(version_dir, self.current_dir)

                        # Success
                        break
                    except OSError as e:
                        last_error = e
                        retry_count += 1
                        wait_time = 1.0 * (2 ** (retry_count - 1))  # 1s, 2s, 4s, 8s, 16s
                        logger.warning(
                            f"File operation failed (attempt {retry_count}/{max_retries}): {e}. Retrying in {wait_time}s..."
                        )
                        await asyncio.sleep(wait_time)

                if retry_count >= max_retries:
                    raise RuntimeError(
                        f"Failed to update current directory after {max_retries} attempts: {last_error}"
                    )

                # レジストリ更新
                self._registry = self.registry
                self._registry.current_version = version
                self._registry.current_variant = variant
                self._registry.installed_versions.append(
                    BinaryVersionInfo(
                        version=version,
                        variant=variant,
                        path=version_dir,
                        installed_at=datetime.now(),
                    )
                )
                self._save_registry(self._registry)

                # ダウンロードジョブを完了
                self._progress_manager.complete_job(job_id)

                self._emit_progress(
                    ProgressEvent(
                        status=DownloadStatus.COMPLETED,
                        progress=1.0,
                        message="インストール完了",
                        job_id=job_id,
                    )
                )

                return InstallResult(
                    success=True,
                    version=version,
                    variant=variant,
                    path=self.current_dir,
                )

        except Exception as e:
            logger.error(f"Failed to download and install: {e}", exc_info=True)
            self._emit_progress(
                ProgressEvent(
                    status=DownloadStatus.FAILED,
                    progress=0.0,
                    message=f"エラー: {str(e)}",
                )
            )
            return InstallResult(
                success=False,
                error_message=str(e),
            )

    async def rollback(self, version: str) -> bool:
        """以前のバージョンにロールバック"""
        for v in self.registry.installed_versions:
            if v.version == version and v.path.exists():
                if self.current_dir.exists():
                    shutil.rmtree(self.current_dir)
                shutil.copytree(v.path, self.current_dir)

                self._registry = self.registry
                self._registry.current_version = v.version
                self._registry.current_variant = v.variant
                self._save_registry(self._registry)

                logger.info(f"Rolled back to version {version}")
                return True

        logger.warning(f"Version {version} not found for rollback")
        return False

    def get_executable_path(self) -> Path | None:
        """
        現在使用すべき実行ファイルのパスを返す
        優先順: current > bundled_fallback
        """
        exe_name = "llama-server.exe" if sys.platform == "win32" else "llama-server"

        # currentディレクトリを確認
        if self.current_dir.exists():
            # サブディレクトリを探索（zipの解凍構造による）
            for path in self.current_dir.rglob(exe_name):
                if path.is_file():
                    return path

        # フォールバック
        if self.bundled_fallback and self.bundled_fallback.exists():
            for path in self.bundled_fallback.rglob(exe_name):
                if path.is_file():
                    logger.warning("Using bundled fallback CPU version")
                    return path

        return None

    def use_fallback(self) -> bool:
        """フォールバックモードに切り替え"""
        if not self.bundled_fallback or not self.bundled_fallback.exists():
            logger.error("No bundled fallback available")
            return False

        exe_name = "llama-server.exe" if sys.platform == "win32" else "llama-server"
        for path in self.bundled_fallback.rglob(exe_name):
            if path.is_file():
                # currentディレクトリをフォールバックで上書き
                if self.current_dir.exists():
                    shutil.rmtree(self.current_dir)
                shutil.copytree(self.bundled_fallback, self.current_dir)

                self._registry = self.registry
                self._registry.current_version = "fallback"
                self._registry.current_variant = BinaryVariant.CPU_AVX2
                self._save_registry(self._registry)

                logger.info("Switched to bundled fallback CPU version")
                return True

        return False

    def is_installed(self) -> bool:
        """バイナリがインストールされているか"""
        return self.get_executable_path() is not None

    # --- ダウンロード制御メソッド ---

    def pause_download(self, job_id: str) -> bool:
        """ダウンロードを一時停止"""
        return self._progress_manager.pause_job(job_id)

    def cancel_download(self, job_id: str) -> bool:
        """ダウンロードをキャンセル"""
        return self._progress_manager.cancel_job(job_id)

    def get_incomplete_downloads(self) -> list:
        """未完了のダウンロード一覧を取得"""
        return self._progress_manager.get_incomplete_jobs()

    async def resume_download(self, job_id: str) -> InstallResult:
        """
        中断されたダウンロードを再開

        Args:
            job_id: 再開するジョブのID

        Returns:
            InstallResult: インストール結果
        """
        job = self._progress_manager.get_job(job_id)
        if not job:
            return InstallResult(
                success=False,
                error_message=f"Job not found: {job_id}",
            )

        if not job.partial_path.exists():
            return InstallResult(
                success=False,
                error_message="Partial file not found, cannot resume",
            )

        # 一時停止フラグをクリア
        self._progress_manager.clear_pause_flag(job_id)

        # ジョブの状態からバージョンとバリアントを推測
        # 注: 本来はジョブ状態に保存すべきだが、ファイル名から解析
        filename = job.target_path.name  # llama-b1234-cuda-12.4.zip or .tar.gz
        # 拡張子を除去
        if filename.endswith(".tar.gz"):
            base = filename[:-7]  # .tar.gz を除去
        elif filename.endswith(".zip"):
            base = filename[:-4]  # .zip を除去
        else:
            base = job.target_path.stem

        parts = base.split("-", 2)  # ['llama', 'b1234', 'cuda-12.4']
        if len(parts) >= 3:
            version = parts[1]
            variant_str = parts[2]
            try:
                variant = BinaryVariant(variant_str)
            except ValueError:
                variant = BinaryVariant.AUTO
        else:
            version = None
            variant = BinaryVariant.AUTO

        # download_and_install を再利用（.part ファイルがあれば自動レジューム）
        return await self.download_and_install(version=version, variant=variant)
