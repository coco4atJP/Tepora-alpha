@echo off
REM Tepora Web Server 起動スクリプト (Windows)

echo ========================================
echo    Tepora AI Agent Web Server
echo ========================================
echo.

REM 環境変数の確認
if not exist ".env" (
    echo 警告: .envファイルが見つかりません
    echo GOOGLE_CUSTOM_SEARCH_API_KEY などを設定してください
    echo.
)

REM Pythonバージョンの確認
python --version
echo.

REM FastAPIサーバーの起動
echo FastAPIサーバーを起動しています...
echo サーバー: http://localhost:8000
echo ドキュメント: http://localhost:8000/docs
echo.
echo フロントエンドを起動するには、別のターミナルで:
echo   cd frontend
echo   npm install
echo   npm run dev
echo.

python web_server.py
