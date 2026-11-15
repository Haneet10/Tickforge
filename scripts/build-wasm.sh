#!/usr/bin/env bash
# Compile the C++ engine to WebAssembly.
#
# Uses zig's bundled clang and libc++ (pip install ziglang), which gives a
# reproducible toolchain with one command and no SDK to manage. The output is
# a standalone module with a plain C interface: no generated JavaScript glue.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/web/public/tickforge.wasm"
mkdir -p "$(dirname "$out")"

if command -v zig >/dev/null 2>&1; then
  zig_cxx=(zig c++)
else
  zig_cxx=(python3 -m ziglang c++)
fi

"${zig_cxx[@]}" \
  -target wasm32-wasi -mexec-model=reactor \
  -std=c++17 -O2 -DNDEBUG -fno-exceptions -fno-rtti \
  -Wall -Wextra \
  -I "$root/engine/include" \
  "$root/engine/src/order_book.cpp" \
  "$root/engine/src/market.cpp" \
  "$root/engine/src/agents.cpp" \
  "$root/engine/wasm/api.cpp" \
  -Wl,--strip-all \
  -o "$out"

echo "built $out ($(wc -c < "$out") bytes)"
