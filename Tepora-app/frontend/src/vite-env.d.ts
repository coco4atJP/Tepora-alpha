/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_CHUNK_FLUSH_INTERVAL: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
