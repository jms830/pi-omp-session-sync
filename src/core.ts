import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type Runtime = "pi" | "omp";

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	title?: string;
	titleSource?: "auto" | "user";
}

export interface DiscoveredSession {
	id: string;
	file: string;
	runtime: Runtime;
	cwd: string;
	title?: string;
	mtimeMs: number;
	byteSize: number;
}

export interface LoadedSession {
	source: DiscoveredSession;
	header: SessionHeader;
	entries: unknown[];
}

export interface ConvertedSession {
	direction: "pi-to-omp" | "omp-to-pi";
	header: SessionHeader;
	title: string | undefined;
	entries: unknown[];
	messageCount: number;
	skipped: {
		unknownEntries: number;
		malformedEntries: number;
	};
	lineage: Lineage;
}

export interface ImportRegistryEntry {
	sourceSessionId: string;
	sourceRuntime: Runtime;
	sourceFile: string;
	sourceMtimeMs: number;
	sourceTitle: string | undefined;
	sourceCwd: string;
	targetRuntime: Runtime;
	targetSessionFile: string;
	syncedAt: string;
	conversionVersion: number;
	messageCount: number;
	skippedCount: number;
}

export interface ImportRegistry {
	version: 1;
	imports: Record<string, ImportRegistryEntry>;
}

export interface ListOptions {
	cwd?: string;
	search?: string;
	since?: number;
	updatedSince?: number;
	limit?: number;
}

export interface BulkPlanOptions extends ListOptions {
	dryRun?: boolean;
	force?: boolean;
	sourceRuntime: Runtime;
	targetRuntime: Runtime;
}

export interface BulkPlan {
	sessions: DiscoveredSession[];
	toImport: DiscoveredSession[];
	skippedAlreadyImported: DiscoveredSession[];
	dryRun: boolean;
	force: boolean;
	sourceRuntime: Runtime;
	targetRuntime: Runtime;
}

export interface RecordSyncOptions {
	source: DiscoveredSession;
	targetSessionFile: string;
	targetRuntime: Runtime;
	messageCount: number;
	skippedCount: number;
	syncedAt?: Date;
}

export const CONVERSION_VERSION = 1;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const CUSTOM_MESSAGE_TYPE = "pi-omp-sync";

const OMP_ONLY_ENTRY_TYPES = new Set([
	"mode_change",
	"service_tier_change",
	"session_init",
]);

export function defaultSessionsDir(runtime: Runtime, home = homedir()): string {
	return runtime === "pi" ? `${home}/.pi/agent/sessions` : `${home}/.omp/agent/sessions`;
}

export function defaultRegistryPath(runtime: Runtime, home = homedir()): string {
	return runtime === "pi" ? `${home}/.pi/agent/pi-omp-sync-registry.json` : `${home}/.omp/agent/pi-omp-sync-registry.json`;
}

export function listSessions(sessionsRoot: string, options: ListOptions = {}): DiscoveredSession[] {
	if (!existsSync(sessionsRoot)) return [];
	const limit = clampLimit(options.limit);
	const search = options.search?.trim().toLowerCase();
	const sessions: DiscoveredSession[] = [];
	for (const cwdDir of readdirSync(sessionsRoot, { withFileTypes: true })) {
		if (!cwdDir.isDirectory()) continue;
		const cwdPath = join(sessionsRoot, cwdDir.name);
		for (const file of readdirSync(cwdPath, { withFileTypes: true })) {
			if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
			const filePath = join(cwdPath, file.name);
			const header = readSessionHeader(filePath);
			if (!header) continue;
			const stat = statSync(filePath);
			const runtime = detectRuntime(sessionsRoot);
			if (options.cwd && header.cwd !== options.cwd) continue;
			if (options.since !== undefined && Date.parse(header.timestamp) < options.since) continue;
			if (options.updatedSince !== undefined && stat.mtimeMs < options.updatedSince) continue;
			const title = headerTitle(filePath, header);
			if (search) {
				const haystack = `${header.id} ${header.cwd} ${title ?? ""}`.toLowerCase();
				if (!haystack.includes(search)) continue;
			}
			sessions.push({
				id: header.id,
				file: filePath,
				runtime,
				cwd: header.cwd,
				title,
				mtimeMs: stat.mtimeMs,
				byteSize: stat.size,
			});
		}
	}
	sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return sessions.slice(0, limit);
}

