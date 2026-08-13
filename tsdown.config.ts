/**
 * tsdown build for dsh-usage-widget:
 * - lib/index.js  — host half (node ESM). Only node builtins + local code at
 *   runtime; every DSH service (webServer / sessionQuery / sessionPersistence
 *   / timer) is injected by cordis, never imported.
 * - lib/client.js — browser client bundle (CJS closure factory) registered
 *   with the package-name id `dsh-usage-widget` through
 *   window.__ModuleLoader__.load({ id, factory }).
 *
 * Client externals replicate the official CLIENT_EXTERNALS list of
 * dsh-better-sidebar / the PLATFORM_MODULES seed of the web shell; this
 * bundle only requires 'react' at runtime, everything else is inlined.
 */
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-usage-widget'

/** Module specifiers the web shell shares into the frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
] satisfies UserConfig[]
