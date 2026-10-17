import * as constants from "./constants.ts"
import * as path from "node:path"
import * as modules from "../deps.ts"

class CompileLog {
    private readonly file: modules.archivo.Archivo;

    constructor(path: string, private readonly echo: boolean = false) {
        if (modules.archivo.existsAsFile(path)) {
            Deno.removeSync(path);
        }

        this.file = new modules.archivo.Archivo(path);
    }

    private write(level: "INFO" | "ERROR", message: string): void {
        const line = `[${new Date().toISOString()}] [${level}] ${message}`;

        this.file.appendText(line + "\n");
        if (this.echo) console.log(line);
    }

    info(message: string): void {
        this.write("INFO", message);
    }

    error(message: string): void {
        this.write("ERROR", message);
    }

    close(): void {
        this.file.close();
    }
}

export interface CompileOptions {
    /** Echo every log line to the console as well as debug.log. */
    verbose?: boolean;
    /** Build everything but do not write anything into ./atmosphere. */
    dryRun?: boolean;
}

export interface CompileSummary {
    sources: number;
    symbolFiles: number;
    hooks: number;
    trampolines: number;
    objects: number;
    patches: number;
    deployed: boolean;
    subsdk0: string;
    ips: string;
    warnings: string[];
    durationMs: number;
}

/** Detects IPS patches that touch the same bytes (the later one would silently win). */
class PatchLedger {
    private readonly entries: { start: number; end: number; data: Uint8Array; reason: string }[] = [];

    /** Returns a warning for a harmless exact duplicate, throws on a real conflict. */
    add(patch: { address: number; data: Uint8Array }, reason: string): string | null {
        const start = patch.address;
        const end = patch.address + patch.data.length;

        for (const other of this.entries) {
            if (start < other.end && other.start < end) {
                if (start === other.start && end === other.end && modules.utils.compareBuffers(patch.data, other.data)) {
                    return `Duplicate identical patch at ${modules.utils.hexify(start)}: ${reason} repeats ${other.reason}.`;
                }

                throw new Error(
                    `Conflicting patches: ${reason} (${modules.utils.hexify(start)}-${modules.utils.hexify(end)}) ` +
                    `overlaps ${other.reason} (${modules.utils.hexify(other.start)}-${modules.utils.hexify(other.end)}). ` +
                    `Two hooks cannot modify the same bytes.`
                );
            }
        }

        this.entries.push({ start, end, data: patch.data, reason });
        return null;
    }
}

const BACKUP_SUFFIX = ".sweetdx-bak";

function pathExists(p: string): boolean {
    try {
        Deno.lstatSync(p);
        return true;
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) return false;
        throw e;
    }
}

/**
 * Tracks everything a single compile run creates so that a failed run can be
 * undone WITHOUT touching anything it did not create (e.g. a pre-existing
 * "atmosphere" folder, other mods' files, or the last successful build).
 */
class OutputGuard {
    private readonly createdDirs: string[] = [];
    private readonly claimed: { file: string; backup: string | null }[] = [];

    /** mkdir -p that remembers which directories did not exist before. */
    mkdir(dir: string): void {
        const missing: string[] = [];
        let current = path.resolve(dir);

        while (!pathExists(current)) {
            missing.push(current); // deepest first
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }

        Deno.mkdirSync(dir, { recursive: true });
        this.createdDirs.push(...missing);
    }

    /** Reserve an output file. An existing file is moved aside as a backup. */
    claim(file: string): void {
        const backup = file + BACKUP_SUFFIX;

        // A backup left behind means a previous run was killed mid-build:
        // the backup is the user's real file, the current file is partial.
        if (pathExists(backup)) {
            if (pathExists(file)) Deno.removeSync(file);
            Deno.renameSync(backup, file);
        }

        if (pathExists(file)) {
            Deno.renameSync(file, backup);
            this.claimed.push({ file, backup });
        } else {
            this.claimed.push({ file, backup: null });
        }
    }

    /** Build succeeded: drop the backups of the files we replaced. */
    commit(): void {
        for (const { backup } of this.claimed) {
            try {
                if (backup && pathExists(backup)) Deno.removeSync(backup);
            } catch {
                // Leftover backup is harmless; it is recovered/replaced on the next run.
            }
        }
    }

