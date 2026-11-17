#!/usr/bin/env bash
# Copy the web app (the files the website serves) into mobile/www for the Android build.
# The app starts at index.html, so the editor page takes that name here.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf mobile/www
mkdir -p mobile/www
cp -r app.html docs.html src styles vendor site mobile/www/
cp app.html mobile/www/index.html