export function loadSessionFile(filePath: string): LoadedSession {
	const lines = readFileSync(filePath, "utf8").split("\n").filter((line) => line.length > 0);
	const parsed: unknown[] = [];
	for (const line of lines) {
		try {
			parsed.push(JSON.parse(line));
		} catch {
			// skip malformed line
		}
	}
	const header = parsed.find((entry) => (entry as { type?: string }).type === "session") as SessionHeader | undefined;
	if (!header) throw new Error(`Session header not found in ${filePath}`);
	const entries = parsed.filter((entry) => entry !== header);
	const stat = statSync(filePath);
	const runtime = detectRuntimeFromHeader(header, filePath);
	const title = headerTitle(filePath, header);
	return {
		source: {
			id: header.id,
			file: filePath,
			runtime,
			cwd: header.cwd,
			title,
			mtimeMs: stat.mtimeMs,
			byteSize: stat.size,
		},
		header,
		entries,
	};
}

export function convertPiToOmp(loaded: LoadedSession): ConvertedSession {
	let title: string | undefined = loaded.header.title;
	const entries: unknown[] = [];
	const skipped = { unknownEntries: 0, malformedEntries: 0 };
	let messageCount = 0;
	for (const entry of loaded.entries) {
		if (!entry || typeof entry !== "object") {
			skipped.malformedEntries += 1;
			continue;
		}
		const type = (entry as { type?: string }).type;
		if (type === "session_info") {
			const name = (entry as { name?: string }).name;
			if (name && !title) title = name;
			continue;
		}
		if (type === "model_change") {
			const provider = (entry as { provider?: string }).provider;
			const modelId = (entry as { modelId?: string }).modelId;
			if (provider && modelId) {
				entries.push({
					...(entry as object),
					provider: undefined,
					modelId: undefined,
					model: `${provider}/${modelId}`,
				});
				continue;
			}
		}
		if (type === "message") {
			messageCount += 1;
		}
		entries.push(entry);
	}
	const lineage = lineageFromEntries(loaded.entries, loaded.source.runtime, loaded.header.id);
	return {
		direction: "pi-to-omp",
		header: { ...loaded.header, title, titleSource: title ? "user" : loaded.header.titleSource },
		title,
		entries,
		messageCount,
		skipped,
		lineage,
	};
}

export function convertOmpToPi(loaded: LoadedSession): ConvertedSession {
	const entries: unknown[] = [];
	const skipped = { unknownEntries: 0, malformedEntries: 0 };
	let messageCount = 0;
	const title = loaded.header.title;
	for (const entry of loaded.entries) {
		if (!entry || typeof entry !== "object") {
			skipped.malformedEntries += 1;
			continue;
		}
		const type = (entry as { type?: string }).type;
		if (OMP_ONLY_ENTRY_TYPES.has(type ?? "")) {
			skipped.unknownEntries += 1;
			continue;
		}
		if (type === "model_change") {
			const combined = (entry as { model?: string }).model;
			if (combined && combined.includes("/")) {
				const slash = combined.indexOf("/");
				const provider = combined.slice(0, slash);
				const modelId = combined.slice(slash + 1);
				entries.push({
					...(entry as object),
					model: undefined,
					provider,
					modelId,
				});
				continue;
			}
		}
		if (type === "message") {
			messageCount += 1;
		}
		entries.push(entry);
	}
	if (title) {
		entries.push({
			type: "session_info",
			id: "title-imported",
			parentId: null,
			timestamp: loaded.header.timestamp,
			name: title,
		});
	}
	const lineage = lineageFromEntries(loaded.entries, loaded.source.runtime, loaded.header.id);
	return {
		direction: "omp-to-pi",
		header: { ...loaded.header, title: undefined, titleSource: undefined },
		title,
		entries,
		messageCount,
		skipped,
		lineage,
	};
}

