import { compile } from "./lib/compile.ts";

try {
    compile();
    console.log("SweetDX: build succeeded.");
} catch (e) {
    // compile() has already rolled back everything it created.
    // Never delete user folders here.
    console.error(`SweetDX: build failed.\n${e instanceof Error ? e.message : String(e)}`);
    console.error("See debug.log for the full details (compiler output, hooks, patches).");
    Deno.exit(1);
}
