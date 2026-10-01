import { readFile } from "node:fs/promises";
import ts from "typescript";
/** Run the real TS modules in Node; only the unrelated SSR entry is substituted. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "vinext/server/app-router-entry") {
    return { url: "data:text/javascript,export default { fetch() { return new Response('SSR stub'); } }", shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
    try { return await nextResolve(`${specifier}.ts`, context); }
    catch { return nextResolve(`${specifier}.tsx`, context); }
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".tsx")) return nextLoad(url, context);
  const source = await readFile(new URL(url), "utf8");
  return { format: "module", shortCircuit: true, source: ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
}