function lineageFromEntries(entries: unknown[], sourceRuntime: Runtime, headerId: string): Lineage {
	for (const entry of entries.slice(0, 80)) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: string; customType?: string; details?: { lineageRuntime?: LineageRuntime; lineageId?: string; canonicalId?: string } };
		if (e.type === "custom_message" && (e.customType === "opencode-import" || e.customType === "pi-omp-sync")) {
			const details = e.details;
			if (details?.lineageRuntime && typeof details.lineageId === "string" && typeof details.canonicalId === "string") {
				return { lineageRuntime: details.lineageRuntime, lineageId: details.lineageId, canonicalId: details.canonicalId };
			}
		}
	}
	return { lineageRuntime: sourceRuntime, lineageId: headerId, canonicalId: canonicalIdFor(sourceRuntime, headerId) };
}

export function loadImportRegistry(path: string): ImportRegistry {
	if (!existsSync(path)) return { version: 1, imports: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return { version: 1, imports: {} };
		const registry = parsed as Partial<ImportRegistry>;
		return { version: 1, imports: registry.imports && typeof registry.imports === "object" ? registry.imports : {} };
	} catch {
		return { version: 1, imports: {} };
	}
}

export function saveImportRegistry(path: string, registry: ImportRegistry): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
	renameSync(tmpPath, path);
}

export function registryKey(sourceRuntime: Runtime, targetRuntime: Runtime, sourceSessionId: string): string {
	return `${sourceRuntime}->${targetRuntime}:${sourceSessionId}`;
}

export function recordSyncedSession(registry: ImportRegistry, options: RecordSyncOptions): ImportRegistryEntry {
	const entry: ImportRegistryEntry = {
		sourceSessionId: options.source.id,
		sourceRuntime: options.source.runtime,
		sourceFile: options.source.file,
		sourceMtimeMs: options.source.mtimeMs,
		sourceTitle: options.source.title,
		sourceCwd: options.source.cwd,
		targetRuntime: options.targetRuntime,
		targetSessionFile: options.targetSessionFile,
		syncedAt: (options.syncedAt ?? new Date()).toISOString(),
		conversionVersion: CONVERSION_VERSION,
		messageCount: options.messageCount,
		skippedCount: options.skippedCount,
	};
	registry.imports[registryKey(options.source.runtime, options.targetRuntime, options.source.id)] = entry;
	return entry;
}

export function getSyncedSession(
	registry: ImportRegistry,
	sourceRuntime: Runtime,
	targetRuntime: Runtime,
	sourceSessionId: string,
): ImportRegistryEntry | undefined {
	return registry.imports[registryKey(sourceRuntime, targetRuntime, sourceSessionId)];
}

export function planBulkSync(sessionsRoot: string, registry: ImportRegistry, options: BulkPlanOptions): BulkPlan {
	const sessions = listSessions(sessionsRoot, options);
	const force = Boolean(options.force);
	const toImport: DiscoveredSession[] = [];
	const skippedAlreadyImported: DiscoveredSession[] = [];
	for (const session of sessions) {
		const existing = getSyncedSession(registry, options.sourceRuntime, options.targetRuntime, session.id);
		if (!force && existing && existing.sourceMtimeMs === session.mtimeMs) skippedAlreadyImported.push(session);
		else toImport.push(session);
	}
	return {
		sessions,
		toImport,
		skippedAlreadyImported,
		dryRun: Boolean(options.dryRun),
		force,
		sourceRuntime: options.sourceRuntime,
		targetRuntime: options.targetRuntime,
	};
}

export function formatSessionList(sessions: DiscoveredSession[], registry?: ImportRegistry, targetRuntime?: Runtime): string {
	if (sessions.length === 0) return "No sessions found.";
	return sessions.map((session) => {
		const importedEntry = registry && targetRuntime ? getSyncedSession(registry, session.runtime, targetRuntime, session.id) : undefined;
		const status = importedEntry ? (importedEntry.sourceMtimeMs === session.mtimeMs ? "imported" : "stale") : "pending";
		return `${session.id}\t${status}\t${new Date(session.mtimeMs).toISOString()}\t${session.cwd}\t${session.title ?? "(no title)"}`;
	}).join("\n");
}

