# 音声・記憶検索のモデル設定（beta.11）

公式資料の確認日: **2026-10-23**。会話の主モデルとは別の設定です。「能力の接続」で新しく追加する際、STTはGranite Speech 5.0 TurboCTC 470Mの10/21多言語版、TTSはMOSS-TTS-Nano CPU ONNX、埋め込みはQwen3-Embedding 0.6Bを候補として表示します。保存済み接続・経路・索引を自動移行しません。初期状態では能力の経路は空で、モデル導入・常駐起動・アカウント認証も行いません。

## 選定と実装範囲

|用途|候補|接続実装と制約|
|---|---|---|
|ローカルSTT第一候補|`ibm-granite/granite-speech-5.0-470m-turboctc`|2026-10-21日本語対応、470MのCTC。新 `speech/granite_asr.py` からローカルcheckpointのみをCPU/CUDAで呼ぶ。Transformers>=5.16。録音終了後の認識で、streamingではない。正確な公開revision SHA取得はHTTP403で未完了。|
|ローカルSTT代替|`nvidia/nemotron-3.5-asr-streaming-0.6b`|公式NeMo-Speech.cppのHTTP multipartに接続。日本語localeは `ja-JP`。upstreamモデルはcache付きstreaming対応だが、今回のTepora経路は録音後認識。Q8_0 GGUF約742MB。|
|ローカルSTT代替|`Qwen/Qwen3-ASR-0.6B`|既存の `speech/server.py --backend qwen`。日本語対応の新世代モデル、CPU既定。1.7Bもモデル欄で指定可能。実機の精度・速度は未測定。|
|軽量互換STT|`turbo`|同adapterの `--backend faster-whisper`。CPU int8。MacのMPS実行は対応しない。CUDAは選択時のみ。|
|クラウドSTT|OpenAI `gpt-transcribe`|`openai-transcribe`形式、`/v1/audio/transcriptions`へ録音をmultipart送信。日本語指定は `languages[]=ja`。|
|クラウドSTT代替|Groq `whisper-large-v3-turbo`|`openai-transcriptions`形式、`https://api.groq.com/openai/v1`。こちらは `language=ja`。短い録音にも最低課金時間あり。|
|ローカルTTS第一候補|`OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX`|新adapterから公式 `OrtCpuRuntime` をCPU2 threadsで呼ぶ。100M＋約22M codec、20言語に日本語を含む。取得済みの組み込みvoiceを明示選択する必要あり。日本語品質は未試聴。|
|ローカルTTS品質比較|`Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`|新しい `workers/tts_server.py`、日本語 `Ono_Anna`、WAV。モデルカード上は全構成約0.9B。CPUでは遅い可能性あり。|
|軽量TTS代替|Supertonic 3|取得済みモデルと公式保存版 `supertonic-py` server。`http://127.0.0.1:7788/v1` / `supertonic-3` / `M1` / WAV。99M、コードMIT・weights OpenRAIL-M。OSS保守は2026-09-09終了、導入・品質は未検証。|
|軽量TTS|Kokoro 82M|同adapter、`kokoro` / `jf_alpha` / 日本語frontend / WAV。公式の日本語voice評価には制約があり、最高品質とは扱わない。|
|クラウドTTS|Inworld `inworld-tts-2-flash`|`https://api.inworld.ai/v1/audio/speech` のOpenAI互換形式。公式例のvoice `Dennis`、MP3。日本語対応の記載はあるが、このvoiceの日本語試聴は未実施。品質優先の `inworld-tts-2` は手動指定可能。|
|ローカル埋め込み|Ollama `qwen3-embedding:0.6b`|Q8モデル約639MB、1024次元、query用英語instructionとdocumentの原文を分離。既定contextは2048 tokensに抑える。|
|クラウド埋め込み|OpenAI `text-embedding-3-small`|`/v1/embeddings`、1536次元。確認済み・共有の記憶だけを明示同意後に送る。|

MOSSの上記モデル・codecとQwen/KokoroはApache-2.0。クラウドは各社の契約・データ条件に従います。ダウンロード容量と実行時RAM/VRAMは異なります。8GB GPUや16GB共有メモリで主LLM・ASR・TTS・埋め込みを全部常駐させる構成は既定にしません。最大並行数は各候補1で、サーバー起動は利用者が個別に行います。CPU/Apple Silicon/Windows CUDAでの同時常駐、電力、RSS、遅延を実測した選定ではありません。

