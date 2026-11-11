import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { TONES, isToneId, toneLabel, withTone, type ToneId, type ToneSetting } from "./tones.ts";
import { readTone, writeTone } from "./settings.ts";

const SETTINGS_FILE_NAME = "tone-of-voice.json";
const STATUS_KEY = "tone-of-voice";
const OFF_LABEL = "Выключено";

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function toneOfVoice(pi: ExtensionAPI): void {
	// Состояние живёт в замыкании фабрики, а не в переменных модуля.
	let activeTone: ToneSetting = "off";

	// Ленивый путь: вычисляется только внутри обработчиков, прошедших main-guard.
	const settingsPath = (): string => join(pi.pi.getAgentDir(), SETTINGS_FILE_NAME);

	const applyStatus = (ctx: ExtensionContext): void => {
		if (activeTone === "off") ctx.ui.setStatus(STATUS_KEY, undefined);
		else ctx.ui.setStatus(STATUS_KEY, `Тон: ${toneLabel(activeTone)}`);
	};

	const loadFromDisk = async (ctx: ExtensionContext): Promise<void> => {
		try {
			activeTone = await readTone(settingsPath());
		} catch (error) {
			activeTone = "off";
			ctx.ui.notify(`Не удалось прочитать тон: ${describeError(error)}`, "warning");
		}
		applyStatus(ctx);
	};

	const enableTone = async (tone: ToneId, ctx: ExtensionContext): Promise<void> => {
		try {
			await writeTone(settingsPath(), tone);
		} catch (error) {
			ctx.ui.notify(`Не удалось сохранить тон: ${describeError(error)}`, "error");
			return;
		}
		activeTone = tone;
		applyStatus(ctx);
		ctx.ui.notify(`Тон: ${toneLabel(tone)}. Сохранено для новых бесед.`, "info");
	};

	const disableTone = async (ctx: ExtensionContext): Promise<void> => {
		// Отключение в текущей сессии не зависит от прав записи.
		activeTone = "off";
		ctx.ui.setStatus(STATUS_KEY, undefined);
		try {
			await writeTone(settingsPath(), "off");
			ctx.ui.notify("Тон выключен. Сохранено для новых бесед.", "info");
		} catch (error) {
			ctx.ui.notify(
				`Тон выключен в текущей сессии, но не удалось сохранить отключение: ${describeError(error)}`,
				"error",
			);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		await loadFromDisk(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		// Перечитываем глобальное состояние, а не исторический тон старой ветки.
		if (ctx.agent.kind !== "main") return;
		await loadFromDisk(ctx);
	});

	pi.registerCommand("tone", {
		description: "Выбрать или выключить тон общения",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (ctx.agent.kind !== "main") return;
			const trimmed = args.trim();
			if (trimmed === "") {
				if (ctx.mode === "tui" && ctx.hasUI) {
					const options: string[] = [OFF_LABEL, ...TONES.map((tone) => tone.label)];
					const initialIndex = activeTone === "off" ? 0 : TONES.findIndex((tone) => tone.id === activeTone) + 1;
					const choice = await ctx.ui.select("Тон общения", options, { initialIndex });
					if (choice === undefined) return;
					if (choice === OFF_LABEL) {
						await disableTone(ctx);
						return;
					}
					const chosen = TONES.find((tone) => tone.label === choice);
					if (chosen) await enableTone(chosen.id, ctx);
					return;
				}
				const current = activeTone === "off" ? "Тон выключен." : `Тон: ${toneLabel(activeTone)}.`;
				ctx.ui.notify(`${current} Используйте /tone off, /tone technical, /tone roast, /tone gopnik или /tone sweetheart`, "info");
				return;
			}
			const normalized = trimmed.toLowerCase();
			if (normalized === "off") {
				await disableTone(ctx);
				return;
			}
			if (!isToneId(normalized)) {
				ctx.ui.notify(
					"Неизвестный тон. Используйте /tone off, /tone technical, /tone roast, /tone gopnik или /tone sweetheart",
					"warning",
				);
				return;
			}
			await enableTone(normalized, ctx);
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		if (event.reason === "revive") return undefined;
		if (activeTone === "off") return undefined;
		return { systemPrompt: withTone(event.systemPrompt, activeTone) };
	});
}
