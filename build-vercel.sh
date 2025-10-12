#!/bin/bash
set -e

echo "Current directory: $(pwd)"
echo "Listing files:"
ls -la

echo "Changing to packages/frontend..."
cd packages/frontend

echo "Installing dependencies..."
npm install

echo "Building..."
npm run build

echo "Build complete!"
