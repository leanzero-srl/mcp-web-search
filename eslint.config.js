import js from '@eslint/js';
import typescript from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        // Node.js built-ins
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        Blob: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        FormData: 'readonly',
        ReadableStream: 'readonly',
        WritableStream: 'readonly',
        queueMicrotask: 'readonly',
        DOMException: 'readonly',
        navigator: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        performance: 'readonly',
        fetch: 'readonly',
        self: 'readonly',
        window: 'readonly',
        document: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        XMLHttpRequest: 'readonly',
        AbortSignal: 'readonly',
        crypto: 'readonly',
        globalThis: 'readonly',
        NodeJS: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
    },
    rules: {
      ...typescript.configs.recommended.rules,
      // Honor the `_`-prefix convention for intentionally-unused
      // variables (matches the project's existing _sessionId / _config
      // pattern).
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': 'warn',
      // Empty `catch {}` blocks are intentional in many places (best-effort
      // cleanup paths). Allow them; require a comment for any other empty
      // block.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
]; 