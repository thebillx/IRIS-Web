import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const runtimeUrl = process.env.IRIS_RUNTIME_URL ?? 'http://127.0.0.1:43110';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/health': runtimeUrl,
      '/doctor': runtimeUrl,
      '/status': runtimeUrl,
      '/projects': runtimeUrl,
      '/sessions': runtimeUrl,
      '/missions': runtimeUrl,
      '/permissions': runtimeUrl,
      '/approvals': runtimeUrl,
      '/capabilities': runtimeUrl,
      '/mcp': runtimeUrl,
    },
  },
});
