# Brotli encoder source

This directory contains the Brotli 1.1.0 encoder source required for CLR's
population-order measurement. It is pinned to upstream commit
[`ed738e842d2fbdf2d6459e39267a633c4a9b2f5d`](https://github.com/google/brotli/tree/ed738e842d2fbdf2d6459e39267a633c4a9b2f5d).

Only the public headers, common sources, and encoder sources are included. The
source is compiled to a separate Wasm module and run at quality 2, matching the
compressor and setting specified by the computational-life paper. The upstream
Apache 2.0 license is retained in [`LICENSE`](LICENSE).