export function formatImportStatus(plan: BulkPlan, registry: ImportRegistry, targetRuntime: Runtime): string {
	const entries = Object.values(registry.imports).filter((entry) => entry.targetRuntime === targetRuntime);
	const importedIds = new Set(entries.map((entry) => entry.sourceSessionId));
	const pendingSessions = plan.sessions.filter((session) => !importedIds.has(session.id));
	const lines = [
		`Pi↔OMP sync status (target ${targetRuntime})`,
		`Imported: ${entries.length}`,
		`Pending: ${pendingSessions.length}`,
		`Already imported in this selection: ${plan.skippedAlreadyImported.length}`,
	];
	for (const entry of entries.slice(0, 20)) {
		lines.push(`${entry.sourceSessionId}\t${entry.sourceTitle ?? "(no title)"}\t${entry.targetSessionFile}`);
	}
	if (pendingSessions.length > 0) {
		lines.push("Pending sessions:");
		for (const session of pendingSessions.slice(0, 20)) lines.push(`${session.id}\t${session.title ?? "(no title)"}\t${session.cwd}`);
	}
	return lines.join("\n");
}

function clampLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit ?? DEFAULT_LIMIT)));
}

function readSessionHeader(filePath: string): SessionHeader | undefined {
	try {
		const text = readFileSync(filePath, "utf8");
		const firstLineEnd = text.indexOf("\n");
		const firstLine = firstLineEnd >= 0 ? text.slice(0, firstLineEnd) : text;
		const parsed = JSON.parse(firstLine) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		const header = parsed as SessionHeader;
		if (header.type !== "session" || !header.id || !header.cwd) return undefined;
		return header;
	} catch {
		return undefined;
	}
}

function headerTitle(filePath: string, header: SessionHeader): string | undefined {
	if (header.title) return header.title;
	// Pi stores title in a session_info entry — scan up to first 64 entries for name
	try {
		const text = readFileSync(filePath, "utf8");
		const lines = text.split("\n").slice(1, 65);
		for (const line of lines) {
			if (!line) continue;
			try {
				const parsed = JSON.parse(line) as { type?: string; name?: string };
				if (parsed.type === "session_info" && typeof parsed.name === "string") return parsed.name;
			} catch {
				continue;
			}
		}
	} catch {
		// ignore
	}
	return undefined;
}

function detectRuntime(sessionsRoot: string): Runtime {
	return sessionsRoot.includes(".pi/") || sessionsRoot.endsWith(".pi/agent/sessions") || sessionsRoot.includes("pi-sessions") ? "pi" : "omp";
}

function detectRuntimeFromHeader(header: SessionHeader, filePath: string): Runtime {
	if (header.title !== undefined || header.titleSource !== undefined) return "omp";
	if (filePath.includes(".pi/")) return "pi";
	if (filePath.includes(".omp/")) return "omp";
	return "pi";
}

export const CANONICAL_NAMESPACE_UUID = "6e7b9c2a-3f4d-5e1f-a8b7-1c2d3e4f5a6b";

export type LineageRuntime = "opencode" | Runtime;

export interface Lineage {
	lineageRuntime: LineageRuntime;
	lineageId: string;
	canonicalId: string;
}

export function uuidv5(name: string, namespace: string): string {
	const nsBytes = parseUuidBytes(namespace);
	const nameBytes = Buffer.from(name, "utf8");
	const hash = createHash("sha1").update(Buffer.concat([nsBytes, nameBytes])).digest();
	const bytes = Buffer.from(hash.subarray(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	return formatUuidBytes(bytes);
}

export function canonicalIdFor(lineageRuntime: LineageRuntime, lineageId: string): string {
	return lineageRuntime === "opencode" ? uuidv5(`opencode:${lineageId}`, CANONICAL_NAMESPACE_UUID) : lineageId;
}

export function detectLineage(filePath: string, sourceRuntime: Runtime): Lineage {
	const text = readFileSync(filePath, "utf8");
	const lines = text.split("\n");
	const headerLine = lines[0];
	let headerId: string | undefined;
	try {
		const header = JSON.parse(headerLine) as { id?: string };
		headerId = header.id;
	} catch {
		headerId = undefined;
	}
	for (const line of lines.slice(1, 81)) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; customType?: string; details?: { lineageRuntime?: LineageRuntime; lineageId?: string; canonicalId?: string } };
			if (entry.type === "custom_message" && (entry.customType === "opencode-import" || entry.customType === "pi-omp-sync")) {
				const details = entry.details;
				if (details?.lineageRuntime && typeof details.lineageId === "string" && typeof details.canonicalId === "string") {
					return { lineageRuntime: details.lineageRuntime, lineageId: details.lineageId, canonicalId: details.canonicalId };
				}
			}
		} catch {
			continue;
		}
	}
	const id = headerId ?? "unknown";
	return { lineageRuntime: sourceRuntime, lineageId: id, canonicalId: canonicalIdFor(sourceRuntime, id) };
}

