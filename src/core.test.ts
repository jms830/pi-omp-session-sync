import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CANONICAL_NAMESPACE_UUID,
	canonicalIdFor,
	convertPiToOmp,
	convertOmpToPi,
	detectLineage,
	findSessionFileByCanonicalId,
	formatImportStatus,
	loadImportRegistry,
	loadSessionFile,
	listSessions,
	planBulkSync,
	recordSyncedSession,
	saveImportRegistry,
	uuidv5,
} from "./core";

let tempRoot: string;
let piSessionsDir: string;
let ompSessionsDir: string;

function writeJsonl(path: string, entries: unknown[]): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function piHeader(id: string, cwd: string): Record<string, unknown> {
	return { type: "session", version: 3, id, timestamp: new Date(1).toISOString(), cwd };
}

function ompHeader(id: string, cwd: string, title?: string): Record<string, unknown> {
	return { type: "session", version: 3, id, timestamp: new Date(1).toISOString(), cwd, ...(title ? { title, titleSource: "user" } : {}) };
}

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "pi-omp-sync-"));
	piSessionsDir = join(tempRoot, "pi-sessions");
	ompSessionsDir = join(tempRoot, "omp-sessions");
	mkdirSync(piSessionsDir, { recursive: true });
	mkdirSync(ompSessionsDir, { recursive: true });

	writeJsonl(join(piSessionsDir, "--repo--", "pi-a.jsonl"), [
		piHeader("019pi-a", "/repo"),
		{ type: "model_change", id: "m1", parentId: null, timestamp: new Date(2).toISOString(), provider: "anthropic", modelId: "claude-opus-4-7" },
		{ type: "session_info", id: "n1", parentId: "m1", timestamp: new Date(3).toISOString(), name: "Pi Alpha" },
		{ type: "message", id: "u1", parentId: "n1", timestamp: new Date(4).toISOString(), message: { role: "user", content: [{ type: "text", text: "pi user" }], timestamp: 4 } },
		{ type: "message", id: "a1", parentId: "u1", timestamp: new Date(5).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "pi assistant" }], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-4-7", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 5 } },
	]);
	writeJsonl(join(ompSessionsDir, "-repo", "omp-a.jsonl"), [
		ompHeader("019omp-a", "/repo", "OMP Alpha"),
		{ type: "model_change", id: "m1", parentId: null, timestamp: new Date(2).toISOString(), model: "anthropic/claude-opus-4-7" },
		{ type: "mode_change", id: "mo1", parentId: "m1", timestamp: new Date(3).toISOString(), mode: "build" },
		{ type: "service_tier_change", id: "st1", parentId: "mo1", timestamp: new Date(3).toISOString(), serviceTier: "priority" },
		{ type: "message", id: "u1", parentId: "st1", timestamp: new Date(4).toISOString(), message: { role: "user", content: [{ type: "text", text: "omp user" }], timestamp: 4 } },
		{ type: "message", id: "a1", parentId: "u1", timestamp: new Date(5).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "omp assistant" }], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-4-7", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 5 } },
	]);
	writeJsonl(join(piSessionsDir, "--other--", "pi-b.jsonl"), [
		piHeader("019pi-b", "/other"),
		{ type: "session_info", id: "n1", parentId: null, timestamp: new Date(2).toISOString(), name: "Pi Beta" },
	]);
});

