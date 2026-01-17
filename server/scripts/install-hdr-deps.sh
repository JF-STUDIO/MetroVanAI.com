#!/usr/bin/env bash
set -euo pipefail

if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt-get not available; HDR tools install skipped" >&2
  exit 1
fi

SUDO=""
if command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

$SUDO apt-get update -y
$SUDO apt-get install -y --no-install-recommends \
  hugin-tools \
  enblend \
  dcraw \
  imagemagick

