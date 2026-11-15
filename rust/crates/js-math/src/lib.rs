//! As funções do `Math` do JavaScript que o IEEE 754 não fixa até o último
//! bit. O domínio em TypeScript usava as do V8; portado, ele tem de dar o
//! mesmo número no servidor (N-API) e no navegador (WebAssembly).
//!
//! - No servidor, `f64::powf` chama o `pow` da glibc, que bateu com o
//!   `Math.pow` do V8 em todas as amostras medidas (1 milhão de `p^(1/n)`).
//!   O crate `libm`, a alternativa pura em Rust, divergia em 10% delas.
//! - No navegador, o WebAssembly importa o próprio `Math.pow`: o mesmo
//!   número que o TypeScript dava ali, em qualquer plataforma.
//!
//! `sqrt`, `floor`, `abs`, `min` e `max` são exatos pelo IEEE e ficam com o
//! `f64` do Rust.

#[cfg(target_arch = "wasm32")]
mod backend {
    use wasm_bindgen::prelude::wasm_bindgen;

    #[wasm_bindgen(js_namespace = Math)]
    extern "C" {
        pub fn pow(base: f64, exponent: f64) -> f64;
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod backend {
    pub fn pow(base: f64, exponent: f64) -> f64 {
        base.powf(exponent)
    }
}

/// `Math.pow(base, exponent)`.
pub fn pow(base: f64, exponent: f64) -> f64 {
    backend::pow(base, exponent)
}

#[cfg(test)]
mod tests {
    #[test]
    fn potencias_exatas() {
        assert_eq!(super::pow(2.0, 10.0), 1024.0);
        assert_eq!(super::pow(0.25, 0.5), 0.5);
        assert!(super::pow(-1.0, 0.5).is_nan());
    }
}
