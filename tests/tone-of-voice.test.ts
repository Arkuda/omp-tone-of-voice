import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import toneOfVoice from "../src/index.ts";
import { writeTone } from "../src/settings.ts";
import { withTone, type ToneId } from "../src/tones.ts";

const SETTINGS_FILE = "tone-of-voice.json";
const STATUS_KEY = "tone-of-voice";

interface Notification {
	message: string;
	type?: string;
}

interface HarnessOptions {
	agentDir: string;
	kind?: "main" | "sub";
	id?: string;
	name?: string;
	depth?: number;
	mode?: "tui" | "print";
	hasUI?: boolean;
}

/** Минимальный host-стенд: захватывает обработчики/команду, подменяет getAgentDir и UI. */
function createHarness(options: HarnessOptions) {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notifications: Notification[] = [];
	const statuses = new Map<string, string | undefined>();
	const selectCalls: { title: string; options: string[]; initialIndex?: number }[] = [];
	let agentDir = options.agentDir;
	let selectResult: string | undefined;

	const pi = {
		pi: { getAgentDir: () => agentDir },
		on(event: string, handler: (event: any, ctx: unknown) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, opts: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, opts);
		},
	};
	toneOfVoice(pi as never);

	const agent = {
		kind: options.kind ?? "main",
		id: options.id ?? "Main",
		name: options.name ?? "main",
		depth: options.depth ?? 0,
	};
	const ctx = {
		agent,
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui: {
			async select(title: string, opts: string[], dialogOptions?: { initialIndex?: number }) {
				selectCalls.push({ title, options: opts, initialIndex: dialogOptions?.initialIndex });
				return selectResult;
			},
			setStatus(key: string, text: string | undefined) {
				statuses.set(key, text);
			},
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
	};

	async function fire(event: string, payload: Record<string, unknown> = {}): Promise<void> {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
	}

	async function prepare(base: readonly string[], reason: "prompt" | "revive" = "prompt") {
		let result: { systemPrompt?: string[] } | undefined;
		for (const handler of handlers.get("before_agent_start") ?? []) {
			const outcome = await handler({ type: "before_agent_start", reason, prompt: "", systemPrompt: base }, ctx);
			if (outcome !== undefined) result = outcome as { systemPrompt?: string[] };
		}
		return result;
	}

	return {
		notifications,
		statuses,
		selectCalls,
		setAgentDir(dir: string) {
			agentDir = dir;
		},
		setSelectResult(value: string | undefined) {
			selectResult = value;
		},
		fire,
		prepare,
		async tone(args: string) {
			await commands.get("tone")!.handler(args, ctx);
		},
	};
}

function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "tone-of-voice-test-"));
}

function settingsPath(dir: string): string {
	return join(dir, SETTINGS_FILE);
}

async function readSettingsBytes(dir: string): Promise<Buffer> {
	return readFile(settingsPath(dir));
}

const BASE_PROMPT = ["base block one", "base block two"];

function toneBlocks(systemPrompt: readonly string[]): string[] {
	return systemPrompt.filter((block) => block.startsWith("<tone-of-voice "));
}

test("sweetheart survives a fresh factory via session_start and lands as the only appended block", async () => {
	const dir = await tempDir();
	const first = createHarness({ agentDir: dir });
	await first.tone("sweetheart");
	assert.equal((await readSettingsBytes(dir)).toString("utf8"), '{"tone":"sweetheart"}\n');
	assert.equal(first.statuses.get(STATUS_KEY), "Тон: Влюблённая девушка");

	const second = createHarness({ agentDir: dir });
	await second.fire("session_start");
	const base = [...BASE_PROMPT];
	const snapshot = [...base];
	const result = await second.prepare(base);
	assert.ok(result?.systemPrompt);
	assert.equal(result.systemPrompt.length, 3);
	assert.deepEqual(result.systemPrompt.slice(0, 2), snapshot);
	assert.equal(toneBlocks(result.systemPrompt).length, 1);
	assert.ok(result.systemPrompt[2].startsWith('<tone-of-voice mode="sweetheart">'));
	assert.ok(result.systemPrompt[2].endsWith("</tone-of-voice>"));
	assert.deepEqual(base, snapshot, "исходный массив не должен изменяться");
});

