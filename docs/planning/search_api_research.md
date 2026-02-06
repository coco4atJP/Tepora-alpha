# Brave・Bing検索API追加に関する調査報告

ネイティブ検索ツール（`backend-rs/src/search.rs`）にBraveとBingの検索エンジンを追加するための要件と実装方針を調査しました。

## 1. Google Search (現状の比較用)
- **Endpoint**: `https://www.googleapis.com/customsearch/v1`
- **Auth**: Query params (`key`, `cx`)
- **Status**: 実装済み

## 2. Brave Search API
- **Endpoint**: `https://api.search.brave.com/res/v1/web/search`
- **Authentication**:
  - Header: `X-Subscription-Token` (API Key)
  - アカウント登録とクレジットカード登録（無料枠でも必須）が必要。
- **Pricing & Limits**:
  - **Free**: 2,000 requests/month (1 req/sec)
  - **Paid**: $3.00/1,000 requests (Base plan)
- **Response Format**: JSON
- **Documentation**: [Brave Search API](https://brave.com/search/api/)

## 3. Bing Web Search API (v7)
- **Endpoint**: `https://api.bing.microsoft.com/v7.0/search`
- **Authentication**:
  - Header: `Ocp-Apim-Subscription-Key`
  - AzureアカウントとBing Searchリソースの作成が必要。
- **Pricing & Limits**:
  - **F1 (Free)**: 1,000 transactions/month, 3 TPS (Transactions Per Second)
  - **S1 (Paid)**: $15 - $25 per 1,000 transactions (vary by volume)
- **Response Format**: JSON
- **Documentation**: [Bing Web Search API](https://learn.microsoft.com/en-us/bing/search-apis/bing-web-search/overview)

---

## 4. 実装要件 (Backend Check)

`backend-rs/src/search.rs` の変更が必要です。

### A. 設定(`config`)の拡張
現在のGoogle/DuckDuckGoと同様に、設定ファイルから以下のキーを読み込む必要があります。
- `brave_search_api_key`
- `bing_search_api_key`
- `search_provider` (既存) に `brave`, `bing` のサポートを追加

### B. 関数追加
それぞれのAPIに対応する非同期関数を実装します。

1.  **`brave_search(query: &str, api_key: &str)`**
    - HTTP GET request to Brave endpoint
    - Header: `X-Subscription-Token: <api_key>`
    - Query param: `q=<encoded_query>`
    - Response parsing: `web.results` 配列から `title`, `url`, `description` を抽出して `SearchResult` にマッピング。

2.  **`bing_search(query: &str, api_key: &str)`**
    - HTTP GET request to Bing endpoint
    - Header: `Ocp-Apim-Subscription-Key: <api_key>`
    - Query param: `q=<encoded_query>`
    - Response parsing: `webPages.value` 配列から `name` (title), `url`, `snippet` を抽出して `SearchResult` にマッピング。

## 5. 懸念点・注意点
- **Brave**: 無料枠でもクレジットカード登録が必要なため、ユーザーへの案内時にはその旨を伝える必要があります。
- **Bing**: Azure Portalでのセットアップが必要で、少し手数がかかります。また、LLM連携用には別途 "Grounding with Bing Search" が推奨されていますが、通常の検索用途であれば Web Search API v7 で問題ありません。
