import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default [
    {
        ignores: [
            '**/dist/',
            '**/coverage/',
            '**/test-results/',
            'packages/test-app/assets/',
        ],
    },
    js.configs.recommended,
    prettier,
    // All Node.js packages (everything except dappfence core source)
    {
        files: ['packages/**/*.js'],
        ignores: ['packages/dappfence/src/**/*.js'],
        languageOptions: {
            globals: globals.node,
        },
        rules: {
            'no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
        },
    },
    // Playwright e2e tests (TypeScript)
    ...tseslint.configs.recommended.map((config) => ({
        ...config,
        files: ['packages/test-app/**/*.ts'],
    })),
    {
        files: ['packages/test-app/**/*.ts'],
        languageOptions: {
            globals: globals.node,
        },
        rules: {
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                },
            ],
            'no-console': 'off',
        },
    },
    // Main source (browser + service worker)
    {
        files: ['packages/dappfence/src/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.serviceworker,

                // Vite injected globals
                __VERSION__: 'readonly',
                __BUILD_DATE__: 'readonly',
                __DEV__: 'readonly',
                __FEATURES__: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            'no-console': 'off',
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
];