test("off → each tone → off: only the current block, no accumulation, clean off", async () => {
	const dir = await tempDir();
	const harness = createHarness({ agentDir: dir });
	const base = [...BASE_PROMPT];

	assert.equal(await harness.prepare(base), undefined);

	for (const id of ["technical", "roast", "gopnik", "sweetheart"] satisfies ToneId[]) {
		await harness.tone(id);
		const first = await harness.prepare(base);
		const second = await harness.prepare(base);
		assert.ok(first?.systemPrompt && second?.systemPrompt);
		for (const systemPrompt of [first.systemPrompt, second.systemPrompt]) {
			assert.equal(systemPrompt.length, 3);
			assert.deepEqual(toneBlocks(systemPrompt).length, 1, `тон ${id}: ровно один собственный блок`);
			assert.ok(toneBlocks(systemPrompt)[0].startsWith(`<tone-of-voice mode="${id}">`));
		}
		assert.deepEqual(second.systemPrompt, first.systemPrompt, "повторная подготовка не накапливает блок");
	}

	await harness.tone("off");
	const beforeOff = [...base];
	assert.equal(await harness.prepare(base), undefined);
	assert.deepEqual(base, beforeOff);
	assert.equal(harness.statuses.get(STATUS_KEY), undefined);

	await harness.fire("session_switch");
	assert.equal(await harness.prepare(base), undefined, "сохраненный off не откатывается после смены беседы");
});

test("menu choice maps to state; cancel keeps file and policy byte-identical", async () => {
	const dir = await tempDir();
	const harness = createHarness({ agentDir: dir });

	harness.setSelectResult("Гопник");
	await harness.tone("");
	assert.equal((await readSettingsBytes(dir)).toString("utf8"), '{"tone":"gopnik"}\n');
	assert.equal(harness.statuses.get(STATUS_KEY), "Тон: Гопник");
	assert.deepEqual(harness.selectCalls[0].options, ["Выключено", "Технарь", "Унижающий", "Гопник", "Влюблённая девушка"]);

	await harness.tone("roast");
	const bytesBeforeCancel = await readSettingsBytes(dir);
	harness.setSelectResult(undefined);
	await harness.tone("");
	assert.deepEqual(await readSettingsBytes(dir), bytesBeforeCancel, "отмена не пишет файл");
	const result = await harness.prepare([...BASE_PROMPT]);
	assert.ok(result?.systemPrompt && toneBlocks(result.systemPrompt)[0].includes('mode="roast"'));

	// Курсор меню открывается на текущем состоянии (roast → индекс 2).
	harness.setSelectResult(undefined);
	await harness.tone("");
	assert.equal(harness.selectCalls.at(-1)?.initialIndex, 2);
});

test("unknown id and multi-word args warn without changing state or file", async () => {
	const dir = await tempDir();
	const harness = createHarness({ agentDir: dir });
	await harness.tone("technical");
	const bytesBefore = await readSettingsBytes(dir);

	for (const args of ["bogus", "off extra", "TECHNICAL roast"]) {
		harness.notifications.length = 0;
		await harness.tone(args);
		assert.ok(harness.notifications.some((note) => note.type === "warning"), `аргумент «${args}» даёт warning`);
	}
	assert.deepEqual(await readSettingsBytes(dir), bytesBefore);
	const result = await harness.prepare([...BASE_PROMPT]);
	assert.ok(result?.systemPrompt && toneBlocks(result.systemPrompt)[0].includes('mode="technical"'));
});

test("corrupt settings warn at startup, disable influence, and are not rewritten", async () => {
	for (const contents of ['{"tone":"nope"}\n', "{oops\n", "\n"]) {
		const dir = await tempDir();
		await writeFile(settingsPath(dir), contents, "utf8");
		const bytesBefore = await readSettingsBytes(dir);
		const harness = createHarness({ agentDir: dir });
		harness.notifications.length = 0;
		await harness.fire("session_start");
		assert.ok(harness.notifications.some((note) => note.type === "warning"), `содержимое ${JSON.stringify(contents)} даёт warning`);
		assert.equal(await harness.prepare([...BASE_PROMPT]), undefined, "битый файл не добавляет override");
		assert.deepEqual(await readSettingsBytes(dir), bytesBefore, "чтение не исправляет файл");

		await harness.tone("technical");
		assert.equal((await readSettingsBytes(dir)).toString("utf8"), '{"tone":"technical"}\n');
	}
});

