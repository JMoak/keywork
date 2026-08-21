#!/bin/sh
# keywork installer for Linux and macOS.
#   curl -fsSL https://raw.githubusercontent.com/JMoak/keywork/main/scripts/install.sh | sh
# Honors KEYWORK_VERSION (a release tag such as v0.1.0; default: latest) and
# KEYWORK_INSTALL_DIR (default: ~/.local/bin). Verifies the SHA-256 before installing.
set -eu

repo="JMoak/keywork"
version="${KEYWORK_VERSION:-latest}"
install_dir="${KEYWORK_INSTALL_DIR:-$HOME/.local/bin}"

os=$(uname -s)
case "$os" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) echo "keywork: no release binary for $os; build from source (see README)" >&2; exit 1 ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch="x64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *) echo "keywork: no release binary for $arch; build from source (see README)" >&2; exit 1 ;;
esac

asset="keywork-$os-$arch"
if [ "$version" = "latest" ]; then
  base="https://github.com/$repo/releases/latest/download"
else
  base="https://github.com/$repo/releases/download/$version"
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

echo "downloading $asset ($version)"
curl -fsSL "$base/$asset" -o "$workdir/$asset"
curl -fsSL "$base/$asset.sha256" -o "$workdir/$asset.sha256"

if command -v sha256sum > /dev/null 2>&1; then
  (cd "$workdir" && sha256sum -c "$asset.sha256" > /dev/null)
elif command -v shasum > /dev/null 2>&1; then
  (cd "$workdir" && shasum -a 256 -c "$asset.sha256" > /dev/null)
else
  echo "keywork: neither sha256sum nor shasum is available to verify the download" >&2
  exit 1
fi
echo "checksum verified"

mkdir -p "$install_dir"
chmod +x "$workdir/$asset"
mv "$workdir/$asset" "$install_dir/keywork"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    echo ""
    echo "add $install_dir to your PATH, for example:"
    echo "  export PATH=\"$install_dir:\$PATH\""
    ;;
esac

echo ""
"$install_dir/keywork" --version
echo "installed to $install_dir/keywork · run: keywork"
