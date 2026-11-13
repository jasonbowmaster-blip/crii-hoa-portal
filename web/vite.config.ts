import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// base './' so the demo build works from any path (e.g. a private preview).
export default defineConfig({ plugins: [react()], base: './' });