test("missing file means off with no file creation; stored off gives no override", async () => {
	const dir = await tempDir();
	const harness = createHarness({ agentDir: dir });
	harness.notifications.length = 0;
	await harness.fire("session_start");
	assert.deepEqual(harness.notifications, []);
	assert.equal(await harness.prepare([...BASE_PROMPT]), undefined);
	assert.deepEqual(await readdir(dir), [], "отсутствие файла не создает его");

	const other = await tempDir();
	await writeFile(settingsPath(other), '{"tone":"off"}\n', "utf8");
	const fresh = createHarness({ agentDir: other });
	await fresh.fire("session_start");
	assert.equal(await fresh.prepare([...BASE_PROMPT]), undefined);
});

test("write failure keeps previous policy; off stays off even when saving fails", async () => {
	const root = await tempDir();
	const blocker = join(root, "blocker");
	await writeFile(blocker, "не каталог", "utf8");
	const blockedPath = join(blocker, SETTINGS_FILE);
	await assert.rejects(writeTone(blockedPath, "roast"), (error: Error) => error.message.length > 0);

	const harness = createHarness({ agentDir: blocker });
	harness.notifications.length = 0;
	await harness.tone("technical");
	assert.ok(harness.notifications.some((note) => note.type === "error"));
	assert.equal(await harness.prepare([...BASE_PROMPT]), undefined, "сбой записи не включает тон");

	const goodDir = await tempDir();
	const live = createHarness({ agentDir: goodDir });
	await live.tone("roast");
	const roastBytes = await readSettingsBytes(goodDir);
	live.setAgentDir(blocker);
	live.notifications.length = 0;
	await live.tone("off");
	assert.ok(live.notifications.some((note) => note.type === "error"), "ошибка сохранения отключения видна");
	assert.equal(await live.prepare([...BASE_PROMPT]), undefined, "отключение действует, даже если запись упала");
	assert.deepEqual(await readSettingsBytes(goodDir), roastBytes, "старый файл не тронут");
});

test("subagent sessions never see IO, UI, or prompt overrides while main keeps its tone", async () => {
	const dir = await tempDir();
	const main = createHarness({ agentDir: dir });
	await main.tone("roast");
	const roastBytes = await readSettingsBytes(dir);

	for (const variant of [
		{ kind: "sub" as const, id: "advisor", name: "advisor", depth: 0 },
		{ kind: "sub" as const, id: "0-clone", name: "sub", depth: 0 },
	]) {
		const sub = createHarness({ agentDir: dir, ...variant });
		await sub.fire("session_start");
		await sub.fire("session_switch");
		await sub.tone("gopnik");
		assert.equal(await sub.prepare([...BASE_PROMPT]), undefined);
		assert.equal(await sub.prepare([...BASE_PROMPT], "revive"), undefined);
		assert.deepEqual(sub.notifications, [], "sub-сессия без уведомлений");
		assert.equal(sub.statuses.size, 0, "sub-сессия не трогает статус");
		assert.deepEqual(sub.selectCalls, [], "sub-сессия не открывает меню");
	}

	assert.deepEqual(await readSettingsBytes(dir), roastBytes, "sub-сессия не пишет настройки");
	const mainResult = await main.prepare([...BASE_PROMPT]);
	assert.ok(mainResult?.systemPrompt && toneBlocks(mainResult.systemPrompt)[0].includes('mode="roast"'));
	assert.equal(await main.prepare([...BASE_PROMPT], "revive"), undefined, "revive не добавляет override и в main");
});

test("headless empty command reports state without opening select", async () => {
	const dir = await tempDir();
	const harness = createHarness({ agentDir: dir, mode: "print", hasUI: false });
	await harness.tone("gopnik");
	const bytesBefore = await readSettingsBytes(dir);
	harness.notifications.length = 0;
	await harness.tone("");
	assert.deepEqual(harness.selectCalls, [], "headless не открывает диалог");
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0].message, /Гопник/);
	assert.deepEqual(await readSettingsBytes(dir), bytesBefore);
});

test("withTone appends a framed block without mutating the input", () => {
	const base = ["first", "second"];
	const snapshot = [...base];
	const result = withTone(base, "gopnik");
	assert.notEqual(result, base);
	assert.deepEqual(base, snapshot);
	assert.equal(result.length, 3);
	assert.ok(result[2].startsWith('<tone-of-voice mode="gopnik">\n'));
	assert.ok(result[2].endsWith("\n</tone-of-voice>"));
});
