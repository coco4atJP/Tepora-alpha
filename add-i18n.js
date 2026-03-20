const fs = require('fs');
const path = require('path');

const localesDir = path.join(__dirname, 'frontend', 'public', 'locales');
const teporaProjectRoot = process.env.teporaProjectRoot || 'e:/Tepora_Project/Tepora-app';
const fullLocalesDir = path.join(teporaProjectRoot, 'frontend', 'public', 'locales');

const keysJa = {
  loadError: "設定の読み込みに失敗しました。",
  saving: "変更を保存中...",
  pendingSave: "まもなく保存されます...",
  allSaved: "すべての変更が自動保存されました",
  return: "セッションに戻る",
  autoSave: "自動保存が有効です",
  categories: {
    general: { label: "一般", tabs: { basics: "基本", thinking: "思考プロセス" } },
    appearance: { label: "外観", tabs: { theme: "テーマ", typography: "タイポグラフィ", code_blocks: "コードブロック", notifications: "通知", shortcuts: "ショートカット" } },
    characters: { label: "キャラクター", tabs: { personas: "ペルソナ", custom_agents: "カスタムエージェント" } },
    models: { label: "モデル", tabs: { hub: "ハブ", defaults: "既定値", embedding: "埋め込み", loader: "ローダー", advanced: "高度な設定" } },
    privacy: { label: "プライバシー", tabs: { privacy: "プライバシー", quarantine: "隔離", permissions: "権限" } },
    tools: { label: "ツール", tabs: { web_search: "Web検索", agent_skills: "エージェントスキル", mcp: "MCP", credentials: "認証情報" } },
    memory: { label: "メモリ", tabs: { basics: "基本", decay_engine: "忘却エンジン", retrieval: "検索" } },
    context: { label: "コンテキスト", tabs: { rag: "RAG", window_allocation: "ウィンドウ割り当て" } },
    data: { label: "データ", tabs: { indexing: "インデックス", paths: "パス", cache: "キャッシュ", backup: "バックアップ" } },
    system: { label: "システム", tabs: { integration: "統合", performance: "パフォーマンス", updates: "更新" } },
    advanced: { label: "高度な設定", tabs: { execution: "実行", agent: "エージェント", model_dl: "モデルDL", features: "機能", server: "サーバー" } }
  },
  languages: { en: "英語", ja: "日本語", es: "スペイン語", zh: "中国語" },
  themes: { system: "システム", tepora: "Tepora", light: "ライト", dark: "ダーク" }
};

const keysEn = {
  loadError: "Failed to load settings.",
  saving: "Saving changes...",
  pendingSave: "Saving soon...",
  allSaved: "All changes saved automatically",
  return: "Return to Session",
  autoSave: "Auto-save enabled",
  categories: {
    general: { label: "General", tabs: { basics: "Basics", thinking: "Thinking" } },
    appearance: { label: "Appearance", tabs: { theme: "Theme", typography: "Typography", code_blocks: "Code Blocks", notifications: "Notifications", shortcuts: "Shortcuts" } },
    characters: { label: "Characters", tabs: { personas: "Personas", custom_agents: "Custom Agents" } },
    models: { label: "Models", tabs: { hub: "Hub", defaults: "Defaults", embedding: "Embedding", loader: "Loader", advanced: "Advanced" } },
    privacy: { label: "Privacy", tabs: { privacy: "Privacy", quarantine: "Quarantine", permissions: "Permissions" } },
    tools: { label: "Tools", tabs: { web_search: "Web Search", agent_skills: "Agent Skills", mcp: "MCP", credentials: "Credentials" } },
    memory: { label: "Memory", tabs: { basics: "Basics", decay_engine: "Decay Engine", retrieval: "Retrieval" } },
    context: { label: "Context", tabs: { rag: "RAG", window_allocation: "Window Allocation" } },
    data: { label: "Data", tabs: { indexing: "Indexing", paths: "Paths", cache: "Cache", backup: "Backup" } },
    system: { label: "System", tabs: { integration: "Integration", performance: "Performance", updates: "Updates" } },
    advanced: { label: "Advanced", tabs: { execution: "Execution", agent: "Agent", model_dl: "Model DL", features: "Features", server: "Server" } }
  },
  languages: { en: "English", ja: "Japanese", es: "Spanish", zh: "Chinese" },
  themes: { system: "System", tepora: "Tepora", light: "Light", dark: "Dark" }
};

