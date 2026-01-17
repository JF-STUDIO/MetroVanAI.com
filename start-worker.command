#!/bin/zsh
cd /Users/macbook/Documents/网站制作/metrovan-ai---ai-photography-studio/server
pnpm run build
node dist/worker.js
