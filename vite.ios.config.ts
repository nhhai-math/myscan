import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  publicDir: 'public/ios-assets',
  build: {
    target: 'safari16.4',
    outDir: 'dist-ios',
    emptyOutDir: true,
    rollupOptions: { input: 'ios.html' },
    sourcemap: false,
  },
});
