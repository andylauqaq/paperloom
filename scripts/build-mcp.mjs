/** 把 MCP 入口打包为独立文件，使用桌面程序自带的 Node 运行时。 */
import { build } from 'esbuild'

await build({
  entryPoints: ['desktop/mcp-entry.mjs'],
  outfile: 'dist-mcp/paperloom-mcp.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  banner: {
    js: "import { createRequire as createBundledRequire } from 'node:module'; const require = createBundledRequire(import.meta.url);",
  },
})
