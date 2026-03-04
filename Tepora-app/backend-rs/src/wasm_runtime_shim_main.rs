#[cfg(feature = "redesign_sandbox")]
mod enabled {
    use std::env;
    use std::path::PathBuf;

    use wasmtime::{Engine, Linker, Module, Store};
    use wasmtime_wasi::preview1::{self, WasiP1Ctx};
    use wasmtime_wasi::WasiCtxBuilder;

    pub fn run() -> Result<(), String> {
        let (module_path, module_args) = parse_args()?;
        execute_module(&module_path, &module_args)
    }

    fn parse_args() -> Result<(PathBuf, Vec<String>), String> {
        let mut args: Vec<String> = env::args().skip(1).collect();
        if args.is_empty() {
            return Err("usage: wasm_runtime_shim run <module.wasm> [-- <args...>]".to_string());
        }

        if args[0] == "run" {
            if args.len() < 2 {
                return Err("missing wasm module path".to_string());
            }
            let module = PathBuf::from(args[1].clone());
            let app_args = if let Some(idx) = args.iter().position(|a| a == "--") {
                args.drain((idx + 1)..).collect::<Vec<_>>()
            } else if args.len() > 2 {
                args.drain(2..).collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            Ok((module, app_args))
        } else {
            let module = PathBuf::from(args[0].clone());
            let app_args = if args.len() > 1 {
                args.drain(1..).collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            Ok((module, app_args))
        }
    }

    fn execute_module(module_path: &PathBuf, module_args: &[String]) -> Result<(), String> {
        let mut engine_config = wasmtime::Config::new();
        engine_config.max_wasm_stack(1024 * 512);
        engine_config.wasm_memory64(false);
        let engine = Engine::new(&engine_config)
            .map_err(|e| format!("failed to initialize Wasm engine: {e}"))?;

        let module = Module::from_file(&engine, module_path).map_err(|e| {
            format!(
                "failed to load wasm module '{}': {e}",
                module_path.display()
            )
        })?;

        let mut linker = Linker::<WasiP1Ctx>::new(&engine);
        preview1::add_to_linker_sync(&mut linker, |ctx| ctx)
            .map_err(|e| format!("failed to configure WASI linker: {e}"))?;

        let mut wasi_builder = WasiCtxBuilder::new();
        wasi_builder
            .inherit_stdin()
            .inherit_stdout()
            .inherit_stderr();

        let mut argv = vec![module_path.to_string_lossy().to_string()];
        argv.extend(module_args.iter().cloned());
        wasi_builder.args(&argv);

        let mut store = Store::new(&engine, wasi_builder.build_p1());
        let instance = linker
            .instantiate(&mut store, &module)
            .map_err(|e| format!("failed to instantiate wasm module: {e}"))?;

        if let Some(start) = instance.get_func(&mut store, "_start") {
            start
                .call(&mut store, &[], &mut [])
                .map_err(|e| format!("wasm _start failed: {e}"))?;
            return Ok(());
        }

        let main = instance
            .get_typed_func::<(), ()>(&mut store, "main")
            .map_err(|e| format!("failed to get main export: {e}"))?;
        main.call(&mut store, ())
            .map_err(|e| format!("wasm main failed: {e}"))?;
        Ok(())
    }
}

#[cfg(feature = "redesign_sandbox")]
fn main() {
    if let Err(err) = enabled::run() {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

#[cfg(not(feature = "redesign_sandbox"))]
fn main() {
    eprintln!("wasm_runtime_shim requires '--features redesign_sandbox'");
    std::process::exit(1);
}
