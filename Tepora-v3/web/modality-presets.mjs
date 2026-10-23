/** Reviewed 2026-10-23. Suggestions only: selecting one never installs a model,
 * starts a service, authenticates an account or changes a saved route.
 */
export const MODALITY_PRESETS=Object.freeze([
 {id:'stt-granite',role:'stt',name:'Granite Speech 5.0 470M · 10/21日本語版',protocol:'openai-transcriptions',baseUrl:'http://127.0.0.1:8012/v1',model:'ibm-granite/granite-speech-5.0-470m-turboctc',domain:'device',note:'取得済み10/21多言語checkpoint＋Transformers>=5.16専用adapterが必要。公開revision SHAは未取得。既知の旧英語版・異なるCTC headを拒否。録音停止後にCTC認識、streamingではありません。実機精度・速度は未検証。'},
 {id:'stt-nemotron',role:'stt',name:'Nemotron 3.5 0.6B · 録音後認識',protocol:'openai-transcriptions',baseUrl:'http://127.0.0.1:8013/v1',model:'nvidia/nemotron-3.5-asr-streaming-0.6b',domain:'device',note:'公式NeMo-Speech.cppを取得済みGGUFで手動起動。Q8_0約742MB、OpenMDW1.1。この接続は録音後HTTP認識です。upstreamの真のcache付きWebSocket入力は未接続。'},
 {id:'stt-qwen',role:'stt',name:'Qwen3-ASR 0.6B · 日本語代替',protocol:'openai-transcriptions',baseUrl:'http://127.0.0.1:8012/v1',model:'Qwen/Qwen3-ASR-0.6B',domain:'device',note:'専用 qwen-asr adapter と取得済みモデルが必要。CPUの速度は未計測。'},
 {id:'stt-whisper',role:'stt',name:'Whisper turbo · CPU互換',protocol:'openai-transcriptions',baseUrl:'http://127.0.0.1:8012/v1',model:'turbo',domain:'device',note:'既存 faster-whisper adapter。CPU int8、MacではMPSを使用しません。'},
 {id:'stt-openai',role:'stt',name:'OpenAI GPT-Transcribe',protocol:'openai-transcribe',baseUrl:'https://api.openai.com/v1',model:'gpt-transcribe',domain:'cloud',apiKeyEnv:'OPENAI_API_KEY',note:'録音を確認後に送信。API契約・認証・利用料が必要。live音声APIとは別です。'},
 {id:'stt-groq',role:'stt',name:'Groq Whisper large-v3-turbo',protocol:'openai-transcriptions',baseUrl:'https://api.groq.com/openai/v1',model:'whisper-large-v3-turbo',domain:'cloud',apiKeyEnv:'GROQ_API_KEY',note:'録音を確認後に送信。API契約・認証が必要。短い録音にも最低課金時間があります。'},
 {id:'tts-moss',role:'tts',name:'MOSS-TTS-Nano · CPU第一候補',protocol:'openai-speech',baseUrl:'http://127.0.0.1:8880/v1',model:'OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX',voice:'SELECT_INSTALLED_BUILTIN',audioFormat:'wav',domain:'device',note:'専用adapter＋取得済みONNXモデル/codec/公式runtimeが必要。voice欄を --list-voices の実在IDに変更してください。未選択では生成しません。300 model tokens以内の短文用、日本語品質・速度は未検証。'},
 {id:'tts-supertonic',role:'tts',name:'Supertonic 3 · 保守終了の代替',protocol:'openai-speech',baseUrl:'http://127.0.0.1:7788/v1',model:'supertonic-3',voice:'M1',audioFormat:'wav',domain:'device',note:'公式保存版supertonic-py serverを手動導入。2026-09-09 OSSサポート終了。weightsはOpenRAIL-M。WAVを使用、実機品質・導入は未検証。'},
 {id:'tts-qwen',role:'tts',name:'Qwen3-TTS 0.6B · 日本語品質候補',protocol:'openai-speech',baseUrl:'http://127.0.0.1:8880/v1',model:'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',voice:'Ono_Anna',audioFormat:'wav',domain:'device',note:'専用ローカルTTS adapterが必要。約0.9B（全構成）、CPUは低速になり得ます。実機品質・速度は未検証。'},
 {id:'tts-kokoro',role:'tts',name:'Kokoro 82M · 軽量CPU',protocol:'openai-speech',baseUrl:'http://127.0.0.1:8880/v1',model:'kokoro',voice:'jf_alpha',audioFormat:'wav',domain:'device',note:'取得済みKokoroモデルと日本語frontendが必要。軽量ですが日本語品質には制約があります。'},
 {id:'tts-inworld',role:'tts',name:'Inworld TTS-2 Flash',protocol:'openai-speech',baseUrl:'https://api.inworld.ai/v1',model:'inworld-tts-2-flash',voice:'Dennis',domain:'cloud',apiKeyEnv:'INWORLD_API_KEY',note:'公式互換APIと公式サンプルvoice。日本語の試聴は未実施。契約・認証と利用できるvoiceの確認が必要。'},
 {id:'embedding-qwen',role:'embedding',name:'Qwen3-Embedding 0.6B · ローカル',protocol:'ollama-embed',baseUrl:'http://127.0.0.1:11434/api',model:'qwen3-embedding:0.6b',domain:'device',dimensions:1024,embeddingFormat:'qwen3-retrieval-v1',contextTokens:2048,note:'Ollamaモデルは約639MB Q8。取得・起動は別途。2048 tokenの短文索引、長文chunkingは未対応。RAMはweights以上必要です。'},
 {id:'embedding-openai',role:'embedding',name:'OpenAI text-embedding-3-small',protocol:'openai-embeddings',baseUrl:'https://api.openai.com/v1',model:'text-embedding-3-small',domain:'cloud',apiKeyEnv:'OPENAI_API_KEY',dimensions:1536,embeddingFormat:'plain-v1',note:'確認済み・共有の記憶だけを明示同意後に索引。API契約・認証・利用料が必要。'}
]);
export function modalityPreset(id){
 const p=MODALITY_PRESETS.find(p=>p.id===id);if(!p)throw Error('Unknown modality preset');
 const {role,note,...fields}=p;return {...fields,enabled:true,maxParallel:1,timeoutMs:120000};
}