    /** Build failed: remove our partial output, restore what was there before. */
    rollback(log: CompileLog): void {
        for (const { file, backup } of this.claimed) {
            try {
                if (pathExists(file)) Deno.removeSync(file);
                if (backup && pathExists(backup)) Deno.renameSync(backup, file);
            } catch (e) {
                log.error(`Rollback problem with "${file}": ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        // Only directories this run created, and only if they are empty.
        // Deepest first: a child always has a longer path than its parent, and
        // directories recorded by different mkdir() calls can share ancestors.
        for (const dir of [ ...this.createdDirs ].sort((a, b) => b.length - a.length)) {
            try {
                Deno.removeSync(dir);
            } catch {
                // Not empty or already gone: leave it alone.
            }
        }
    }
}

function requireTool(log: CompileLog, name: string, hint: string): void {
    const result = modules.child_process.spawnSync(name, [ "--version" ], { stdio: "pipe" });

    if (result.error || result.status !== 0) {
        throw new Error(`Required tool "${name}" was not found on your PATH. ${hint}`);
    }

    const firstLine = modules.utils.decode(result.stdout as Uint8Array).split(/\r?\n/)[0]?.trim();
    log.info(`Found ${name}: ${firstLine}`);
}

function checkSpawnResult(name: string, proc: { status: number | null; error?: Error; stderr?: Uint8Array | null }): void {
    if (proc.error) {
        throw new Error(`Failed to run "${name}": ${proc.error.message}`);
    }

    if (proc.status !== 0) {
        const stderr = proc.stderr ? modules.utils.decode(proc.stderr).trim() : "";
        const shown = stderr.length > 6000 ? stderr.slice(0, 6000) + "\n... (truncated, see debug.log)" : stderr;

        throw new Error(`"${name}" exited with a non-zero status code: ${proc.status}${shown ? `\n${shown}` : ""}`);
    }
}

function logProcessOutput(log: CompileLog, name: string, proc: { stdout: Uint8Array | null, stderr: Uint8Array | null }, args: string[]): void {
    const stdout = proc.stdout ? modules.utils.decode(proc.stdout).trim() : "";
    const stderr = proc.stderr ? modules.utils.decode(proc.stderr).trim() : "";

    log.info(`${name} arguments: ${args.map(arg => `"${arg}"`).join(" ")}`)
    log.info(`${name} exited.${stdout.length > 0 ? `\n--- stdout ---\n${stdout}` : ""}${stderr.length > 0 ? `\n--- stderr ---\n${stderr}` : ""}`);
}

export function compile(options: CompileOptions = {}): CompileSummary {
    const startedAt = performance.now();
    const log = new CompileLog("./debug.log", options.verbose ?? false);
    const guard = new OutputGuard();
    const ledger = new PatchLedger();
    const warnings: string[] = [];
    const summary: CompileSummary = {
        sources: 0, symbolFiles: 0, hooks: 0, trampolines: 0, objects: 0, patches: 0,
        deployed: false,
        subsdk0: constants.NSMBUDX_SUBSDK0_PATH,
        ips: constants.NSMBUDX_IPS_PATH,
        warnings,
        durationMs: 0
    };

    try {
        log.info("Checking source environment...");

        modules.archivo.checkEnviroment({
            root: modules.way.cwd(),

            folders: [ "./source/code", "./source/hooks", "./source/nso", "./source/symbols" ],
            files: [ "./source/nso/main" ],

            // NOTE: "available" means "must NOT already exist". ./atmosphere used to be
            // listed here, so any existing atmosphere folder failed the check and the
            // old catch block then deleted it. Output is now staged and deployed safely.
            available: {
                folders: [],
                files: []
            }
        });

        log.info("Checking required tools...");

        requireTool(log, "clang++", "Install LLVM/Clang and make sure clang++ is on your PATH.");
        requireTool(log, "arm-none-eabi-ld", "Install the Arm GNU Toolchain (arm-none-eabi) and make sure it is on your PATH.");

        log.info("Listing source files...");

        const files = modules.archivo.listFiles("./source");
        const code = files.filter(file => file.entry.extension === ".cpp" || file.entry.extension === ".s" || file.entry.extension === ".c");
        const main = new modules.filetendo.ParsedNSO("./source/nso/main");

        const symbols = files.filter(file => file.entry.extension === ".sym").map(symPath => {
            log.info(`Loading symbol file "${symPath.entry.path.normal}"...`);

            const sym = new modules.wisdom.Sym(symPath.entry.path.normal);

            log.info(`Loaded ${sym.symbols.length} symbol(s) from "${symPath.entry.path.normal}".`);
            log.info(sym.symbols.map(sym => sym.name).join(", "));

            return sym;
        });

        const hooks = files.filter(file => file.entry.extension === ".hks").map(hookPath => {
            log.info(`Loading hook file "${hookPath.entry.path.normal}"...`);

            const hks = new modules.wisdom.Hks(hookPath.entry.path.normal);

            log.info(`Loaded ${hks.hooks.length} hook definition(s) from "${hookPath.entry.path.normal}": ${hks.hooks.map(hook => hook.name).join(", ") || "(none)"}.`);
            log.info(JSON.stringify(hks.hooks, null, 4));

            return hks.hooks;
        }).flat();

        const ips = new modules.lunar.IPSPatch();

        const addPatch = (patch: { address: number, data: Uint8Array }, reason: string): void => {
            const warning = ledger.add(patch, reason);

            if (warning) {
                warnings.push(warning);
                log.info(`WARNING: ${warning}`);
                return;
            }

            ips.addPatch(patch);
            summary.patches++;
            log.info(`Added IPS patch at ${modules.utils.hexify(patch.address)} (${patch.data.length} byte(s)): ${reason}`);
            log.info(`IPS Patch at ${modules.utils.hexify(patch.address)} set to ${[ ...patch.data ].map(byte => modules.utils.hexify(byte, 2, true)).join(", ")}`);
        };

        log.info(`Found ${code.length} source file(s), ${symbols.length} symbol file(s) and ${hooks.length} hook definition(s).`);

        summary.sources = code.length;
        summary.symbolFiles = symbols.length;
        summary.hooks = hooks.length;

        if (code.length === 0) {
            throw new Error("No .cpp, .c or .s source files were found under \"./source\".");
        }

        const assets = {
            crt0: modules.way.join(import.meta.dirname!, "../assets/crt0.s"),
            linker: modules.way.join(import.meta.dirname!, "../assets/linker.ld"),
            sdk: modules.way.join(import.meta.dirname!, "../assets/sdk.ld"),
        }

        modules.utils.withTempDir((dirpath) => {
            const newAssets = {
                crt0: modules.way.join(dirpath, "./crt0.s"),
                linker: modules.way.join(dirpath, "./linker.ld"),
                sdk: modules.way.join(dirpath, "./sdk.ld")
            }

            let argv: string[] = [];

            Deno.copyFileSync(assets.crt0, newAssets.crt0);
            Deno.copyFileSync(assets.linker, newAssets.linker);
            Deno.copyFileSync(assets.sdk, newAssets.sdk);

            assets.crt0 = newAssets.crt0;
            assets.linker = newAssets.linker;
            assets.sdk = newAssets.sdk;

            log.info(`Working in temporary directory "${dirpath}".`);

            // Everything is built here first; ./atmosphere is only touched after a full success.
            const stageExefs = modules.way.join(dirpath, "./stage/exefs");
            const stagePatches = modules.way.join(dirpath, "./stage/patches");

            Deno.mkdirSync(stageExefs, { recursive: true });
            Deno.mkdirSync(stagePatches, { recursive: true });

            const stagedSubsdk0 = modules.way.join(stageExefs, "./subsdk0");
            const stagedIps = modules.way.join(stagePatches, `./${constants.NSMBUDX_BUILD_ID}.ips`);

            const asm = new modules.archivo.Archivo(modules.way.join(dirpath, "./hooks.s"));
            const linkers = [ "-T", assets.linker, "-T", assets.sdk ] as string[];
            const elfpath = modules.way.join(dirpath, "./subsdk0.elf");

            asm.appendText("\n");

            try {
            for (const hook of hooks) {
                log.info(`Processing hook "${hook.name}" (type: ${hook.type}, address: ${modules.utils.hexify(hook.address)}).`);

                switch (hook.type) {
                    case "hook": {
                        if (!hook.trampoline) break;

                        const originalInstruction = main.getSegment(".text").readAt(hook.address, 4);
                        const originalWord = (originalInstruction[0] | (originalInstruction[1] << 8) | (originalInstruction[2] << 16) | (originalInstruction[3] << 24)) >>> 0;

                        asm.appendText(
`.arm

.global ${hook.trampoline}
.type ${hook.trampoline}, %function
${hook.trampoline}:
    .inst ${modules.utils.hexify(originalWord)}
    .inst 0x00000000
.size ${hook.trampoline}, . - ${hook.trampoline}
`
                        )

                        break;
                    }
                    case "call": {
                        break;
                    }
                    case "instr": {
                        addPatch({
                            address: hook.address + constants.NSO_HEADER_SIZE,
                            data: modules.brazo.assembleInstruction(hook.instruction)
                        }, `hook "${hook.name}" instruction override ("${hook.instruction}")`);

                        break;
                    }
                    case "data": {
                        addPatch({
                            address: hook.address + constants.NSO_HEADER_SIZE,
                            data: hook.data
                        }, `hook "${hook.name}" raw data override`);

                        break;
                    }
                }
            }

            } finally {
                asm.close();
            }

            log.info("Wrote hook trampolines to \"hooks.s\".");

            for (const [ index, sym ] of symbols.entries()) {
                const linkerPath = modules.way.join(dirpath, `symbols_${index}.ld`);

                sym.toLinker(linkerPath, constants.NSMBUDX_NSO_MEMORY_SIZE);
                linkers.push("-T", linkerPath);
            }

            log.info("Generated linker scripts for symbol file(s).");
            log.info("Invoking clang++...");
            log.info("");

            const commonFlags = [
                "--target=armv7l-none-eabihf",
                "-mcpu=cortex-a57",
                "-mfpu=crypto-neon-fp-armv8",
                "-mfloat-abi=hard",
                "-fPIC",
                "-nostdlib",
                "-fno-rtti",
                "-fno-exceptions",
                "-fpermissive",
                "-I",
                modules.way.join(modules.way.cwd(), "./source/code")
            ];

            const inputs = [
                assets.crt0,
                asm.info.entry.path.normal,
                ...code.map(({ entry }) => entry.path.normal)
            ];

            const objs: string[] = [];
            const failures: string[] = [];

            // One invocation per file with an explicit -o. A single multi-file invocation names
            // objects after the file's basename, so two files called util.cpp in different
            // folders (or a user file called hooks.cpp / crt0.cpp) silently overwrote each other.
            for (const [ index, input ] of inputs.entries()) {
                const base = input.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, "");
                const obj = modules.way.join(dirpath, `${index}_${base}.o`);

                argv = [ ...commonFlags, "-c", input, "-o", obj ];

                const result = modules.child_process.spawnSync("clang++", argv, { stdio: "pipe", cwd: dirpath });

                logProcessOutput(log, "clang++", result, argv);

                if (result.error || result.status !== 0) {
                    const stderr = result.stderr ? modules.utils.decode(result.stderr).trim() : "";
                    failures.push(`${input}${result.error ? `\n${result.error.message}` : ""}${stderr ? `\n${stderr}` : ""}`);
                    continue;
                }

                objs.push(obj);
            }

            log.info("");

            if (failures.length > 0) {
                const report = failures.join("\n\n");

                throw new Error(`clang++ failed on ${failures.length} of ${inputs.length} file(s):\n\n${report.length > 12000 ? report.slice(0, 12000) + "\n... (truncated, see debug.log)" : report}`);
            }

            if (objs.length === 0) {
                throw new Error("clang++ did not produce any object files.");
            }

            summary.objects = objs.length;
            log.info(`Compiled ${objs.length} object file(s).`);
            log.info("Invoking arm-none-eabi-ld...");
            log.info("");

            const linkResult = modules.child_process.spawnSync("arm-none-eabi-ld", (argv = [
                "-pie",
                ...linkers,
                "--unresolved-symbols=ignore-all",
                ...objs,
                "-o",
                elfpath
            ]), { stdio: "pipe", cwd: dirpath });

            logProcessOutput(log, "arm-none-eabi-ld", linkResult, argv);
            checkSpawnResult("arm-none-eabi-ld", linkResult);
            log.info("");

            log.info(`Linked ELF at "${elfpath}".`);

            const elf = new modules.elfo.Elf(elfpath);
            const nso = new modules.filetendo.NSO(stagedSubsdk0);

            const dynsym = elf.findSection(".dynsym");
            const dynstr = elf.findSection(".dynstr");
            const bss = elf.findSection(".bss");

            if (!dynstr || !dynsym || !bss) throw new Error("Missing either one or more important sections: .dynsym, .dynstr, .bss");
            if (elf.loadableSegments.length !== 3) throw new Error("Loadable segments count must be exactly 3");

            log.info("Resolved required ELF sections and loadable segments.");

            const text = elf.loadableSegments[0];
            const ro = elf.loadableSegments[1];
            const data = elf.loadableSegments[2];

            nso.setProperty("textMemoryOffset", Number(text.vaddr));
            nso.setProperty("roMemoryOffset", Number(ro.vaddr));
            nso.setProperty("dataMemoryOffset", Number(data.vaddr));

            nso.setProperty("dynstrOffset", Number(dynstr.offset - ro.offset));
            nso.setProperty("dynstrSize", Number(dynstr.size));
            nso.setProperty("dynsymOffset", Number(dynsym.offset - ro.offset));
            nso.setProperty("dynsymSize", Number(dynsym.size));
            nso.setProperty("bssSize", Number(data.memsz - data.filesz));

            nso.setProperty("embeddedOffset", 0);
            nso.setProperty("embeddedSize", 0);

            const trampolines = hooks.filter(hook => hook.type === "hook" || hook.type === "call").map(hook => {
                const hookSymbol = elf.findSymbol(hook.symbol);
                const trampolineName = hook.type === "hook" ? hook.trampoline : undefined;
                const trampolineSymbol = trampolineName ? elf.findSymbol(trampolineName) : null;

                if (!hookSymbol) throw new Error("Could not find hook symbol: " + hook.symbol);
                if (trampolineName && !trampolineSymbol) throw new Error("Could not find trampoline symbol: " + trampolineName);

                log.info(`Resolved hook symbol "${hook.symbol}" (${hook.name}) at ${modules.utils.hexify(Number(hookSymbol.value))}${trampolineSymbol ? `, trampoline "${trampolineName}" at ${modules.utils.hexify(Number(trampolineSymbol.value))}` : " (no trampoline)"}.`);

                const hookSrc = hook.address;
                const hookDst = constants.NSMBUDX_NSO_MEMORY_SIZE + Number(hookSymbol.value);
                const link = hook.type === "call";

                addPatch({
                    address: hook.address + constants.NSO_HEADER_SIZE,
                    data: modules.brazo.assembleBranchInstruction(hookSrc, hookDst, link)
                }, `hook "${hook.name}" ${link ? "call" : "redirect"} at ${modules.utils.hexify(hookSrc)} to symbol "${hook.symbol}" (${modules.utils.hexify(hookDst)})`);

                if (!trampolineSymbol) return null;

                const offset = Number(trampolineSymbol.value + text.offset + 4n);

                const trampolineSrc = constants.NSMBUDX_NSO_MEMORY_SIZE + Number(trampolineSymbol.value + 4n);
                const trampolineDst = hook.address + 4;

                const chunk = modules.brazo.assembleBranchInstruction(trampolineSrc, trampolineDst);

                log.info(`Trampoline "${trampolineName}" branch-back will be written at .text file offset ${modules.utils.hexify(offset)}, returning from ${modules.utils.hexify(trampolineSrc)} to ${modules.utils.hexify(trampolineDst)}.`);

                return {
                    offset,
                    chunk
                }
            }).filter(trampoline => trampoline !== null);

            summary.trampolines = trampolines.length;
            log.info(`Resolved ${trampolines.length} trampoline patch(es).`);

            nso.writeSection(".text", modules.utils.interceptReadStream(text.read(4), ([chunk, offset]) => {
                const trampoline = trampolines.find(trampoline => trampoline.offset === offset);

                if (trampoline) {
                    log.info(`Intercepted .text chunk at offset ${modules.utils.hexify(offset)} and replaced it with the trampoline branch-back instruction.`);
                    return [trampoline.chunk, trampoline.offset];
                }

                return [chunk, offset];
            }))

            nso.writeSection(".ro", ro.read());
            nso.writeSection(".data", data.read());

            nso.digest();

            log.info(`Staged NSO at "${stagedSubsdk0}".`);

            ips.writeToNewFile(stagedIps);

            log.info(`Staged IPS patch at "${stagedIps}".`);

            if (options.dryRun) {
                log.info("Dry run: skipping deployment, ./atmosphere was not touched.");
                return;
            }

            // Deploy: the only step that touches ./atmosphere, covered by the rollback guard.
            log.info("Deploying build to the layeredfs output folders...");

            guard.mkdir(constants.NSMBUDX_EXEFS_PATH);
            guard.mkdir(constants.NSMBUDX_EXEFS_PATCHES_PATH);
            guard.claim(constants.NSMBUDX_SUBSDK0_PATH);
            guard.claim(constants.NSMBUDX_IPS_PATH);

            Deno.copyFileSync(stagedSubsdk0, constants.NSMBUDX_SUBSDK0_PATH);
            Deno.copyFileSync(stagedIps, constants.NSMBUDX_IPS_PATH);

            summary.deployed = true;
            log.info(`Deployed "${constants.NSMBUDX_SUBSDK0_PATH}" and "${constants.NSMBUDX_IPS_PATH}".`);
        });

        guard.commit();
        summary.durationMs = Math.round(performance.now() - startedAt);
        log.info(`Compilation completed successfully in ${summary.durationMs} ms.`);

        return summary;
    } catch (error) {
        log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        log.info("Build failed. Rolling back output created by this run...");

        // Undo ONLY what this run created. Never delete ./atmosphere wholesale.
        guard.rollback(log);

        // Let the caller (mod.ts) report the error and set a failing exit code.
        throw error;
    } finally {
        log.close();
    }
}