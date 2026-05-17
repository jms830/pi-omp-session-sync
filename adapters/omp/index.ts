import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { SessionManager as OmpSessionManager } from "@oh-my-pi/pi-coding-agent";
import {
	DEFAULT_LIMIT,
	buildSyncedSessionFileContent,
	convertPiToOmp,
	defaultRegistryPath,
	defaultSessionsDir,
	findSessionFileByCanonicalId,
	formatImportStatus,
	formatSessionList,
	getSyncedSession,
	listSessions,
	loadImportRegistry,
	loadSessionFile,
	planBulkSync,
	recordSyncedSession,
	saveImportRegistry,
	type DiscoveredSession,
	type Runtime,
} from "../../src/core";

export * from "../../src/core";

interface ParsedArgs {
	sourceDir: string;
	registryPath: string;
	limit: number;
	cwd: string | undefined;
	since: number | undefined;
	updatedSince: number | undefined;
	search: string | undefined;
	dryRun: boolean;
	force: boolean;
	selector: string | undefined;
}

const RUNTIME: Runtime = "omp";
const SOURCE: Runtime = "pi";
const HOME = homedir();

function parseArgs(args: string): ParsedArgs {
	const tokens = splitArgs(args);
	let sourceDir = defaultSessionsDir(SOURCE);
	let registryPath = defaultRegistryPath(RUNTIME);
	let limit = DEFAULT_LIMIT;
	let cwd: string | undefined;
	let since: number | undefined;
	let updatedSince: number | undefined;
	let dryRun = false;
	let force = false;
	const positional: string[] = [];

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--source-dir") sourceDir = expandHome(tokens[++i] ?? sourceDir);
		else if (token === "--registry") registryPath = expandHome(tokens[++i] ?? registryPath);
		else if (token === "--limit") limit = clampLimit(Number(tokens[++i]));
		else if (token === "--cwd") cwd = tokens[++i];
		else if (token === "--since") since = parseTime(tokens[++i]);
		else if (token === "--updated-since") updatedSince = parseTime(tokens[++i]);
		else if (token === "--dry-run") dryRun = true;
		else if (token === "--force") force = true;
		else positional.push(token);
	}
	return { sourceDir, registryPath, limit, cwd, since, updatedSince, search: undefined, dryRun, force, selector: positional.join(" ").trim() || undefined };
}

function buildProvenance(source: DiscoveredSession, canonicalId: string, messageCount: number, skippedUnknown: number): string {
	return [
		`Synced from Pi session ${source.id}`,
		`Source file: ${source.file}`,
		`Source title: ${source.title ?? "(no title)"}`,
		`Source cwd: ${source.cwd}`,
		`Canonical id: ${canonicalId}`,
		`Imported messages: ${messageCount}`,
		`Skipped unknown entries: ${skippedUnknown}`,
	].join("\n");
}

async function importOne(ctx: ExtensionCommandContext, parsed: ParsedArgs, source: DiscoveredSession): Promise<{ imported: boolean; message?: string }> {
	const loaded = loadSessionFile(source.file);
	const converted = convertPiToOmp(loaded);
	const targetDir = OmpSessionManager.getDefaultSessionDir(source.cwd);
	const existing = findSessionFileByCanonicalId(targetDir, converted.lineage.canonicalId);
	if (existing && !parsed.force) {
		return { imported: false, message: `Already synced ${source.id} as ${existing}` };
	}
	const { content, fileName } = buildSyncedSessionFileContent(converted, {
		targetRuntime: RUNTIME,
		cwd: source.cwd,
		parentSession: ctx.sessionManager.getSessionFile(),
		provenance: buildProvenance(source, converted.lineage.canonicalId, converted.messageCount, converted.skipped.unknownEntries),
	});
	mkdirSync(targetDir, { recursive: true });
	const filePath = join(targetDir, fileName);
	writeFileSync(filePath, content);
	const result = await ctx.switchSession(filePath);
	if (result.cancelled) return { imported: false, message: "Switch cancelled" };
	ctx.ui.setEditorText("");

	const registry = loadImportRegistry(parsed.registryPath);
	recordSyncedSession(registry, {
		source,
		targetRuntime: RUNTIME,
		targetSessionFile: filePath,
		messageCount: converted.messageCount,
		skippedCount: converted.skipped.unknownEntries + converted.skipped.malformedEntries,
	});
	saveImportRegistry(parsed.registryPath, registry);
	return { imported: true, message: `Synced ${source.id} (canonical ${converted.lineage.canonicalId.slice(0, 8)}): ${converted.messageCount} messages` };
}

async function importAll(ctx: ExtensionCommandContext, parsed: ParsedArgs): Promise<void> {
	const registry = loadImportRegistry(parsed.registryPath);
	const plan = planBulkSync(parsed.sourceDir, registry, {
		cwd: parsed.cwd,
		since: parsed.since,
		updatedSince: parsed.updatedSince,
		limit: parsed.limit,
		dryRun: parsed.dryRun,
		force: parsed.force,
		sourceRuntime: SOURCE,
		targetRuntime: RUNTIME,
	});
	if (parsed.dryRun) {
		ctx.ui.notify(`Dry run: ${plan.toImport.length} to sync, ${plan.skippedAlreadyImported.length} already in sync\n${formatSessionList(plan.toImport, registry, RUNTIME)}`, "info");
		return;
	}
	if (plan.toImport.length === 0) {
		ctx.ui.notify(`No sessions to sync. ${plan.skippedAlreadyImported.length} already imported.`, "info");
		return;
	}
	const messages: string[] = [];
	for (const session of plan.toImport) {
		const result = await importOne(ctx, parsed, session);
		if (result.message) messages.push(result.message);
	}
	ctx.ui.notify(`Pi↔OMP sync complete\n${messages.join("\n")}`, "info");
}

