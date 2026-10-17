import { compile } from "./lib/compile.ts";

const OUT = "./atmosphere";
const STASH = "./.atmosphere.sweetdx-stash";

const exists = (p: string) => {
  try { Deno.statSync(p); return true; }
  catch (e) { if (e instanceof Deno.errors.NotFound) return false; throw e; }
};
const rm = (p: string) => { if (exists(p)) Deno.removeSync(p, { recursive: true }); };

let stashed = false;

function restore() {
  rm(OUT);                                  // only ever this run's partial output
  if (stashed || exists(STASH)) {
    Deno.renameSync(STASH, OUT);            // put the user's original back
    stashed = false;
  }
}

// A previous run was killed mid-compile: recover the user's original first.
if (exists(STASH)) {
  console.warn("Recovering atmosphere folder from an interrupted build...");
  restore();
}

if (exists(OUT)) {
  Deno.renameSync(OUT, STASH);
  stashed = true;
}

const onSigint = () => { restore(); Deno.exit(130); };
Deno.addSignalListener("SIGINT", onSigint);

try {
  await compile();                          // fine whether compile is sync or async
  rm(STASH);                                // success: old output is replaced
  stashed = false;
  console.log("Build succeeded.");
} catch (e) {
  restore();
  console.error("Build failed:", e instanceof Error ? (e.stack ?? e.message) : e);
  Deno.exit(1);
} finally {
  Deno.removeSignalListener("SIGINT", onSigint);
}