afterEach(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("session discovery", () => {
	test("lists Pi sessions across cwd dirs", () => {
		const sessions = listSessions(piSessionsDir);
		expect(sessions.map((session) => session.id).sort()).toEqual(["019pi-a", "019pi-b"]);
		const alpha = sessions.find((session) => session.id === "019pi-a")!;
		expect(alpha.title).toBe("Pi Alpha");
		expect(alpha.cwd).toBe("/repo");
		expect(alpha.file).toContain("pi-a.jsonl");
		expect(alpha.runtime).toBe("pi");
	});

	test("filters listed sessions by cwd", () => {
		const filtered = listSessions(piSessionsDir, { cwd: "/repo" });
		expect(filtered.map((session) => session.id)).toEqual(["019pi-a"]);
	});

	test("lists OMP sessions and reads title from header", () => {
		const sessions = listSessions(ompSessionsDir);
		expect(sessions.map((session) => session.id)).toEqual(["019omp-a"]);
		expect(sessions[0].title).toBe("OMP Alpha");
		expect(sessions[0].runtime).toBe("omp");
	});
});

describe("conversion", () => {
	test("Pi → OMP collapses session_info into header title and reshapes model_change", () => {
		const loaded = loadSessionFile(join(piSessionsDir, "--repo--", "pi-a.jsonl"));
		const converted = convertPiToOmp(loaded);
		expect(converted.title).toBe("Pi Alpha");
		expect(converted.entries.find((entry) => (entry as { type: string }).type === "session_info")).toBeUndefined();
		const modelChange = converted.entries.find((entry) => (entry as { type: string }).type === "model_change") as { model?: string } | undefined;
		expect(modelChange?.model).toBe("anthropic/claude-opus-4-7");
		expect(converted.messageCount).toBe(2);
	});

	test("OMP → Pi unflattens model_change, materializes title as session_info, and skips OMP-only entries", () => {
		const loaded = loadSessionFile(join(ompSessionsDir, "-repo", "omp-a.jsonl"));
		const converted = convertOmpToPi(loaded);
		const types = converted.entries.map((entry) => (entry as { type: string }).type);
		expect(types).not.toContain("mode_change");
		expect(types).not.toContain("service_tier_change");
		expect(types[0]).toBe("model_change");
		const modelChange = converted.entries[0] as { provider?: string; modelId?: string };
		expect(modelChange.provider).toBe("anthropic");
		expect(modelChange.modelId).toBe("claude-opus-4-7");
		const sessionInfo = converted.entries.find((entry) => (entry as { type: string }).type === "session_info") as { name?: string } | undefined;
		expect(sessionInfo?.name).toBe("OMP Alpha");
		expect(converted.skipped.unknownEntries).toBe(2);
	});
});

describe("bulk planning and registry", () => {
	test("plans bulk syncs in dry-run mode with filters", () => {
		const registry = loadImportRegistry(join(tempRoot, "registry.json"));
		const plan = planBulkSync(piSessionsDir, registry, { dryRun: true, limit: 50, sourceRuntime: "pi", targetRuntime: "omp" });
		expect(plan.sessions.map((session) => session.id).sort()).toEqual(["019pi-a", "019pi-b"]);
		expect(plan.toImport.map((session) => session.id).sort()).toEqual(["019pi-a", "019pi-b"]);
		expect(plan.dryRun).toBe(true);
	});

	test("registry makes subsequent plans idempotent until source mtime changes or force is set", () => {
		const registryPath = join(tempRoot, "registry.json");
		let registry = loadImportRegistry(registryPath);
		const source = listSessions(piSessionsDir).find((session) => session.id === "019pi-a")!;
		recordSyncedSession(registry, {
			source,
			targetSessionFile: "/tmp/omp-target.jsonl",
			targetRuntime: "omp",
			messageCount: 2,
			skippedCount: 0,
		});
		saveImportRegistry(registryPath, registry);
		registry = loadImportRegistry(registryPath);
		const plan = planBulkSync(piSessionsDir, registry, { sourceRuntime: "pi", targetRuntime: "omp", limit: 50 });
		expect(plan.toImport.map((session) => session.id)).toEqual(["019pi-b"]);
		expect(plan.skippedAlreadyImported.map((session) => session.id)).toEqual(["019pi-a"]);
		const forced = planBulkSync(piSessionsDir, registry, { sourceRuntime: "pi", targetRuntime: "omp", limit: 50, force: true });
		expect(forced.toImport.map((session) => session.id).sort()).toEqual(["019pi-a", "019pi-b"]);
	});

	test("plans re-sync when source session mtime moves forward", () => {
		const registryPath = join(tempRoot, "registry.json");
		const registry = loadImportRegistry(registryPath);
		const source = listSessions(piSessionsDir).find((session) => session.id === "019pi-a")!;
		recordSyncedSession(registry, {
			source: { ...source, mtimeMs: source.mtimeMs - 1000 },
			targetSessionFile: "/tmp/omp-target.jsonl",
			targetRuntime: "omp",
			messageCount: 2,
			skippedCount: 0,
		});
		const plan = planBulkSync(piSessionsDir, registry, { sourceRuntime: "pi", targetRuntime: "omp", limit: 50 });
		expect(plan.toImport.map((session) => session.id).sort()).toContain("019pi-a");
	});

	test("formats status with imported targets and pending sessions", () => {
		const registryPath = join(tempRoot, "registry.json");
		const registry = loadImportRegistry(registryPath);
		const source = listSessions(piSessionsDir).find((session) => session.id === "019pi-a")!;
		recordSyncedSession(registry, {
			source,
			targetSessionFile: "/tmp/omp-target.jsonl",
			targetRuntime: "omp",
			messageCount: 2,
			skippedCount: 0,
		});
		saveImportRegistry(registryPath, registry);
		const status = formatImportStatus(planBulkSync(piSessionsDir, registry, { sourceRuntime: "pi", targetRuntime: "omp", limit: 50 }), registry, "omp");
		expect(status).toContain("Imported: 1");
		expect(status).toContain("Pending: 1");
		expect(status).toContain("019pi-a");
		expect(status).toContain("/tmp/omp-target.jsonl");
		expect(status).toContain("019pi-b");
	});
});

describe("canonical lineage detection", () => {
	test("uuidv5 produces RFC4122 DNS test vector for cross-implementation parity", () => {
		expect(uuidv5("www.example.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("74738ff5-5367-5958-9aee-98fffdcd1876");
	});

	test("canonical namespace matches opencode-import for cross-package parity", () => {
		expect(CANONICAL_NAMESPACE_UUID).toBe("6e7b9c2a-3f4d-5e1f-a8b7-1c2d3e4f5a6b");
	});

	test("canonicalIdFor preserves native UUIDs and derives UUIDv5 for opencode lineage", () => {
		expect(canonicalIdFor("pi", "019e31c8-3708-712e-bec1-9b175acc32f9")).toBe("019e31c8-3708-712e-bec1-9b175acc32f9");
		expect(canonicalIdFor("opencode", "ses_alpha")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}/);
	});

	test("detectLineage falls back to source runtime + id when no import marker present", () => {
		const file = join(piSessionsDir, "--repo--", "pi-a.jsonl");
		const lineage = detectLineage(file, "pi");
		expect(lineage).toEqual({ lineageRuntime: "pi", lineageId: "019pi-a", canonicalId: "019pi-a" });
	});

	test("detectLineage reads opencode-import custom_message marker and preserves canonical id", () => {
		const file = join(piSessionsDir, "--imported--", "imported.jsonl");
		const opencodeId = "ses_omg_yes";
		const canonical = canonicalIdFor("opencode", opencodeId);
		writeJsonl(file, [
			piHeader(canonical, "/imported"),
			{
				type: "custom_message",
				customType: "opencode-import",
				content: "imported",
				display: true,
				details: { source: "opencode", lineageRuntime: "opencode", lineageId: opencodeId, canonicalId: canonical },
				id: "marker",
				parentId: null,
				timestamp: new Date(2).toISOString(),
			},
		]);
		const lineage = detectLineage(file, "pi");
		expect(lineage).toEqual({ lineageRuntime: "opencode", lineageId: opencodeId, canonicalId: canonical });
	});

	test("findSessionFileByCanonicalId locates a file whose UUID matches", () => {
		const sessionDir = join(tempRoot, "dedupe-target");
		mkdirSync(sessionDir, { recursive: true });
		const id = canonicalIdFor("opencode", "ses_dedupe");
		const file = join(sessionDir, `2026-05-17T00-00-00-000Z_${id}.jsonl`);
		writeFileSync(file, "");
		expect(findSessionFileByCanonicalId(sessionDir, id)).toBe(file);
		expect(findSessionFileByCanonicalId(sessionDir, "00000000-0000-0000-0000-000000000000")).toBeUndefined();
	});
});
