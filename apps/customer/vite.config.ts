import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, mergeConfig } from 'vite';
import { brandPlugin, sharedConfig } from '../../packages/ui-kit/src/vite-brand.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..');

export default mergeConfig(sharedConfig(repoRoot), defineConfig({
  plugins: [react(), brandPlugin(repoRoot, 'customer', '点单')],
}));