新しいOpenAIファイル音声モデルを、旧Whisper用フィールドへ名前だけ差し替えて送りません。旧 `gpt-4o-*-transcribe` / `whisper-1` や `gpt-4o-mini-tts` / `tts-1*` は廃止予定のため新しい候補に含めません。OpenAI Realtime、Geminiのnative embedding API、MLX、音声クローンはこのバッチでは実装していません。

## ローカル環境の準備

MOSSはモデルとcodecの両方が必要です。公式の組み込みvoiceを使う場合、利用者の参照音声は不要です。モデルpresetの `SELECT_INSTALLED_BUILTIN` は選択待ちの表示で実在voiceではなく、両ホストで送信前に拒否します。adapterの `--list-voices` が取得済みmanifestにある実在IDだけを読み出します。利用者が確認したIDをadapterの `--voice` と能力UIのvoice欄へ同じ値で設定してください。勝手なvoice選択や新しい音声クローンは行いません。

以下は手動セットアップ例であり、アプリが実行する処理ではありません。必要なPython環境・依存パッケージ・ライセンス・モデルサイズを利用者が確認し、別途取得してください。この変更の検証ではインストールや重みの取得を行っていません。

Graniteの新adapterはTorch/Torchaudio（互換version）・Transformers>=5.16.0が必要です。モデルとprocessorをローカルパス・`local_files_only=True`・`trust_remote_code=False`で読み、CPUはfloat32/2 threads、CUDAは明示選択です。8–96kHzのmono PCM16 WAVをprocessorのsample rateへリサンプリングし、最大65秒をCTCで一括復号します。model.generateは非自己回帰CTCで、言語promptやLLMのmax_new_tokensを送りません。`language=ja`は対応言語の確認に使い、モデルは対応言語を自動認識します。マイクやモデルを自動で起動せず、既存のASR設定・保存済み経路は保持します。legacy設定のasrModel/CLI既定Qwenはそのままで、新しい能力設定の候補だけを変更します。

公開model cardは10/21多言語版と旧英語版revision `947f59a`を区別しています。adapterは既知の旧revisionパス/metadataと16384でないCTC headを拒否しますが、これは重みのSHA証明ではありません。正確な多言語revisionを読む公開APIがプロキシHTTP403のため、**このローカルバッチの公開revision pinは未確定**です。利用者が導入する際は、公式の日本語対応snapshotを確認し固定してください。`main`を不変のrevisionとは扱いません。weights約946MBという配布容量と、CPU float32実行時のRAMは異なります。モデルを取得・実行・精度測定したわけではありません。

Apple SiliconのMLX経路はIBM公式資料でmlx-audio>=0.5.1が紹介されていますが、このHTTP adapterには接続していません。MPS/MLX推論の動作保証はしません。

```sh
python Tepora-v3/speech/server.py --backend granite --model /path/to/installed/granite-multilingual-checkpoint --device cpu --port 8012
# Nemotronは取得済みの正しい多言語GGUFを指定する（short aliasによる自動取得は使わない）
nemo-speech serve --asr-model /path/to/installed/nemotron-3.5-multilingual.q8_0.gguf --host 127.0.0.1 --port 8013 --no-ui --max-upload-mb 12
```

Nemotronの公式runtimeはWindows/macOS/Linux、CPU/CUDA/Metal/Vulkanを案内していますが、今回は導入も実機試験も行っていません。`/v1/models`で実際にロードした多言語モデルを利用者が確認する必要があります（HTTPのmodel欄だけでモデルをロード/選択するサーバーではありません）。本プリセットを `asrStreamUrl` に入れても動きません。upstreamの `/v1/audio/transcriptions/realtime` は独自WebSocketイベント・PCM16で、Teporaの既存Float32 `/api/start/chunk/finish` とは別です。この変換adapterは未実装です。

MOSS-Transcribe-Diarize 0.9Bは長時間・話者分離向けの別候補として調査しましたが、今回は接続しません。MOSS-Transcribe-preview-2Bは英語専用なので日本語の既定にはしません。

