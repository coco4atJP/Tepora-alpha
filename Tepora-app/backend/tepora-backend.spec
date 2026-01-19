# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules

hiddenimports = ['uvicorn.logging', 'uvicorn.loops', 'uvicorn.loops.auto', 'uvicorn.protocols', 'uvicorn.protocols.http', 'uvicorn.protocols.http.auto', 'uvicorn.protocols.websockets', 'uvicorn.protocols.websockets.auto', 'uvicorn.lifespan.on', 'sqlite3', 'tiktoken_ext.openai_public', 'tiktoken_ext', 'huggingface_hub', 'pydantic', 'pydantic_core', 'chromadb', 'chromadb.config', 'httpx', 'httpcore', 'psutil', 'langchain_openai', 'langchain_text_splitters']
hiddenimports += collect_submodules('langchain_core')
hiddenimports += collect_submodules('chromadb')


a = Analysis(
    ['/app/Tepora-app/backend/server.py'],
    pathex=['/app/Tepora-app/backend'],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['torch', 'torchvision', 'torchaudio', 'transformers', 'sentence_transformers', 'nvidia', 'triton', 'sympy'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='tepora-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
