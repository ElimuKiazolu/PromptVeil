import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'PromptVeil',
    version: '0.1.0',
    description:
      'Masks personal data in prompts to AI chatbots with realistic stand-ins and restores it in the replies. Runs entirely on your device.',
    permissions: ['storage', 'unlimitedStorage', 'offscreen'],
    host_permissions: [
      'https://chatgpt.com/*',
      'https://gemini.google.com/*',
      'https://claude.ai/*',
    ],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