const keysZh = {
  ...keysEn,
  loadError: "加载设置失败。",
  saving: "正在保存更改...",
  pendingSave: "即将保存...",
  allSaved: "所有更改已自动保存",
  return: "返回会话",
  autoSave: "已启用自动保存",
  categories: {
    general: { label: "常规", tabs: { basics: "基本", thinking: "思考" } },
    appearance: { label: "外观", tabs: { theme: "主题", typography: "排版", code_blocks: "代码块", notifications: "通知", shortcuts: "快捷键" } },
    characters: { label: "角色", tabs: { personas: "角色", custom_agents: "自定义代理" } },
    models: { label: "模型", tabs: { hub: "中心", defaults: "默认", embedding: "嵌入", loader: "加载器", advanced: "高级" } },
    privacy: { label: "隐私", tabs: { privacy: "隐私", quarantine: "隔离", permissions: "权限" } },
    tools: { label: "工具", tabs: { web_search: "网络搜索", agent_skills: "代理技能", mcp: "MCP", credentials: "凭证" } },
    memory: { label: "内存", tabs: { basics: "基本", decay_engine: "衰减引擎", retrieval: "检索" } },
    context: { label: "上下文", tabs: { rag: "RAG", window_allocation: "窗口分配" } },
    data: { label: "数据", tabs: { indexing: "索引", paths: "路径", cache: "缓存", backup: "备份" } },
    system: { label: "系统", tabs: { integration: "集成", performance: "性能", updates: "更新" } },
    advanced: { label: "高级", tabs: { execution: "执行", agent: "代理", model_dl: "模型下载", features: "功能", server: "服务器" } }
  },
  languages: { en: "英语", ja: "日语", es: "西班牙语", zh: "中文" },
  themes: { system: "系统", tepora: "Tepora", light: "浅色", dark: "深色" }
};

const keysEs = {
  ...keysEn,
  loadError: "Error al cargar la configuración.",
  saving: "Guardando cambios...",
  pendingSave: "Guardando pronto...",
  allSaved: "Todos los cambios guardados automáticamente",
  return: "Volver a la sesión",
  autoSave: "Autoguardado habilitado",
  categories: {
    general: { label: "General", tabs: { basics: "Básicos", thinking: "Pensamiento" } },
    appearance: { label: "Apariencia", tabs: { theme: "Tema", typography: "Tipografía", code_blocks: "Bloques de código", notifications: "Notificaciones", shortcuts: "Atajos" } },
    characters: { label: "Personajes", tabs: { personas: "Personas", custom_agents: "Agentes personalizados" } },
    models: { label: "Modelos", tabs: { hub: "Centro", defaults: "Predeterminados", embedding: "Incrustación", loader: "Cargador", advanced: "Avanzado" } },
    privacy: { label: "Privacidad", tabs: { privacy: "Privacidad", quarantine: "Cuarentena", permissions: "Permisos" } },
    tools: { label: "Herramientas", tabs: { web_search: "Búsqueda web", agent_skills: "Habilidades de agente", mcp: "MCP", credentials: "Credenciales" } },
    memory: { label: "Memoria", tabs: { basics: "Básicos", decay_engine: "Motor de decaimiento", retrieval: "Recuperación" } },
    context: { label: "Contexto", tabs: { rag: "RAG", window_allocation: "Asignación de ventana" } },
    data: { label: "Datos", tabs: { indexing: "Indexación", paths: "Rutas", cache: "Caché", backup: "Respaldo" } },
    system: { label: "Sistema", tabs: { integration: "Integración", performance: "Rendimiento", updates: "Actualizaciones" } },
    advanced: { label: "Avanzado", tabs: { execution: "Ejecución", agent: "Agente", model_dl: "Modelos", features: "Características", server: "Servidor" } }
  },
  languages: { en: "Inglés", ja: "Japonés", es: "Español", zh: "Chino" },
  themes: { system: "Sistema", tepora: "Tepora", light: "Claro", dark: "Oscuro" }
};

const mergeDeep = (target, source) => {
  if (typeof target !== 'object' || target === null) return source;
  for (const key of Object.keys(source)) {
    if (source[key] instanceof Object && key in target) {
      Object.assign(source[key], mergeDeep(target[key], source[key]));
    }
  }
  Object.assign(target || {}, source);
  return target;
};

const updateLocale = (lang, keys) => {
  const file = path.join(fullLocalesDir, lang, 'translation.json');
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data.v2) data.v2 = {};
    if (!data.v2.settings) data.v2.settings = {};
    mergeDeep(data.v2.settings, keys);
    fs.writeFileSync(file, JSON.stringify(data, null, '\t') + '\n');
    console.log(`Updated ${lang}`);
  } else {
    console.log(`File not found: ${file}`);
  }
};

updateLocale('ja', keysJa);
updateLocale('en', keysEn);
updateLocale('zh', keysZh);
updateLocale('es', keysEs);
