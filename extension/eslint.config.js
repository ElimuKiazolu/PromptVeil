import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const htmlInjection = ['innerHTML', 'outerHTML', 'insertAdjacentHTML'].map(
  (property) => ({
    property,
    message: 'Host page content is changed through text nodes only.',
  }),
);

export default tseslint.config(
  {
    ignores: ['.output/**', '.wxt/**', 'coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  reactHooks.configs.flat.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        ...htmlInjection,
        {
          object: 'document',
          property: 'write',
          message: 'document.write is not allowed.',
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['chrome', 'browser', 'document', 'window', 'navigator'].map(
          (name) => ({
            name,
            message:
              'src/core is pure TypeScript and must not use browser APIs.',
          }),
        ),
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['wxt', 'wxt/*', '#imports'],
              message: 'src/core must not depend on WXT.',
            },
            {
              group: [
                '**/shared/messaging*',
                '**/shared/devlog*',
                '**/shared/extension-context*',
              ],
              message:
                'src/core may import only pure modules from src/shared (types and data).',
            },
          ],
        },
      ],
    },
  },
  {
    // The MAIN-world request net runs in the page's own world: no extension
    // APIs exist there, and it must not depend on the WXT runtime.
    files: ['src/net/**/*.ts', 'entrypoints/*-net.content.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['chrome', 'browser'].map((name) => ({
          name,
          message: 'MAIN-world code has no extension APIs.',
        })),
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['wxt', 'wxt/*', '#imports'],
              message: 'MAIN-world code must not depend on the WXT runtime.',
            },
          ],
        },
      ],
    },
  },
  {
    // Content scripts inject no CSS or fonts into host pages until the
    // in-page UI phase, which loads them inside its Shadow DOM.
    files: [
      'entrypoints/*.content.ts',
      'src/content/**/*.ts',
      'src/adapters/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*.css', '@fontsource/*'],
              message: 'Content scripts must not inject CSS or fonts.',
            },
          ],
        },
      ],
    },
  },
  {
    // The detector, phone metadata and packs load at run time as
    // detection.js, after document_start; content scripts may import only
    // their types (a value import would put them back into the start-up
    // script).
    files: ['entrypoints/*.content.ts', 'src/content/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/core/detect/bundle*',
                '**/core/detect/rules/**',
                '**/core/detect/validators/**',
                '**/core/draft/**',
                'libphonenumber-js',
                'libphonenumber-js/*',
              ],
              allowTypeImports: true,
              message:
                'Detection code loads at run time as detection.js; import its types only.',
            },
          ],
        },
      ],
    },
  },
  {
    // The dev logger is the only place in src/ that may write to the console.
    files: ['src/shared/devlog.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Adapters drive the page's own editor through the browser's native
    // editing command; there is no non-deprecated API that does this.
    files: ['src/adapters/**/*.ts'],
    rules: {
      '@typescript-eslint/no-deprecated': [
        'error',
        { allow: [{ from: 'lib', name: 'execCommand' }] },
      ],
    },
  },
  {
    files: ['scripts/**/*.ts', 'tests/**/*.ts', 'tests/**/*.tsx'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: false },
    },
  },
  prettier,
);
