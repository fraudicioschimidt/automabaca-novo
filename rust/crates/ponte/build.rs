fn main() {
    // O setup do napi só vale para o binário N-API; o WebAssembly não o usa.
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32") {
        napi_build::setup();
    }
}
