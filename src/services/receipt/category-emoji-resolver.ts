/**
 * Async category emoji resolver with LLM fallback.
 *
 * When a user-defined category has no exact entry in CATEGORY_EMOJIS, we ask
 * an LLM to pick the best-matching known emoji key, optionally biased by the
 * group's /prompt (participants, custom terms). Result is cached in SQLite
 * keyed on (group_id, category) so the LLM is called once per unknown category
 * per group.
 *
 * Virtual keys are used for concepts that aren't in the static map:
 *   __person_man__   → 👨   (adult male name)
 *   __person_woman__ → 👩   (adult female name)
 *   __person_boy__   → 👦   (boy name)
 *   __person_girl__  → 👧   (girl name)
 *   __person_baby__  → 👶   (infant/toddler)
 *   __fallback__     → 💰   (unknown, no reasonable match)
 */
import { InferenceClient } from '@huggingface/inference';
import {
  CATEGORY_EMOJIS,
  DEFAULT_CATEGORY_EMOJI,
  getCategoryEmoji,
} from '../../config/category-emojis';
import { env } from '../../config/env';
import { database } from '../../database';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('category-emoji-resolver');

const client = new InferenceClient(env.HF_TOKEN);

const LLM_MODEL = 'Qwen/Qwen3-32B';
const LLM_PROVIDER = 'cerebras';

const VIRTUAL_EMOJIS: Record<string, string> = {
  __person_man__: '👨',
  __person_woman__: '👩',
  __person_boy__: '👦',
  __person_girl__: '👧',
  __person_baby__: '👶',
  __fallback__: DEFAULT_CATEGORY_EMOJI,
};

/**
 * Resolve emoji for a category name. Tries in order:
 * 1. Exact match in CATEGORY_EMOJIS (case-insensitive) — returned fast.
 * 2. Cached LLM resolution for this (group, category).
 * 3. Fresh LLM call (if HF_TOKEN is configured). One retry on failure.
 * 4. Default emoji.
 *
 * Paths 2-4 write to the cache, so repeat lookups never hit the LLM.
 */
export async function resolveCategoryEmoji(category: string, groupId: number): Promise<string> {
  const trimmed = category.trim();
  if (!trimmed) return DEFAULT_CATEGORY_EMOJI;

  const exact = lookupExact(trimmed);
  if (exact) return exact;

  const cached = database.categoryEmojiCache.get(groupId, trimmed);
  if (cached) return cached;

  if (env.HF_TOKEN) {
    const match = await matchWithLLM(trimmed, groupId);
    if (match) {
      database.categoryEmojiCache.set(groupId, trimmed, match.emoji, match.key);
      return match.emoji;
    }
  }

  database.categoryEmojiCache.set(groupId, trimmed, DEFAULT_CATEGORY_EMOJI, null);
  return DEFAULT_CATEGORY_EMOJI;
}

/**
 * Resolve emojis for many categories at once — useful when formatting a
 * receipt summary. Deduplicates inputs before hitting cache/LLM.
 */
export async function resolveCategoryEmojis(
  categories: readonly string[],
  groupId: number,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = Array.from(new Set(categories.map((c) => c.trim()).filter(Boolean)));
  for (const cat of unique) {
    result.set(cat, await resolveCategoryEmoji(cat, groupId));
  }
  return result;
}

function lookupExact(category: string): string | null {
  const direct = CATEGORY_EMOJIS[category];
  if (direct) return direct;

  const lower = category.toLowerCase();
  for (const [key, emoji] of Object.entries(CATEGORY_EMOJIS)) {
    if (key.toLowerCase() === lower) return emoji;
  }
  return null;
}

async function matchWithLLM(
  category: string,
  groupId: number,
): Promise<{ emoji: string; key: string } | null> {
  const knownKeys = Object.keys(CATEGORY_EMOJIS);
  const virtualKeys = Object.keys(VIRTUAL_EMOJIS);
  const allowedKeys = [...knownKeys, ...virtualKeys];

  const group = database.groups.findById(groupId);
  const customPrompt = group?.custom_prompt?.trim() ?? '';

  const systemPrompt = buildSystemPrompt(allowedKeys);
  const userPrompt = buildUserPrompt(category, customPrompt);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await client.chatCompletion({
        provider: LLM_PROVIDER,
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 200,
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content?.trim() ?? '';
      if (!content) {
        logger.warn({ data: { category, attempt } }, 'LLM returned empty content');
        continue;
      }

      const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const jsonMatch =
        cleaned.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ?? cleaned.match(/(\{[\s\S]*\})/);
      if (!jsonMatch?.[1]) {
        logger.warn(
          { data: { category, attempt, content: cleaned.slice(0, 200) } },
          'No JSON in LLM response',
        );
        continue;
      }

      const parsed = JSON.parse(jsonMatch[1]) as { matched_key?: unknown };
      const key = typeof parsed.matched_key === 'string' ? parsed.matched_key : '';
      const emoji = resolveKey(key);
      if (!emoji) {
        logger.warn(
          { data: { category, attempt, key } },
          'LLM picked a key not in the allowed set',
        );
        continue;
      }

      logger.info({ data: { category, key, emoji, attempt } }, 'LLM emoji match');
      return { emoji, key };
    } catch (err) {
      logger.warn({ err, data: { category, attempt } }, 'LLM emoji resolve failed');
    }
  }

  return null;
}

function resolveKey(key: string): string | null {
  if (!key) return null;
  if (VIRTUAL_EMOJIS[key]) return VIRTUAL_EMOJIS[key];
  if (CATEGORY_EMOJIS[key]) return CATEGORY_EMOJIS[key];
  const lower = key.toLowerCase();
  for (const [k, emoji] of Object.entries(CATEGORY_EMOJIS)) {
    if (k.toLowerCase() === lower) return emoji;
  }
  return null;
}

function buildSystemPrompt(allowedKeys: string[]): string {
  return `Ты подбираешь эмоджи для пользовательской категории трат.
Верни ТОЛЬКО JSON вида: {"matched_key": "<ключ>"}
Ключ должен быть ровно одним из списка разрешённых ниже.
Никакого текста вне JSON, никаких markdown-блоков, никаких пояснений.

Правила выбора:
1. Если в контексте группы явно указано, чему соответствует категория — используй это (например, если написано «Ку — это коммунальные услуги», верни "Коммуналка").
2. Если категория — имя человека: определи пол и возраст по контексту и имени, верни __person_man__ / __person_woman__ / __person_boy__ / __person_girl__ / __person_baby__. Без контекста — по стандартному значению имени (Алексей → мужчина, Елена → женщина).
3. Если категория — конкретный вид питомца (кот, собака, хомяк, рыбки и т.п.) — подбирай ключ этого вида (Кот, Собака, Хомяк, Рыбки). Для общего "питомцы" — Питомцы.
4. Если категория — бытовая статья расхода, совпадающая по смыслу с одним из ключей — выбери самый близкий (например, "Расходыквартиры" → "Коммуналка").
5. Если совсем ничего не подходит — верни "__fallback__".

Разрешённые ключи (выбирай ТОЧНО один из этих строк):
${allowedKeys.join(', ')}`;
}

function buildUserPrompt(category: string, customPrompt: string): string {
  const contextBlock = customPrompt ? `Контекст группы (/prompt):\n${customPrompt}\n\n` : '';
  return `${contextBlock}Категория: "${category}"\nВерни JSON с matched_key.`;
}

export { getCategoryEmoji };
