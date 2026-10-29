/** Connection templates, not capability/entitlement claims. Models are selected by the user.
 * Gateways are user-managed: Tepora neither installs a proxy nor reads its upstream credentials.
 */
export const PROVIDER_PRESETS=Object.freeze({
 ollama:['Ollama','chat-completions','device','http://127.0.0.1:11434/v1'],
 llama:['llama.cpp','chat-completions','device','http://127.0.0.1:8080/v1'],
 vllm:['vLLM','chat-completions','device','http://127.0.0.1:8000/v1'],
 lmstudio:['LM Studio','chat-completions','device','http://127.0.0.1:1234/v1'],
 openai:['OpenAI API（従量課金）','responses','cloud','https://api.openai.com/v1'],
 anthropic:['Anthropic API','anthropic','cloud','https://api.anthropic.com/v1'],
 gemini:['Google Gemini API','gemini','cloud','https://generativelanguage.googleapis.com/v1beta'],
 openrouter:['OpenRouter','chat-completions','cloud','https://openrouter.ai/api/v1'],
 vercel:['Vercel AI Gateway','chat-completions','cloud','https://ai-gateway.vercel.sh/v1'],
 groq:['Groq','chat-completions','cloud','https://api.groq.com/openai/v1'],
 cerebras:['Cerebras','chat-completions','cloud','https://api.cerebras.ai/v1'],
 together:['Together AI','chat-completions','cloud','https://api.together.xyz/v1'],
 fireworks:['Fireworks AI','chat-completions','cloud','https://api.fireworks.ai/inference/v1'],
 nvidia:['NVIDIA NIM API','chat-completions','cloud','https://integrate.api.nvidia.com/v1'],
 deepseek:['DeepSeek','chat-completions','cloud','https://api.deepseek.com/v1'],
 mistral:['Mistral','chat-completions','cloud','https://api.mistral.ai/v1'],
 xai:['xAI','chat-completions','cloud','https://api.x.ai/v1'],
 moonshot:['Moonshot / Kimi（国際）','chat-completions','cloud','https://api.moonshot.ai/v1'],
 zai:['Z.ai（通常API）','chat-completions','cloud','https://api.z.ai/api/paas/v4'],
 opencodego:['OpenCode Go','chat-completions','cloud','https://opencode.ai/zen/go/v1'],
 cliproxy:['CLIProxyAPI（自分で起動したプロキシ）','chat-completions','device','http://127.0.0.1:8317/v1'],
 litellm:['LiteLLM（自分で起動したゲートウェイ）','chat-completions','device','http://127.0.0.1:4000/v1']
});
/** Preserve hidden advanced fields when editing one visible field or a role route. */
export function editableProvider(p){return Object.fromEntries([
 'id','name','protocol','baseUrl','model','domain','pinnedAddress','allowPlainHttp','enabled','apiKeyEnv','capabilities',
 'maxTokens','contextTokens','timeoutMs','firstByteTimeoutMs','idleTimeoutMs','maxParallel','resource','reasoningEffort',
 'thinkingBudget','thinking','sampling','server','cache','sessionHeader','authMode','accountId','engine','piProvider'
].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]));}
