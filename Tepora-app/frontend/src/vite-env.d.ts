/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_CHUNK_FLUSH_INTERVAL: string;
    readonly VITE_CHUNK_FLUSH_INTERVAL_MIN: string;
    readonly VITE_CHUNK_FLUSH_INTERVAL_MAX: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
