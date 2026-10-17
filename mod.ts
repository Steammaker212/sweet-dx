import { compile } from "./lib/compile.ts";

const HELP = `SweetDX - a sweeter way to mod New Super Mario Bros. U Deluxe

Usage: sweetdx [options]

Run from the folder that contains ./source (code, hooks, nso, symbols).

Options:
  -v, --verbose   Echo the full build log to the console (always saved to debug.log)
      --dry-run   Build and validate everything without writing into ./atmosphere
      --skip-build-id-check
                  Build even if source/nso/main is not the supported game version
  -h, --help      Show this help
`;

const KNOWN = new Set([ "-v", "--verbose", "--dry-run", "--skip-build-id-check", "-h", "--help" ]);
const unknown = Deno.args.filter(arg => !KNOWN.has(arg));

if (Deno.args.includes("-h") || Deno.args.includes("--help")) {
    console.log(HELP);
    Deno.exit(0);
}

if (unknown.length > 0) {
    console.error(`Unknown option(s): ${unknown.join(", ")}\n`);
    console.error(HELP);
    Deno.exit(2);
}

try {
    const summary = compile({
        verbose: Deno.args.includes("-v") || Deno.args.includes("--verbose"),
        dryRun: Deno.args.includes("--dry-run"),
        skipBuildIdCheck: Deno.args.includes("--skip-build-id-check")
    });

    for (const warning of summary.warnings) console.warn(`WARNING: ${warning}`);

    console.log(`SweetDX: build succeeded in ${summary.durationMs} ms${summary.deployed ? "" : " (dry run, nothing written)"}`);
    console.log(`  ${summary.sources} source file(s), ${summary.symbolFiles} symbol file(s), ${summary.hooks} hook(s), ${summary.trampolines} trampoline(s), ${summary.patches} patch(es)`);

    if (summary.deployed) {
        console.log(`  subsdk0 -> ${summary.subsdk0}`);
        console.log(`  ips     -> ${summary.ips}`);
        console.log("  Copy the atmosphere folder to the root of your SD card to install.");
    }
} catch (e) {
    // compile() has already rolled back everything it created.
    // Never delete user folders here.
    console.error(`SweetDX: build failed.\n\n${e instanceof Error ? e.message : String(e)}\n`);
    console.error("Full details were saved to debug.log (or run again with --verbose).");
    Deno.exit(1);
}
