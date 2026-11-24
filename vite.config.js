import { defineConfig } from 'vite';

// GitHub Pages ではリポジトリ名のサブパスで配信されるため、相対パスで出力する
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 800,
  },
});