export function findSessionFileByCanonicalId(sessionsDir: string, canonicalId: string): string | undefined {
	if (!existsSync(sessionsDir)) return undefined;
	const suffix = `_${canonicalId}.jsonl`;
	for (const entry of readdirSync(sessionsDir)) {
		if (entry.endsWith(suffix)) return join(sessionsDir, entry);
	}
	return undefined;
}

function parseUuidBytes(uuid: string): Buffer {
	const hex = uuid.replace(/-/g, "");
	if (hex.length !== 32) throw new Error(`Invalid UUID namespace: ${uuid}`);
	return Buffer.from(hex, "hex");
}

function formatUuidBytes(bytes: Buffer): string {
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const CUSTOM_MESSAGE_TYPE_SYNC = "pi-omp-sync";

export interface SyncFileBuildOptions {
	targetRuntime: Runtime;
	cwd: string;
	parentSession?: string;
	provenance: string;
	timestamp?: Date;
}

export interface BuiltSyncFile {
	content: string;
	fileName: string;
	sessionId: string;
}

export function buildSyncedSessionFileContent(converted: ConvertedSession, options: SyncFileBuildOptions): BuiltSyncFile {
	const timestamp = options.timestamp ?? new Date();
	const isoTs = timestamp.toISOString();
	const sessionId = converted.lineage.canonicalId;
	const fileTimestamp = isoTs.replace(/[:.]/g, "-");
	const fileName = `${fileTimestamp}_${sessionId}.jsonl`;
	const header: Record<string, unknown> = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: isoTs,
		cwd: options.cwd,
	};
	if (options.parentSession) header.parentSession = options.parentSession;
	if (options.targetRuntime === "omp" && converted.title) {
		header.title = converted.title;
		header.titleSource = "user";
	}
	const out: Record<string, unknown>[] = [];
	let parentId: string | null = null;
	const push = (entry: Record<string, unknown>) => {
		const id = randomEntryId();
		out.push({ ...entry, id, parentId, timestamp: isoTs });
		parentId = id;
	};
	if (options.targetRuntime === "pi" && converted.title) push({ type: "session_info", name: converted.title });
	push({
		type: "custom_message",
		customType: CUSTOM_MESSAGE_TYPE_SYNC,
		content: options.provenance,
		display: true,
		details: {
			source: "pi-omp-sync",
			lineageRuntime: converted.lineage.lineageRuntime,
			lineageId: converted.lineage.lineageId,
			canonicalId: converted.lineage.canonicalId,
		},
	});
	for (const entry of converted.entries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: string };
		if (e.type === "session_info") continue; // already promoted to title/header
		push(stripIdParentTimestamp(entry));
	}
	const lines = [JSON.stringify(header), ...out.map((entry) => JSON.stringify(entry))];
	return { content: `${lines.join("\n")}\n`, fileName, sessionId };
}

function stripIdParentTimestamp(entry: unknown): Record<string, unknown> {
	if (!entry || typeof entry !== "object") return {};
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
		if (key === "id" || key === "parentId" || key === "timestamp") continue;
		cleaned[key] = value;
	}
	return cleaned;
}

function randomEntryId(): string {
	const bytes = createHash("sha1").update(`${process.hrtime.bigint()}-${Math.random()}`).digest("hex");
	return bytes.slice(0, 8);
}
