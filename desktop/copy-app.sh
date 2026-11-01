#!/usr/bin/env bash
# Copy the web app (the files the website serves) into desktop/app for the desktop build.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf desktop/app
mkdir -p desktop/app
cp -r app.html index.html video.html photo.html docs.html src styles vendor site desktop/app/
