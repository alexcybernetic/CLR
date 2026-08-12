# Third-party notices

CLR includes or adapts third-party software and assets. Those materials retain
their original licenses and copyright notices.

## CuBFF

- Source: <https://github.com/paradigms-of-intelligence/cubff>
- Pinned revision: `8e3f774df03d1c895ec6ee0d21b6897ecea46806`
- License: Apache License 2.0; see [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)
- Copyright: 2024 Google LLC

CLR's Apache-licensed CuBFF adaptations include
`engine/native/cubff_soup.c`, its generated `engine/src/cubff.wasm.ts`
artifact, and the CuBFF-derived WGSL implementation in
`engine/src/webgpu/shader.ts`.

## BrainFuckLife

- Source: <https://github.com/mathelehrer/BrainFuckLife>
- Pinned fork: <https://github.com/alexcybernetic/BrainFuckLife/tree/9d2638361a0ae5519dfe56539059cfec094cbd6e>
- License: GNU General Public License v3.0 or later; see [`LICENSE`](LICENSE)
- Author: Johannes Martin and the BrainFuckLife contributors

CLR's adaptation is `engine/native/brainfuck_life_soup.c`; its generated
artifact is `engine/src/brainfuckLife.wasm.ts`.

## React

- Source: <https://github.com/facebook/react>
- Packages: `react` 19.2.8, `react-dom` 19.2.8, and `scheduler` 0.27.0
- License: MIT; see [`LICENSES/MIT-React.txt`](LICENSES/MIT-React.txt)
- Copyright: Meta Platforms, Inc. and affiliates

## Brotli

- Source: <https://github.com/google/brotli>
- Version: 1.1.0
- License: MIT; see [`engine/native/vendor/brotli/LICENSE`](engine/native/vendor/brotli/LICENSE)
- Copyright: the Brotli Authors

## Bootstrap Icons

- Source: <https://github.com/twbs/icons>
- License: MIT; see [`LICENSES/MIT-Bootstrap-Icons.txt`](LICENSES/MIT-Bootstrap-Icons.txt)
- Copyright: 2019–2024 The Bootstrap Authors

The Bluesky, Discord, GitHub, X, and YouTube SVGs in `appweb/public/` are
Bootstrap Icons. The brand names and logos may also be protected by their
respective trademark owners; their inclusion does not imply endorsement.

## Geist Mono

- Source: <https://github.com/vercel/geist-font>
- License: SIL Open Font License 1.1; see [`appweb/public/fonts/LICENSE.txt`](appweb/public/fonts/LICENSE.txt)
- Copyright: 2023 Vercel, in collaboration with basement.studio