async function selectAndImport(ctx: ExtensionCommandContext, parsed: ParsedArgs): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/pi-omp-sync without an exact session id requires interactive mode", "error");
		return;
	}
	const registry = loadImportRegistry(parsed.registryPath);
	const sessions = listSessions(parsed.sourceDir, { cwd: parsed.cwd, search: parsed.selector, since: parsed.since, updatedSince: parsed.updatedSince, limit: parsed.limit });
	if (sessions.length === 0) {
		ctx.ui.notify(parsed.selector ? `No Pi sessions matched: ${parsed.selector}` : "No Pi sessions found", "warning");
		return;
	}
	const choices = sessions.map((session) => formatChoice(session, registry));
	const selected = await ctx.ui.select("Sync Pi session into OMP", choices);
	if (!selected) {
		ctx.ui.notify("Pi↔OMP sync cancelled", "info");
		return;
	}
	const session = sessions[choices.indexOf(selected)];
	if (!session) {
		ctx.ui.notify("Selected Pi session could not be resolved", "error");
		return;
	}
	const result = await importOne(ctx, parsed, session);
	ctx.ui.notify(result.message ?? "Pi↔OMP sync finished", result.imported ? "info" : "warning");
}

function handleList(ctx: ExtensionCommandContext, parsed: ParsedArgs): void {
	const registry = loadImportRegistry(parsed.registryPath);
	const sessions = listSessions(parsed.sourceDir, { cwd: parsed.cwd, search: parsed.selector, since: parsed.since, updatedSince: parsed.updatedSince, limit: parsed.limit });
	ctx.ui.notify(formatSessionList(sessions, registry, RUNTIME), "info");
}

function handleStatus(ctx: ExtensionCommandContext, parsed: ParsedArgs): void {
	const registry = loadImportRegistry(parsed.registryPath);
	ctx.ui.notify(formatImportStatus(planBulkSync(parsed.sourceDir, registry, {
		cwd: parsed.cwd, search: parsed.selector, since: parsed.since, updatedSince: parsed.updatedSince, limit: parsed.limit,
		sourceRuntime: SOURCE, targetRuntime: RUNTIME,
	}), registry, RUNTIME), "info");
}

async function handleOpen(ctx: ExtensionCommandContext, parsed: ParsedArgs, sessionId: string | undefined): Promise<void> {
	if (!sessionId) {
		ctx.ui.notify("Usage: /pi-omp-sync open <pi-session-id>", "error");
		return;
	}
	const entry = getSyncedSession(loadImportRegistry(parsed.registryPath), SOURCE, RUNTIME, sessionId);
	if (!entry) {
		ctx.ui.notify(`No OMP session synced from Pi ${sessionId}`, "warning");
		return;
	}
	const result = await ctx.switchSession(entry.targetSessionFile);
	ctx.ui.notify(result.cancelled ? "Switch session cancelled" : `Opened OMP session synced from Pi ${sessionId}`, "info");
}

export default function piOmpSyncExtension(pi: ExtensionAPI): void {
	pi.registerCommand("pi-omp-sync", {
		description: "Sync Pi sessions into native OMP sessions",
		getArgumentCompletions: () => [
			{ value: "list ", label: "list" },
			{ value: "status", label: "status" },
			{ value: "all --dry-run", label: "all --dry-run" },
			{ value: "all", label: "all" },
			{ value: "open ", label: "open <pi-session-id>" },
			{ value: "--source-dir ", label: "--source-dir <path>" },
			{ value: "--cwd ", label: "--cwd <path>" },
			{ value: "--updated-since ", label: "--updated-since <iso|ms>" },
			{ value: "--limit ", label: "--limit <n>" },
		],
		handler: async (args, ctx) => {
			try {
				const parsed = parseArgs(args);
				const selector = parsed.selector;
				const [command, ...rest] = selector ? splitArgs(selector) : [];
				const restText = rest.join(" ").trim() || undefined;
				if (command === "list") return handleList(ctx, { ...parsed, selector: restText });
				if (command === "status") return handleStatus(ctx, { ...parsed, selector: restText });
				if (command === "all") return await importAll(ctx, { ...parsed, selector: restText });
				if (command === "open") return await handleOpen(ctx, parsed, rest[0]);
				if (selector && isLikelySessionId(selector)) {
					const sessions = listSessions(parsed.sourceDir, { limit: parsed.limit });
					const source = sessions.find((session) => session.id === selector);
					if (!source) {
						ctx.ui.notify(`Pi session not found: ${selector}`, "warning");
						return;
					}
					const result = await importOne(ctx, parsed, source);
					ctx.ui.notify(result.message ?? "Pi↔OMP sync finished", result.imported ? "info" : "warning");
					return;
				}
				await selectAndImport(ctx, { ...parsed, selector });
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

function formatChoice(session: DiscoveredSession, registry: ReturnType<typeof loadImportRegistry>): string {
	const importedEntry = getSyncedSession(registry, session.runtime, RUNTIME, session.id);
	const status = importedEntry ? (importedEntry.sourceMtimeMs === session.mtimeMs ? "imported" : "stale") : "pending";
	return `${session.title ?? "(no title)"}  ·  ${status}  ·  ${new Date(session.mtimeMs).toISOString().slice(0, 16)}  ·  ${session.cwd}  ·  ${session.id}`;
}

function splitArgs(args: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < args.length; i += 1) {
		const char = args[i];
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

function expandHome(path: string): string {
	return path === "~" ? HOME : path.startsWith("~/") ? `${HOME}${path.slice(1)}` : path;
}

function clampLimit(limit: number): number {
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(200, Math.trunc(limit)));
}

function parseTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid timestamp: ${value}`);
	return parsed;
}

function isLikelySessionId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