STTは [既存音声ガイド](../README.md#local-floor-and-optional-workers) を参照し、`qwen-asr` または `faster-whisper` とHTTP adapter依存を用意します。`speech/server.py` の `--model` には取得済みローカルディレクトリも指定できます。その場合は能力側のモデルIDもサーバーが受理する値に合わせてください。既存adapterは明示起動時にライブラリが不足ファイルを取得し得るため、完全オフライン運用には事前取得とライブラリのオフライン設定が必要です。vLLM streamingは別の対応環境が必要で、録音STT用プリセットはstreamingを起動しません。

MOSSには公式リポジトリの `ort_cpu_runtime.py`（確認時commit `8b7bcc9341b3b4ef3a3a58ba1338a7d85ff133eb`）、ONNX Runtime CPU / NumPy / SentencePiece、完全なローカルmanifest・tokenizer・ONNXモデルとcodecを用意します。低水準runtimeを直接呼ぶため、モデル取得helper・PyTorch・参照音声エンコードは使いません。300 model tokens以内の短文を最大75 tokensずつ4区間で生成し、WAVにまとめます。streaming再生・数詞等の追加正規化は未実装です。公式ONNXデモのHTTP APIやvLLM-Omni互換endpointにそのまま接続する実装ではありません。

TTSのQwenには `qwen-tts` / PyTorchと完全なCustomVoiceチェックポイント、Kokoroには `kokoro` / `misaki[ja]` と `config.json`、`kokoro-v1_0.pth`、`voices/jf_alpha.pt` を同じディレクトリに用意します。新adapterはローカルパス必須で、Hugging Face/Transformersをオフラインに設定します。Kokoroの日本語frontendに必要な依存・辞書も事前に用意してください。

```sh
# 取得済みモデルと導入済みruntimeを使う例（自動取得コマンドではない）
python Tepora-v3/workers/tts_server.py --backend moss --model-dir /path/to/moss-models --list-voices
# 得られた実在IDを <voice-id> に指定し、能力UIのvoice欄にも同じ値を設定
python Tepora-v3/workers/tts_server.py --backend moss --model-dir /path/to/moss-models --runtime-dir /path/to/MOSS-TTS-Nano --voice '選択した実在voice-id'
python Tepora-v3/workers/tts_server.py --backend qwen --model-dir /path/to/local-qwen-customvoice --device cpu
# または同じポートでKokoroを1つ起動
python Tepora-v3/workers/tts_server.py --backend kokoro --model-dir /path/to/local-kokoro --device cpu
```

TTSは `127.0.0.1:8880/v1/audio/speech` のみ。モデルIDとvoiceを固定照合し、参照音声などの追加パラメーターを拒否してWAVを返します。MOSSはCPUのみ、48kHz stereoを保持します。1–4000文字、生成音声120秒以下、同時推論1件で待ち行列を作らず429を返します。任意の `TEPORA_TTS_KEY` を利用できますが、値をアプリへ自動転記しません。CPU/CUDAの指定だけを公開し、MPS/MLXは未検証です。クライアント停止は結果受理を止めますが、同期のPython推論を途中で停止できる保証はありません。

埋め込みには稼働中のOllamaと取得済み `qwen3-embedding:0.6b` が必要です。プリセットを保存してもOllamaの起動やpullは実行しません。

## クラウドと送信確認

OpenAIは `OPENAI_API_KEY`、Groqは `GROQ_API_KEY`、Inworldは `INWORLD_API_KEY` という**環境変数名の候補**を表示します。利用者は自分の契約でキーを用意する必要があります。既存の「認証」画面で起動中だけ保持するキーを設定する方法も利用できます。候補の保存や `keyPresent` は認証成功を意味しません。ChatGPT等のサブスクログインを音声APIの従量課金キーとして使いません。

STTのLAN/クラウド経路では、録音停止後に接続名・モデル・API URL・録音サイズを表示し、その録音を送る操作の後だけ転送します。取り消し/Escape/停止/下書き宛先の変更は未送信録音を破棄します。サーバーもvoice有効状態、固定した接続identityと同意を検証し、設定変更後の応答は受け取りません。外部STTの結果は下書きに入り、会話を自動送信しません。ローカル失敗時にクラウドへ切り替えません。

TTSの外部送信は読み上げる文章・接続先を確認して生成します。新しいMOSS/Qwen/Kokoro/Inworld経路は4000文字まで。Inworldの `Dennis` は実在する公式例であり、OpenAIの `alloy` を互換voiceと仮定していません。利用可能voice・契約・リージョンは利用者側で確認してください。

外部埋め込みの検索文送信と、記憶の索引更新には別々の未選択チェック欄があります。画面で確認した接続identityを固定し、表示後に接続が変わると両ホストが送信前に409で拒否します。索引は1回最大24件の確認済み・共有の記憶だけです。非公開または未確認の記憶は送らず、文書が推論中に変わった場合は結果を保存しません。外部モデル呼び出しの費用や既に受け付けられた処理を、クライアント側の停止で取り消せる保証はありません。

## 索引の互換性

既存プロファイルに新しい任意フィールドを加えない限り、従来のidentityを維持します。新候補はprovider/endpoint・モデル・任意revision/digest・次元・入力recipe・context・正規化/文書切り出し版を区別します。異なるidentityのベクトルは同じ次元でも混ぜません。Qwenではqueryに英語の検索instructionを付け、documentには付けず、cosineで比較します（L2正規化の保存処理はなし）。

接続候補を選択・保存しただけでは旧索引や原文を削除しません。再索引が必要なことを検索結果で表示し、明示した索引更新で該当する記憶のキャッシュを置換します。複数モデルの索引を同時保持する仕組みではありません。原文は保持し、未対応の索引ではキーワード検索も続けられます。モデル側の可変タグを自動解決・固定する処理はなく、任意revision欄も実ファイルの検証証明ではありません。重みが変わるときは利用者がdigest/revisionを更新して再索引する必要があります。

既存の先頭12000 UTF-16単位の文書索引を維持し、Qwenプリセットはさらに2048 token contextで制約します。長文chunking・複数チャンク集約・全文RAGは未実装で、token上限による切り詰めを完全に計測した表示はありません。

## 未統合の音声PRとの関係

別のdraft [PR248](https://github.com/coco4atJP/Tepora-alpha/pull/248)（確認時 `6cac858`）は、openWakeWord、発話終端、hands-freeの待機/読み上げ連携を実装しています。このブランチには統合しません。PR248の `web/app.mjs`、`web/bridge.mjs`、能力UI、Node/native音声経路と重なるため、統合時は録音ごとの外部同意・取消・旧応答破棄を維持して再検証する必要があります。既定の英語wakeモデルと日本語STTは別で、日本語のwake phrase対応を意味しません。

## 検証方法と限界

Node/Rustの正規化済みプリセット一致、multipartの新旧フィールド、identity/同意不一致による未送信、取消/Stop All、Qwen query/document差、モデル変更時の旧索引保持をmockと一時データで検証します。ローカルTTSのHTTP契約は合成WAVで検証し、ML runtimeのimportや推論は行いません。`tests/browser-modality-models.mjs` は分離Chromiumのabout:blankへbundleをメモリ注入し、HTTP/HTTPSを遮断して設定・同意UIを確認します。

実モデルの日本語品質・速度、認証済みAPI、課金、マイク、スピーカー、Mac/WindowsネイティブUI、Tauriパッケージ、RAM/VRAM/RSS/電力は未検証です。新しいTTSの実runtime経路は初回実機受け入れが必要です。Supertone SHIFTは音声変換製品であり、このTTS経路には接続していません。SupertonicのOSS保守終了を、同社の全商用製品終了とは解釈しません。

## 公式資料

- [MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano)、[確認した低水準ONNX runtime](https://github.com/OpenMOSS/MOSS-TTS-Nano/blob/8b7bcc9341b3b4ef3a3a58ba1338a7d85ff133eb/ort_cpu_runtime.py)、[ONNXモデル](https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX)、[codec](https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX)
- [Supertonic保存版・保守終了](https://github.com/supertone-oss-archive/supertonic)、[対応Speech API](https://github.com/supertone-oss-archive/supertonic-py/blob/main/docs/cli/serve.md)、[weightsと利用条件](https://huggingface.co/supertone-oss-archive/supertonic-3)

- [IBM Granite 10/21多言語版・公式実行方法](https://huggingface.co/ibm-granite/granite-speech-5.0-470m-turboctc)、[公開announcement](https://huggingface.co/blog/ibm-granite/granite-speech-5)、[CTC config実装](https://github.com/huggingface/transformers/blob/main/src/transformers/models/granite_speech5/configuration_granite_speech5.py)
- [Nemotron 3.5 ASR](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)、[公式NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp)、[HTTP/独自WebSocket仕様](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/api.md)、[MOSS長時間ASR](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize)
- [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [Qwen3-TTS CustomVoiceモデル](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice)、[実行方法](https://github.com/QwenLM/Qwen3-TTS)
- [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)、[voice評価](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
- [OpenAI file transcription](https://developers.openai.com/api/docs/guides/speech-to-text)、[移行ガイド](https://developers.openai.com/cookbook/examples/migrating_from_whisper_to_gpt_transcribe)、[TTS移行](https://developers.openai.com/api/docs/guides/text-to-speech)
- [Groq STT](https://console.groq.com/docs/speech-to-text)、[Inworld互換API](https://docs.inworld.ai/tts/openai-compatibility)、[Inworldモデル](https://docs.inworld.ai/tts/tts-models)
- [Ollama配布](https://ollama.com/library/qwen3-embedding:0.6b)、[Qwen埋め込みの入力形式・仕様](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)、[OpenAI埋め込み](https://developers.openai.com/api/docs/guides/embeddings)
