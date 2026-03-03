const fs = require('fs');
const path = require('path');

const localesDirs = [
    { code: 'ja', path: '../frontend/public/locales/ja/translation.json' },
    { code: 'en', path: '../frontend/public/locales/en/translation.json' },
    { code: 'es', path: '../frontend/public/locales/es/translation.json' },
    { code: 'zh', path: '../frontend/public/locales/zh/translation.json' },
];

const newTranslations = {
    en: {
        settings: {
            sections: {
                extended: {
                    ui_title: "UI Design & Notifications",
                    ui_description: "Configure appearance details and background notifications.",
                    font_family: "Font Family",
                    font_family_desc: "UI font family for main text rendering.",
                    font_family_placeholder: "e.g. Noto Sans",
                    font_size: "Font Size",
                    font_size_desc: "Base UI font size in pixels.",
                    code_theme: "Code Highlight Theme",
                    code_theme_desc: "Syntax highlighting theme for code blocks.",
                    code_theme_placeholder: "e.g. github-dark",
                    thinking_max_tokens: "Thinking Max Tokens",
                    thinking_max_tokens_desc: "Upper limit for thinking token consumption.",
                    code_wrap: "Code Block Wrap",
                    code_wrap_desc: "Enable line wrapping for code blocks.",
                    code_line_numbers: "Code Block Line Numbers",
                    code_line_numbers_desc: "Display line numbers in code blocks.",
                    notification_os: "Background Task OS Notification",
                    notification_os_desc: "Show an OS notification when background tasks complete.",
                    notification_sound: "Background Task Sound",
                    notification_sound_desc: "Play a notification sound when background tasks complete.",
                    shortcuts_title: "Shortcuts",
                    shortcuts_description: "Configure keyboard shortcuts for quick actions.",
                    shortcut_new_chat: "Shortcut: New Chat",
                    shortcut_new_chat_desc: "Keyboard shortcut for starting a new chat.",
                    shortcut_custom: "Additional Shortcuts",
                    shortcut_custom_desc: "Add shortcuts as action=keybinding (for example: open_settings=Ctrl+,).",
                    chunk_chars: "Chunk Size (Chars)",
                    chunk_chars_desc: "Chunk size when indexing text by character count.",
                    chunk_tokens: "Chunk Size (Tokens)",
                    chunk_tokens_desc: "Chunk size when indexing text by token count.",
                    chunk_overlap: "Chunk Overlap",
                    chunk_overlap_desc: "Overlap size between consecutive chunks.",
                    export_format: "Backup Export Format",
                    export_format_desc: "Preferred format for backup exports.",
                    watch_folders: "Watched Folders",
                    watch_folders_desc: "Folders monitored for indexing targets.",
                    watch_folders_placeholder: "e.g. D:\\docs",
                    vector_store_dir: "Vector Store Directory",
                    vector_store_dir_desc: "Storage path for vector database files.",
                    vector_store_dir_placeholder: "e.g. E:\\Tepora\\db",
                    model_files_dir: "Model Files Directory",
                    model_files_dir_desc: "Storage path for model binaries.",
                    model_files_dir_placeholder: "e.g. E:\\Tepora\\models",
                    backup_chat_history: "Backup: Chat History",
                    backup_settings: "Backup: Settings Data",
                    backup_characters: "Backup: Characters",
                    backup_executors: "Backup: Executors",
                    restore_enabled: "Enable Backup Restore",
                    character_import_export: "Character Import/Export",
                    executor_import_export: "Executor Import/Export",
                    cache_clear_on_start: "Clear Webfetch Cache on Startup",
                    cache_cleanup_embeddings: "Cleanup Old Embeddings",
                    cache_cleanup_temp: "Cleanup Temporary Files",
                    cache_limit_mb: "Cache Capacity Limit (MB)",
                    storage_title: "Data Management and Storage",
                    storage_description: "Configure chunking, watched folders, storage paths, backups, and cache policies.",
                    performance_title: "System Integration and Performance",
                    performance_description: "Control startup behavior, tray mode, hardware acceleration, and resource limits.",
                    auto_start: "Auto Start on OS Login",
                    tray_resident: "Keep Running in System Tray",
                    hardware_acceleration: "Hardware Acceleration",
                    gpu_vram_limit: "GPU VRAM Limit (MB)",
                    memory_limit: "Memory Limit (MB)",
                    security_title: "Network and Server Security",
                    security_description: "Configure core tool policy, network proxies, certificates, and server origins.",
                    allowed_tools: "Core Tool Allow List",
                    allowed_tools_desc: "Allowed tool names when using allow-list policy.",
                    denied_tools: "Core Tool Deny List",
                    denied_tools_desc: "Denied tool names when using deny-list policy.",
                    tool_confirmation: "Tool Execution Confirmation",
                    first_use_confirmation: "First-use Confirmation",
                    dangerous_patterns: "Blocked Command Patterns",
                    dangerous_patterns_desc: "Command patterns that should always be blocked.",
                    proxy_http: "HTTP Proxy",
                    proxy_http_desc: "Proxy URL for HTTP requests.",
                    proxy_https: "HTTPS Proxy",
                    proxy_https_desc: "Proxy URL for HTTPS requests.",
                    custom_certificate: "Custom Certificate Path",
                    custom_certificate_desc: "Path to custom CA certificate bundle.",
                    server_host: "Server Host",
                    server_host_desc: "Host binding for backend server.",
                    allowed_origins: "Allowed Origins",
                    allowed_origins_desc: "Origins permitted to access the backend.",
                    cors_origins: "CORS Allowed Origins",
                    cors_origins_desc: "Origins allowed by CORS policy.",
                    ws_origins: "WebSocket Allowed Origins",
                    ws_origins_desc: "Origins allowed for WebSocket connections.",
                    models_title: "Model and LLM Extensions",
                    models_description: "Set model defaults and advanced generation metadata not covered in the standard model cards.",
                    character_default_model: "Character Default Model",
                    supervisor_default_model: "Supervisor/Planner Default Model",
                    executor_default_model: "Executor Default Model",
                    logprobs: "Enable Logprobs",
                    logprobs_desc: "Emit token-level log probabilities where supported.",
                    system_prompt_prefix: "System Prompt Prefix",
                    system_prompt_prefix_desc: "Prepended text for system prompts.",
                    system_prompt_suffix: "System Prompt Suffix",
                    system_prompt_suffix_desc: "Appended text for system prompts.",
                    loader_specific_text: "Text Model Loader-specific Settings",
                    loader_specific_text_desc: "Serialized loader-specific configuration for text model.",
                    loader_specific_embedding: "Embedding Loader-specific Settings",
                    loader_specific_embedding_desc: "Serialized loader-specific configuration for embedding model."
                }
            },
            mcp: {
                policy: {
                    title: "Tool Security Policy",
                    mode: {
                        label: "Policy Mode",
                        description: "Control how MCP servers are allowed to execute tools.",
                        local_only: "Local Only",
                        stdio_only: "Stdio Only",
                        allowlist: "Allowlist"
                    },
                    confirmation: {
                        label: "Require Confirmation",
                        description: "Require manual approval before executing tools."
                    },
                    first_use: {
                        label: "First-use Confirmation",
                        description: "Show confirmation on first tool invocation per session."
                    },
                    blocked_commands: {
                        label: "Blocked Commands",
                        description: "Commands that MCP servers are never allowed to execute.",
                        placeholder: "e.g. rm -rf"
                    }
                }
            }
        }
    },
    ja: {
        settings: {
            sections: {
                extended: {
                    ui_title: "UIと通知",
                    ui_description: "UIの表示詳細とバックグラウンド通知を設定します。",
                    font_family: "フォントファミリー",
                    font_family_desc: "メインテキストの表示に使用するUIフォント。",
                    font_family_placeholder: "例: Noto Sans",
                    font_size: "フォントサイズ",
                    font_size_desc: "基本となるUIフォントサイズ (px)。",
                    code_theme: "コードハイライトのテーマ",
                    code_theme_desc: "コードブロックのシンタックスハイライトテーマ。",
                    code_theme_placeholder: "例: github-dark",
                    thinking_max_tokens: "思考プロセスの最大トークン",
                    thinking_max_tokens_desc: "思考プロセスで消費するトークンの上限。",
                    code_wrap: "コードの折り返し",
                    code_wrap_desc: "コードブロック内でのテキスト折り返しを有効にします。",
                    code_line_numbers: "行番号の表示",
                    code_line_numbers_desc: "コードブロックに行番号を表示します。",
                    notification_os: "バックグラウンド完了のOS通知",
                    notification_os_desc: "バックグラウンドタスクが完了したときにOSネイティブの通知を表示します。",
                    notification_sound: "バックグラウンド完了の通知音",
                    notification_sound_desc: "バックグラウンドタスクが完了したときに通知音を再生します。",
                    shortcuts_title: "ショートカット",
                    shortcuts_description: "キーボードショートカットを設定します。",
                    shortcut_new_chat: "新規チャット",
                    shortcut_new_chat_desc: "新しいチャットを開始するキーボードショートカット。",
                    shortcut_custom: "追加のショートカット",
                    shortcut_custom_desc: "アクション=キーバインドの形式で追加します (例: open_settings=Ctrl+,)。",
                    chunk_chars: "チャンクサイズ (文字数)",
                    chunk_chars_desc: "文字数ベースのチャンク分割サイズ。",
                    chunk_tokens: "チャンクサイズ (トークン)",
                    chunk_tokens_desc: "トークンベースのチャンク分割サイズ。",
                    chunk_overlap: "チャンクオーバーラップ",
                    chunk_overlap_desc: "チャンク間の重複サイズ。",
                    export_format: "バックアップ出力フォーマット",
                    export_format_desc: "バックアップをエクスポートする際の形式。",
                    watch_folders: "監視フォルダ",
                    watch_folders_desc: "インデックス対象として監視するフォルダ。",
                    watch_folders_placeholder: "例: D:\\docs",
                    vector_store_dir: "ベクトルDB保存先ディレクトリ",
                    vector_store_dir_desc: "ベクトルデータベースのファイルを保存するパス。",
                    vector_store_dir_placeholder: "例: C:\\Tepora\\db",
                    model_files_dir: "モデルファイル保存先ディレクトリ",
                    model_files_dir_desc: "モデルバイナリの保存パス。",
                    model_files_dir_placeholder: "例: C:\\Tepora\\models",
                    backup_chat_history: "バックアップ: 会話履歴",
                    backup_settings: "バックアップ: アプリ設定",
                    backup_characters: "バックアップ: キャラクター構成",
                    backup_executors: "バックアップ: プロフェッショナル構成",
                    restore_enabled: "バックアップの復元を有効にする",
                    character_import_export: "キャラクター機能のインポート/エクスポート",
                    executor_import_export: "プロフェッショナル機能のインポート/エクスポート",
                    cache_clear_on_start: "起動時にWebアクセスキャッシュをクリア",
                    cache_cleanup_embeddings: "古いエンベディングを整理する",
                    cache_cleanup_temp: "一時ファイルを整理する",
                    cache_limit_mb: "キャッシュ容量制限 (MB)",
                    storage_title: "データ管理とストレージ設定",
                    storage_description: "テキストチャンク、監視フォルダ、ストレージパス、バックアップ、キャッシュを構成します。",
                    performance_title: "システム統合とパフォーマンス",
                    performance_description: "OS起動時の動作、システムトレイ、ハードウェアアクセラレーション、リソース制限を管理します。",
                    auto_start: "OSログイン時に起動する",
                    tray_resident: "システムトレイでバックグラウンド実行を継続",
                    hardware_acceleration: "ハードウェアアクセラレーションを有効化",
                    gpu_vram_limit: "GPU VRAM 制限 (MB)",
                    memory_limit: "メモリ使用量制限 (MB)",
                    security_title: "セキュリティとネットワーク設定",
                    security_description: "ツール実行ポリシー、プロキシ、サーバー接続情報などを管理します。",
                    allowed_tools: "ネイティブツールの許可リスト",
                    allowed_tools_desc: "許可リストポリシー使用時の許可ツール名。",
                    denied_tools: "ネイティブツールの拒否リスト",
                    denied_tools_desc: "拒否リストポリシー使用時の禁止ツール名。",
                    tool_confirmation: "すべてのツール実行を確認",
                    first_use_confirmation: "初回実行時のみ確認",
                    dangerous_patterns: "ブロック対象のコマンドパターン",
                    dangerous_patterns_desc: "無条件でブロックするコマンドのパターン。",
                    proxy_http: "HTTPプロキシ",
                    proxy_http_desc: "HTTPリクエストのプコキシURL。",
                    proxy_https: "HTTPSプロキシ",
                    proxy_https_desc: "HTTPSリクエストのプロキシURL。",
                    custom_certificate: "カスタム証明書パス",
                    custom_certificate_desc: "カスタムのCA証明書バンドルのファイルパス。",
                    server_host: "サーバーホスト",
                    server_host_desc: "バックエンドサーバーのホストバインディング。",
                    allowed_origins: "許可オリジン (CORS/WS共通)",
                    allowed_origins_desc: "バックエンドへのアクセスを許可するオリジン。",
                    cors_origins: "HTTP (CORS) 許可オリジン",
                    cors_origins_desc: "CORSポリシーによるアクセス許可オリジン。",
                    ws_origins: "WebSocket 許可オリジン",
                    ws_origins_desc: "WebSocket接続を許可するオリジン。",
                    models_title: "モデルとLLMの拡張設定",
                    models_description: "標準設定画面に含まれないモデルの既定値や詳細メタデータを設定します。",
                    character_default_model: "キャラクター用既定モデルの設定キー",
                    supervisor_default_model: "スーパーバイザー/プランナー用既定モデル",
                    executor_default_model: "プロフェッショナル用既定モデルの設定キー",
                    logprobs: "Logprobsを有効にする",
                    logprobs_desc: "トークンレベルの対数確率をサポートしている場合出力します。",
                    system_prompt_prefix: "システムプロンプト (プレフィックス)",
                    system_prompt_prefix_desc: "すべてのシステムプロンプトの先頭に追加されるテキスト。",
                    system_prompt_suffix: "システムプロンプト (サフィックス)",
                    system_prompt_suffix_desc: "すべてのシステムプロンプトの末尾に追加されるテキスト。",
                    loader_specific_text: "テキストローダー固有の設定 (JSON)",
                    loader_specific_text_desc: "テキストモデルのシリアライズされたローダーごとの詳細設定。",
                    loader_specific_embedding: "埋め込みモデルローダー固有の設定 (JSON)",
                    loader_specific_embedding_desc: "埋め込みモデルのシリアライズされたローダーごとの詳細設定。"
                }
            },
            mcp: {
                policy: {
                    title: "ツールのセキュリティポリシー",
                    mode: {
                        label: "ポリシーモード",
                        description: "MCPサーバーのツール実行権限を指定します。",
                        local_only: "ローカルのみ",
                        stdio_only: "Stdioのみ",
                        allowlist: "許可リスト方式"
                    },
                    confirmation: {
                        label: "実行の確認",
                        description: "ツール実行前に手動承認を要求します。"
                    },
                    first_use: {
                        label: "初回実行確認",
                        description: "セッション内の初回の呼び出し時にのみ確認を表示します。"
                    },
                    blocked_commands: {
                        label: "ブロックするコマンド",
                        description: "MCPサーバーがいかなる場合でも実行できないコマンド。",
                        placeholder: "例: rm -rf"
                    }
                }
            }
        }
    },
    es: {
        settings: {
            sections: {
                extended: {
                    ui_title: "Diseño de IU y Notificaciones",
                    ui_description: "Configura detalles de apariencia y notificaciones en segundo plano.",
                    font_family: "Tipo de Letra",
                    font_family_desc: "Tipo de letra de la IU para renderizado de texto principal.",
                    font_family_placeholder: "ej. Noto Sans",
                    font_size: "Tamaño de Fuente",
                    font_size_desc: "Tamaño base de fuente de IU en píxeles.",
                    code_theme: "Tema de Resaltado de Código",
                    code_theme_desc: "Tema de resaltado de sintaxis para bloques de código.",
                    code_theme_placeholder: "ej. github-dark",
                    thinking_max_tokens: "Tokens Máximos de Pensamiento",
                    thinking_max_tokens_desc: "Límite superior para el consumo de tokens de pensamiento.",
                    code_wrap: "Ajuste de Línea de Código",
                    code_wrap_desc: "Habilita el ajuste de línea en los bloques de código.",
                    code_line_numbers: "Números de Línea de Código",
                    code_line_numbers_desc: "Muestra números de línea en los bloques de código.",
                    notification_os: "Notificación del SO en Segundo Plano",
                    notification_os_desc: "Muestra una notificación del SO cuando finalizan las tareas en segundo plano.",
                    notification_sound: "Sonido de Notificación",
                    notification_sound_desc: "Reproduce un sonido cuando finalizan las tareas en segundo plano.",
                    shortcuts_title: "Atajos de Teclado",
                    shortcuts_description: "Configura atajos de teclado para acciones rápidas.",
                    shortcut_new_chat: "Nuevo Chat",
                    shortcut_new_chat_desc: "Atajo para comenzar un chat nuevo.",
                    shortcut_custom: "Atajos Personalizados",
                    shortcut_custom_desc: "Añade atajos con el formato accion=tecla (por ejemplo: open_settings=Ctrl+,).",
                    chunk_chars: "Caracteres de Fragmento",
                    chunk_chars_desc: "Tamaño de fragmentación de texto por caracteres.",
                    chunk_tokens: "Tokens de Fragmento",
                    chunk_tokens_desc: "Tamaño de fragmentación de texto por tokens.",
                    chunk_overlap: "Solapamiento de Fragmento",
                    chunk_overlap_desc: "Tamaño del solapamiento entre fragmentos consecutivos.",
                    export_format: "Formato de Exportación",
                    export_format_desc: "Formato preferido para las copias de seguridad.",
                    watch_folders: "Carpetas Supervisadas",
                    watch_folders_desc: "Carpetas supervisadas para el indexado de archivos.",
                    watch_folders_placeholder: "ej. D:\\docs",
                    vector_store_dir: "Directorio de Base de Vectores",
                    vector_store_dir_desc: "Directorio para guardar la base de vectores.",
                    vector_store_dir_placeholder: "ej. C:\\Tepora\\db",
                    model_files_dir: "Directorio de Modelos",
                    model_files_dir_desc: "Directorio para guardar archivos binarios de modelos.",
                    model_files_dir_placeholder: "ej. C:\\Tepora\\models",
                    backup_chat_history: "Respaldo: Historial de Chat",
                    backup_settings: "Respaldo: Ajustes",
                    backup_characters: "Respaldo: Personajes",
                    backup_executors: "Respaldo: Profesionales",
                    restore_enabled: "Activar Restauración",
                    character_import_export: "Importar/Exportar Personajes",
                    executor_import_export: "Importar/Exportar Profesionales",
                    cache_clear_on_start: "Limpiar Caché Web al Iniciar",
                    cache_cleanup_embeddings: "Limpiar Vectores Antiguos",
                    cache_cleanup_temp: "Limpiar Ficheros Temporales",
                    cache_limit_mb: "Límite de Capacidad Caché (MB)",
                    storage_title: "Manejo de Datos y Almacenamiento",
                    storage_description: "Configura fragmentación, carpetas, unidades y opciones de copia de seguridad.",
                    performance_title: "Integración del Sistema",
                    performance_description: "Controla inicio, proceso del sistema y límites de hardware.",
                    auto_start: "Inicio Automático con Windows",
                    tray_resident: "Minimizar en la Bandeja del Sistema",
                    hardware_acceleration: "Aceleración de Hardware",
                    gpu_vram_limit: "Límite de GPU VRAM (MB)",
                    memory_limit: "Límite de RAM (MB)",
                    security_title: "Seguridad de Red y Conexiones",
                    security_description: "Configura uso de proxy, certificados, orígenes de sistema web y recursos MCP.",
                    allowed_tools: "Herramientas de Confianza (Lista Blanca)",
                    allowed_tools_desc: "Lista de herramientas permitidas que pueden ejecutarse con seguridad.",
                    denied_tools: "Herramientas Inseguras (Lista Negra)",
                    denied_tools_desc: "Lista de herramientas nunca permitidas.",
                    tool_confirmation: "Confirmar Acciones",
                    first_use_confirmation: "Confirmar Nuevo Uso de Herramienta",
                    dangerous_patterns: "Comandos Prohibidos",
                    dangerous_patterns_desc: "Comandos a nivel sistema terminantemente bloqueados.",
                    proxy_http: "HTTP Proxy",
                    proxy_http_desc: "Enlace Proxy HTTP.",
                    proxy_https: "HTTPS Proxy",
                    proxy_https_desc: "Enlace Proxy HTTPS.",
                    custom_certificate: "Cerficificado Personal",
                    custom_certificate_desc: "Verificación manual para conexiones locales.",
                    server_host: "Host local",
                    server_host_desc: "Red predeterminada de backend.",
                    allowed_origins: "Dominios Globales Permitidos",
                    allowed_origins_desc: "Configuración global de subred.",
                    cors_origins: "Permiso CORS",
                    cors_origins_desc: "Reglas de control de acceso HTTP de recursos cruzados.",
                    ws_origins: "Ruta del WebSocket",
                    ws_origins_desc: "Red predeterminada de WebSockets locales y orígenes.",
                    models_title: "Modelos Especiales/Avanzados",
                    models_description: "Herramientas alternativas de modelos experimentales y uso superior en IA local.",
                    character_default_model: "Modelo de Personajes",
                    supervisor_default_model: "Modelo de Supervisores",
                    executor_default_model: "Modelo de Ejecutor",
                    logprobs: "Logaritmo Probabilidad de Semántica (Logprobs)",
                    logprobs_desc: "Herramientas probablístas a nivel texto LLMs.",
                    system_prompt_prefix: "Reglas Iniciales",
                    system_prompt_prefix_desc: "Comando agregado del comportamiento universal (Inicio).",
                    system_prompt_suffix: "Reglas Finales",
                    system_prompt_suffix_desc: "Comando agregado del comportamiento universal (Final).",
                    loader_specific_text: "Información Técnica (Texto)",
                    loader_specific_text_desc: "Codificación JSON interna extra.",
                    loader_specific_embedding: "Información Técnica (Vectores)",
                    loader_specific_embedding_desc: "Codificación JSON interna extra."
                }
            },
            mcp: {
                policy: {
                    title: "Regulaciones y Seguridad",
                    mode: {
                        label: "Acceso y Restricción",
                        description: "Habilitación profunda.",
                        local_only: "Modo Local",
                        stdio_only: "Stdio Unicamente",
                        allowlist: "Modificación de Lista Blanca"
                    },
                    confirmation: {
                        label: "Acción Previa",
                        description: "El sistema no ejecutará sin un aval."
                    },
                    first_use: {
                        label: "Acceso Previo del Ejecutor",
                        description: "El sistema pedira información cuando instale las operaciones unicamente."
                    },
                    blocked_commands: {
                        label: "Bases Negadas",
                        description: "Evitar estas funciones destructivas.",
                        placeholder: "ej. rd /S /Q"
                    }
                }
            }
        }
    },
    zh: {
        settings: {
            sections: {
                extended: {
                    ui_title: "用户界面与通知",
                    ui_description: "配置外观细节和后台通知。",
                    font_family: "字体",
                    font_family_desc: "主要文本渲染的界面字体。",
                    font_family_placeholder: "例: Noto Sans",
                    font_size: "字体大小",
                    font_size_desc: "基础界面字体大小 (像素)。",
                    code_theme: "代码高亮主题",
                    code_theme_desc: "代码块的语法高亮主题。",
                    code_theme_placeholder: "例: github-dark",
                    thinking_max_tokens: "最大思考代币",
                    thinking_max_tokens_desc: "思考代币消耗的上限。",
                    code_wrap: "代码换行",
                    code_wrap_desc: "为代码块启用自动换行。",
                    code_line_numbers: "代码块行号",
                    code_line_numbers_desc: "在代码块中显示行号。",
                    notification_os: "后台任务系统通知",
                    notification_os_desc: "完成后台任务时显示系统通知。",
                    notification_sound: "后台任务声音",
                    notification_sound_desc: "后台任务完成时播放提示音。",
                    shortcuts_title: "快捷键",
                    shortcuts_description: "配置快速操作的键盘快捷键。",
                    shortcut_new_chat: "新建对话",
                    shortcut_new_chat_desc: "启动新对话的键盘快捷键。",
                    shortcut_custom: "附加快捷键",
                    shortcut_custom_desc: "通过配置 action=keybinding 添加快捷键 (例如: open_settings=Ctrl+,)。",
                    chunk_chars: "分块大小 (字符)",
                    chunk_chars_desc: "按字符计数索引文本时的分块大小。",
                    chunk_tokens: "分块大小 (Token)",
                    chunk_tokens_desc: "按令牌数索引文本时的分块大小。",
                    chunk_overlap: "分块重叠",
                    chunk_overlap_desc: "连续分块之间的重叠大小。",
                    export_format: "备份导出格式",
                    export_format_desc: "备份导出的首选格式。",
                    watch_folders: "监视文件夹",
                    watch_folders_desc: "监视索引目标的文件夹。",
                    watch_folders_placeholder: "例: D:\\docs",
                    vector_store_dir: "向量存储目录",
                    vector_store_dir_desc: "向量数据库文件的存储路径。",
                    vector_store_dir_placeholder: "例: C:\\Tepora\\db",
                    model_files_dir: "模型文件加载路径",
                    model_files_dir_desc: "模型文件的存储路径。",
                    model_files_dir_placeholder: "例: C:\\Tepora\\models",
                    backup_chat_history: "文件备份: 聊天记录",
                    backup_settings: "文件备份: 用户偏好",
                    backup_characters: "文件备份: 自定义角色",
                    backup_executors: "文件备份: 自定义任务",
                    restore_enabled: "安全备份与覆盖",
                    character_import_export: "角色批量系统加载",
                    executor_import_export: "任务批量管理操作",
                    cache_clear_on_start: "默认重置环境配置",
                    cache_cleanup_embeddings: "废旧逻辑删除",
                    cache_cleanup_temp: "空无文档清洗",
                    cache_limit_mb: "限制使用空间 (MB)",
                    storage_title: "文件目录与存储扩展",
                    storage_description: "调整碎片大小与内容索引方案与模型基础参数",
                    performance_title: "网络响应与资源保护",
                    performance_description: "控制系统加载等操作",
                    auto_start: "开启应用程序随系统启动的功能。",
                    tray_resident: "启动时关闭托盘控制台，作为后台服务执行。",
                    hardware_acceleration: "硬件辅助",
                    gpu_vram_limit: "限制显卡",
                    memory_limit: "限制内存资源使用率",
                    security_title: "应用和服务器接口控制",
                    security_description: "管理环境下的黑白名单和基础使用参数访问资源设置",
                    allowed_tools: "允许功能池 (列表白名单)",
                    allowed_tools_desc: "工具管理参数的使用方案白名单认证。",
                    denied_tools: "风险屏蔽池 (管理黑名单)",
                    denied_tools_desc: "黑名单保护体系。",
                    tool_confirmation: "请求外部认证",
                    first_use_confirmation: "工具确认规则设置",
                    dangerous_patterns: "命令规则限制",
                    dangerous_patterns_desc: "保护服务器命令。",
                    proxy_http: "系统代理配置",
                    proxy_http_desc: "设置本地使用的反向应用控制.",
                    proxy_https: "访问安全通道",
                    proxy_https_desc: "提供SSL资源共享下载等使用的安全设置网络.",
                    custom_certificate: "受保护资源证明地址",
                    custom_certificate_desc: "安全配置。",
                    server_host: "网络分配端口",
                    server_host_desc: "限制后端访问来源。",
                    allowed_origins: "连接外部允许服务",
                    allowed_origins_desc: "控制跨站点权限。",
                    cors_origins: "网络配置协议限制跨源共享使用",
                    cors_origins_desc: "允许其他网络来源使用当前接口。",
                    ws_origins: "交互端口代理白名单协议。",
                    ws_origins_desc: "安全保障策略。",
                    models_title: "深度大模型核心数据",
                    models_description: "管理控制大模型的特定工作系统，需要有一定的技术能力",
                    character_default_model: "角色应用系统",
                    supervisor_default_model: "规划与管理",
                    executor_default_model: "特定工作负载使用",
                    logprobs: "允许系统进行模型对数分布概率生成方案。",
                    logprobs_desc: "需要有大模型后端本身支持开启这种环境。",
                    system_prompt_prefix: "覆盖前端统一角色身份限定前置预设配置。",
                    system_prompt_prefix_desc: "控制角色逻辑与设定使用环境前置保护",
                    system_prompt_suffix: "角色约束强制重定位与规范性收尾限定控制处理。",
                    system_prompt_suffix_desc: "防止格式混乱使用后置修正方案",
                    loader_specific_text: "大语言模型生成负载使用特定属性参数JSON表",
                    loader_specific_text_desc: "用于解决如rope编码错误或模型特定的技术负载处理",
                    loader_specific_embedding: "理解向量映射重构使用技术分配参数模型表",
                    loader_specific_embedding_desc: "控制嵌入长度重叠和环境使用方案"
                }
            },
            mcp: {
                policy: {
                    title: "安全扩展验证中心",
                    mode: {
                        label: "限制环境",
                        description: "使用哪种管理保护。",
                        local_only: "保护环境运行",
                        stdio_only: "直接访问 (Stdio)",
                        allowlist: "白名单准入"
                    },
                    confirmation: {
                        label: "是否每次允许时触发许可?",
                        description: "每次执行将保护使用情况。"
                    },
                    first_use: {
                        label: "初次使用校验身份?",
                        description: "只提醒一次应用。"
                    },
                    blocked_commands: {
                        label: "禁止服务执行",
                        description: "黑名单使用方案保护电脑资料不被篡改.",
                        placeholder: "例. rd /S /Q"
                    }
                }
            }
        }
    }
};

function ensureNestedObject(obj, sourceObj) {
    for (const key in sourceObj) {
        if (typeof sourceObj[key] === 'object' && sourceObj[key] !== null) {
            if (!obj[key]) {
                obj[key] = {};
            }
            ensureNestedObject(obj[key], sourceObj[key]);
        } else {
            if (obj[key] === undefined) {
                obj[key] = sourceObj[key];
            }
        }
    }
}

for (const locale of localesDirs) {
    const absolutePath = path.resolve(__dirname, locale.path);
    let data = {};
    try {
        const raw = fs.readFileSync(absolutePath, 'utf8');
        data = JSON.parse(raw);

        const missingData = newTranslations[locale.code];
        ensureNestedObject(data, missingData);

        fs.writeFileSync(absolutePath, JSON.stringify(data, null, '\t') + '\n', 'utf8');
        console.log(`Updated ${locale.code} translation file at ${absolutePath}`);
    } catch (e) {
        console.error(`Failed to update ${locale.code} file:`, e);
    }
}
console.log('Done!');
