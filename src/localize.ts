import en from "./translations/en.json";
import fr from "./translations/fr.json";

export type TranslationKey = keyof typeof en;

const LANGUAGES: Record<string, Record<TranslationKey, string>> = { en, fr };

/** Looks up a text in the user's language, falling back to English. */
export function localize(
  hass: { locale?: { language: string } } | undefined,
  key: TranslationKey,
  vars?: Record<string, string>,
): string {
  const language = hass?.locale?.language ?? "en";
  const texts = LANGUAGES[language] ?? LANGUAGES[language.split("-")[0]] ?? en;
  const text = texts[key] ?? en[key];
  if (!vars) {
    return text;
  }
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? vars[name] : match,
  );
}
