/**
 * 构建期注入的插件版本号。
 *
 * `scripts/build.mjs` 用 esbuild 的 `define` 把 `package.json` 的 `version`
 * 编译进浏览器包；客户端因此不需要读文件，也不必为版本多打一次 Remote 调用。
 */
declare const __DBQA_VERSION__: string
