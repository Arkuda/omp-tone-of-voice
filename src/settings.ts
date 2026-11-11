import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isToneSetting, type ToneSetting } from "./tones.ts";

function invalidFileError(filePath: string): Error {
	return new Error(`Некорректный файл тона: ${filePath}`);
}

/**
 * Единственный легальный «нет файла» случай — ENOENT, означающий `off`.
 * Пустой файл, битый JSON, не-объект и неизвестный `tone` — ошибка; чтение никогда
 * не исправляет файл. Неизвестные дополнительные поля игнорируются.
 */
export async function readTone(filePath: string): Promise<ToneSetting> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "off";
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw invalidFileError(filePath);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw invalidFileError(filePath);
	}
	const tone = (parsed as Record<string, unknown>).tone;
	if (!isToneSetting(tone)) throw invalidFileError(filePath);
	return tone;
}

/**
 * Атомарная замена: уникальный соседний tmp-файл + rename. При ошибке удаляется
 * только собственный tmp; старый целевой файл остается нетронутым, исходная ошибка
 * пробрасывается без маскирования.
 */
export async function writeTone(filePath: string, tone: ToneSetting): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmpPath, `${JSON.stringify({ tone })}\n`, "utf8");
		await rename(tmpPath, filePath);
	} catch (error) {
		await unlink(tmpPath).catch(() => {});
		throw error;
	}
}
