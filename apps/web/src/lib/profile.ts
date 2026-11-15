/**
 * "About me" profile API contract (task 4.6), shared by the route handlers and the browser.
 *
 * | Method | Path          | Body               | Result |
 * |--------|---------------|--------------------|--------|
 * | GET    | /api/profile  | –                  | {@link ProfileDto} |
 * | PUT    | /api/profile  | {@link ProfileInput} | {@link ProfileDto} |
 *
 * Always the session user's own profile: the API takes no user id. Enhance and chat pass it to the AI as
 * data (`<oat:about_me>`, `<oat:vocabulary>`), and `POST /api/stt/token` returns the terms as `keyterms`.
 */

/** Same limits as `@oat/db` `PROFILE_LIMITS` (checked by a unit test; this file stays client-safe). */
export const PROFILE_LIMITS = {
  name: 100,
  role: 100,
  team: 100,
  about: 1000,
  vocabularyTerms: 100,
  vocabularyTermLength: 60,
} as const;

export type ProfileDto = {
  name: string;
  email: string;
  role: string;
  team: string;
  /** "What I care about". */
  about: string;
  /** Names and terms to spell correctly. */
  vocabulary: string[];
  updatedAt: string | null;
};

export type ProfileInput = {
  name: string;
  role: string;
  team: string;
  about: string;
  vocabulary: string[];
};

/** One term per line or comma → the list the API takes (empties dropped; the server normalises the rest). */
export function parseVocabulary(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}
