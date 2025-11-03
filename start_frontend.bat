@echo off
REM Tepora Frontend 起動スクリプト (Windows)

echo ========================================
echo    Tepora React Frontend
echo ========================================
echo.

cd frontend

REM 依存関係のインストール確認
if not exist "node_modules" (
    echo 依存関係をインストールしています...
    npm install
)

REM Vite開発サーバーの起動
echo Vite開発サーバーを起動しています...
echo フロントエンド: http://localhost:5173
echo.

npm run dev
