import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({plugins:[react()],resolve:{alias:{'@':fileURLToPath(new URL('./src',import.meta.url))}},build:{target:'es2022',rollupOptions:{output:{manualChunks:{three:['three']}}}},server:{host:'127.0.0.1',port:5199}});
