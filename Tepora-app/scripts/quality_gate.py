#!/usr/bin/env python3
"""
Tepora Quality Gate Script
==========================

厳格な品質ゲートを実行する統合スクリプト。
すべてのチェックを順次実行し、失敗があれば即座に終了します。

Usage:
    python quality_gate.py [--strict] [--backend-only] [--frontend-only] [--security]

Options:
    --strict         警告も失敗として扱う
    --backend-only   バックエンドのみチェック
    --frontend-only  フロントエンドのみチェック
    --security       セキュリティスキャンのみ
    --fix            自動修正可能な問題を修正
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

# カラー出力
class Colors:
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    MAGENTA = "\033[95m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    RESET = "\033[0m"


@dataclass
class CheckResult:
    """チェック結果"""
    name: str
    status: Literal["pass", "fail", "skip", "warn"]
    duration: float
    message: str = ""


class QualityGate:
    """品質ゲート実行クラス"""

    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.backend_dir = project_root / "Tepora-app" / "backend"
        self.frontend_dir = project_root / "Tepora-app" / "frontend"
        self.results: list[CheckResult] = []
        self.strict_mode = False
        self.fix_mode = False

    def print_header(self, text: str) -> None:
        """ヘッダー出力"""
        print(f"\n{Colors.BOLD}{Colors.CYAN}{'='*60}{Colors.RESET}")
        print(f"{Colors.BOLD}{Colors.CYAN}  {text}{Colors.RESET}")
        print(f"{Colors.BOLD}{Colors.CYAN}{'='*60}{Colors.RESET}\n")

    def print_step(self, step: str) -> None:
        """ステップ出力"""
        print(f"{Colors.BLUE}▶ {step}{Colors.RESET}")

    def print_result(self, result: CheckResult) -> None:
        """結果出力"""
        if result.status == "pass":
            icon = f"{Colors.GREEN}✓{Colors.RESET}"
            color = Colors.GREEN
        elif result.status == "warn":
            icon = f"{Colors.YELLOW}⚠{Colors.RESET}"
            color = Colors.YELLOW
        elif result.status == "skip":
            icon = f"{Colors.BLUE}○{Colors.RESET}"
            color = Colors.BLUE
        else:
            icon = f"{Colors.RED}✗{Colors.RESET}"
            color = Colors.RED

        print(
            f"  {icon} {result.name}: "
            f"{color}{result.status.upper()}{Colors.RESET} "
            f"({result.duration:.2f}s)"
        )
        if result.message:
            print(f"     {Colors.YELLOW}{result.message}{Colors.RESET}")

    def resolve_command(self, cmd: list[str]) -> list[str]:
        """Windows環境でのコマンド解決（.cmd付与）"""
        if sys.platform == "win32" and cmd[0] in ["npm", "npx", "uv"]:
            # shutil.whichで解決を試みる
            import shutil
            executable = shutil.which(cmd[0])
            if executable:
                cmd[0] = executable
            else:
                # 見つからない場合は .cmd を試す
                cmd[0] = f"{cmd[0]}.cmd"
        return cmd

    def run_command(
        self,
        name: str,
        cmd: list[str],
        cwd: Path,
        warn_only: bool = False,
    ) -> CheckResult:
        """コマンド実行"""
        cmd = self.resolve_command(cmd)
        self.print_step(f"{name}: {' '.join(cmd)}")
        start_time = time.time()

        try:
            result = subprocess.run(
                cmd,
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=300,  # 5分タイムアウト
            )
            duration = time.time() - start_time

            if result.returncode == 0:
                return CheckResult(name, "pass", duration)
            elif warn_only and not self.strict_mode:
                return CheckResult(
                    name, "warn", duration,
                    f"Exit code: {result.returncode}"
                )
            else:
                # エラー詳細を出力
                if result.stdout:
                    print(result.stdout[:1000])
                if result.stderr:
                    print(result.stderr[:1000])
                return CheckResult(
                    name, "fail", duration,
                    f"Exit code: {result.returncode}"
                )

        except subprocess.TimeoutExpired:
            duration = time.time() - start_time
            return CheckResult(name, "fail", duration, "Timeout")
        except FileNotFoundError as e:
            duration = time.time() - start_time
            return CheckResult(name, "skip", duration, str(e))

    def check_backend_ruff_lint(self) -> CheckResult:
        """Ruff lint チェック"""
        cmd = ["uv", "run", "ruff", "check", "src/"]
        if self.fix_mode:
            cmd.append("--fix")
        return self.run_command("Ruff Lint", cmd, self.backend_dir)

    def check_backend_ruff_format(self) -> CheckResult:
        """Ruff format チェック"""
        cmd = ["uv", "run", "ruff", "format", "--check", "src/"]
        if self.fix_mode:
            cmd = ["uv", "run", "ruff", "format", "src/"]
        return self.run_command("Ruff Format", cmd, self.backend_dir)

    def check_backend_mypy(self) -> CheckResult:
        """Mypy 型チェック"""
        return self.run_command(
            "Mypy Type Check",
            ["uv", "run", "mypy", "src/"],
            self.backend_dir,
        )

    def check_backend_pytest(self) -> CheckResult:
        """pytest テスト"""
        return self.run_command(
            "Backend Tests (pytest)",
            ["uv", "run", "pytest", "tests/", "-v", "--tb=short"],
            self.backend_dir,
        )

    def check_frontend_typescript(self) -> CheckResult:
        """TypeScript チェック"""
        return self.run_command(
            "TypeScript Check",
            ["npm", "run", "typecheck"],
            self.frontend_dir,
        )

    def check_frontend_biome(self) -> CheckResult:
        """Biome lint & format チェック"""
        cmd = ["npx", "biome", "check", "src/"]
        if self.fix_mode:
            cmd = ["npx", "biome", "check", "--write", "src/"]
        return self.run_command("Biome Lint & Format", cmd, self.frontend_dir)

    def check_frontend_eslint(self) -> CheckResult:
        """ESLint チェック"""
        cmd = ["npm", "run", "lint"]
        return self.run_command("ESLint", cmd, self.frontend_dir)

    def check_frontend_vitest(self) -> CheckResult:
        """Vitest テスト"""
        return self.run_command(
            "Frontend Tests (vitest)",
            ["npm", "test", "--", "--run"],
            self.frontend_dir,
        )

    def check_security_pip_audit(self) -> CheckResult:
        """pip-audit セキュリティスキャン"""
        return self.run_command(
            "pip-audit (Security)",
            ["uv", "run", "pip-audit"],
            self.backend_dir,
            warn_only=True,
        )

    def check_security_npm_audit(self) -> CheckResult:
        """npm audit セキュリティスキャン"""
        return self.run_command(
            "npm audit (Security)",
            ["npm", "audit", "--audit-level=moderate"],
            self.frontend_dir,
            warn_only=True,
        )

    def run_backend_checks(self) -> None:
        """バックエンドチェック実行"""
        self.print_header("Backend Quality Checks")
        
        checks = [
            self.check_backend_ruff_lint,
            self.check_backend_ruff_format,
            self.check_backend_mypy,
            self.check_backend_pytest,
        ]

        for check in checks:
            result = check()
            self.results.append(result)
            self.print_result(result)
            if result.status == "fail":
                return

    def run_frontend_checks(self) -> None:
        """フロントエンドチェック実行"""
        self.print_header("Frontend Quality Checks")

        checks = [
            self.check_frontend_typescript,
            self.check_frontend_biome,
            self.check_frontend_eslint,
            self.check_frontend_vitest,
        ]

        for check in checks:
            result = check()
            self.results.append(result)
            self.print_result(result)
            if result.status == "fail":
                return

    def run_security_checks(self) -> None:
        """セキュリティチェック実行"""
        self.print_header("Security Checks")

        checks = [
            self.check_security_pip_audit,
            self.check_security_npm_audit,
        ]

        for check in checks:
            result = check()
            self.results.append(result)
            self.print_result(result)

    def print_summary(self) -> bool:
        """サマリー出力、成功時True"""
        self.print_header("Quality Gate Summary")

        passed = sum(1 for r in self.results if r.status == "pass")
        failed = sum(1 for r in self.results if r.status == "fail")
        warned = sum(1 for r in self.results if r.status == "warn")
        skipped = sum(1 for r in self.results if r.status == "skip")
        total_time = sum(r.duration for r in self.results)

        print(f"  {Colors.GREEN}Passed:{Colors.RESET}  {passed}")
        print(f"  {Colors.RED}Failed:{Colors.RESET}  {failed}")
        print(f"  {Colors.YELLOW}Warned:{Colors.RESET}  {warned}")
        print(f"  {Colors.BLUE}Skipped:{Colors.RESET} {skipped}")
        print(f"  {Colors.CYAN}Total Time:{Colors.RESET} {total_time:.2f}s")
        print()

        if failed > 0:
            print(f"{Colors.RED}{Colors.BOLD}❌ QUALITY GATE FAILED{Colors.RESET}")
            return False
        elif warned > 0 and self.strict_mode:
            print(f"{Colors.YELLOW}{Colors.BOLD}⚠️ QUALITY GATE FAILED (strict mode){Colors.RESET}")
            return False
        else:
            print(f"{Colors.GREEN}{Colors.BOLD}✅ QUALITY GATE PASSED{Colors.RESET}")
            return True

    def run(
        self,
        backend: bool = True,
        frontend: bool = True,
        security: bool = True,
        strict: bool = False,
        fix: bool = False,
    ) -> bool:
        """品質ゲート実行"""
        self.strict_mode = strict
        self.fix_mode = fix

        self.print_header("Tepora Quality Gate")
        print(f"  Project Root: {self.project_root}")
        print(f"  Strict Mode:  {strict}")
        print(f"  Fix Mode:     {fix}")

        if backend:
            self.run_backend_checks()
        if frontend:
            self.run_frontend_checks()
        if security:
            self.run_security_checks()

        return self.print_summary()


def main() -> int:
    """メイン関数"""
    parser = argparse.ArgumentParser(
        description="Tepora Quality Gate - 厳格な品質チェック"
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="警告も失敗として扱う",
    )
    parser.add_argument(
        "--backend-only",
        action="store_true",
        help="バックエンドのみチェック",
    )
    parser.add_argument(
        "--frontend-only",
        action="store_true",
        help="フロントエンドのみチェック",
    )
    parser.add_argument(
        "--security",
        action="store_true",
        help="セキュリティスキャンのみ",
    )
    parser.add_argument(
        "--fix",
        action="store_true",
        help="自動修正可能な問題を修正",
    )

    args = parser.parse_args()

    # プロジェクトルート検出
    script_path = Path(__file__).resolve()
    project_root = script_path.parent.parent.parent  # scripts -> Tepora-app -> project

    gate = QualityGate(project_root)

    # チェック対象の決定
    if args.security:
        success = gate.run(
            backend=False, frontend=False, security=True,
            strict=args.strict, fix=args.fix
        )
    elif args.backend_only:
        success = gate.run(
            backend=True, frontend=False, security=False,
            strict=args.strict, fix=args.fix
        )
    elif args.frontend_only:
        success = gate.run(
            backend=False, frontend=True, security=False,
            strict=args.strict, fix=args.fix
        )
    else:
        success = gate.run(
            backend=True, frontend=True, security=True,
            strict=args.strict, fix=args.fix
        )

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
