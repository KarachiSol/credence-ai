#!/usr/bin/env bash
# Builds Colibri's engines on this machine and packs them for the Linux app.
#
# Colibri's own Linux release is built on the newest Ubuntu, so its engines need a
# newer glibc than many users have ("GLIBC_2.43 not found"). CI runs this on
# Ubuntu 22.04 (glibc 2.35): the engines then run on 22.04 and anything newer.
# The app unpacks this archive over the official release (src-tauri/src/colibri_setup.rs).
#
# Needs: git, make, gcc, curl, libvulkan-dev. Ubuntu 22.04 has no glslc, so the
# shaders (SPIR-V, the same on every system) are taken from the official release
# of the same version instead of being compiled here.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tag="$(tr -d '[:space:]' < "$root/colibri-version.txt")"
out="$root/src-tauri/resources/colibri-engines-linux.tar.gz"
work="${RUNNER_TEMP:-/tmp}/colibri-engines-build"
make_args=(ARCH=x86-64-v3 VK=1)
# The engines Credence's model catalog needs; a failure here fails the build.
required=" qwen36 qwen38 olmoe colibri "

rm -rf "$work"
git clone --quiet --depth 1 --branch "$tag" https://github.com/JustVugg/colibri "$work/src"

# The official shaders, and a stand-in glslc that hands them to make.
mkdir -p "$work/official"
curl -fsSL "https://github.com/JustVugg/colibri/releases/download/$tag/colibri-$tag-linux-x86_64.tar.gz" \
  | tar -xz -C "$work/official" ./shaders 2>/dev/null \
  || curl -fsSL "https://github.com/JustVugg/colibri/releases/download/$tag/colibri-$tag-linux-x86_64.tar.gz" \
  | tar -xz -C "$work/official" shaders
cat > "$work/glslc" <<GLSLC
#!/usr/bin/env bash
# make calls: glslc [flags] <source> -o shaders/<name>.spv
while [ \$# -gt 0 ]; do
  if [ "\$1" = "-o" ]; then out="\$2"; shift; fi
  shift
done
src="$work/official/shaders/\$(basename "\$out")"
[ -f "\$src" ] || { echo "no official shader for \$out" >&2; exit 1; }
cp "\$src" "\$out"
GLSLC
chmod +x "$work/glslc"
make_args+=(GLSLC="$work/glslc")

cd "$work/src/c"
stage="$work/stage"
mkdir -p "$stage"

for t in colibri glm53 inkling kimi_k3 olmoe qwen36 qwen38 deepseek_v41 mimo qwenimage laya gliner_decide; do
  if make -j"$(nproc)" "$t" "${make_args[@]}"; then
    cp "$t" "$stage/"
  elif [[ "$required" == *" $t "* ]]; then
    echo "::error::Colibri engine $t did not build"; exit 1
  else
    echo "::warning::Colibri engine $t did not build; the official one stays in place"
  fi
done
if make -j"$(nproc)" deepseek-v4 "${make_args[@]}"; then
  cp deepseek_v4 "$stage/"
else
  echo "::warning::Colibri engine deepseek_v4 did not build; the official one stays in place"
fi
# Shaders are not packed: the official release already has the same ones.

# Show the newest glibc symbol each engine needs.
for f in "$stage"/*; do
  [ -f "$f" ] || continue
  need="$(objdump -T "$f" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)"
  echo "$(basename "$f"): $need"
done

mkdir -p "$(dirname "$out")"
tar -czf "$out" -C "$stage" .
ls -lh "$out"
