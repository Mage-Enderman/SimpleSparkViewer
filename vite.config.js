import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    base: './',
    resolve: {
        alias: {
            '@sparkjsdev/spark': path.resolve(__dirname, 'spark'),
        },
    },
    optimizeDeps: {
        entries: ['index.html'], // Only scan index.html for dependencies
        exclude: ['@sparkjsdev/spark'] // Don't try to pre-optimize the local submodule
    },
    build: {
        rollupOptions: {
            input: {
                main: path.resolve(__dirname, 'index.html'),
            },
            output: {
                entryFileNames: `[name].js`,
                chunkFileNames: `[name].js`,
                assetFileNames: `[name].[ext]`
            }
        }
    }
});
