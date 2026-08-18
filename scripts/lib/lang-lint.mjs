// scripts/lib/lang-lint.mjs
//
// AC-19 언어 린트: career/knowledge-map/gap-report/plan 스키마에서
// `x-freeText: true`로 표시된 필드의 실제 값을 검사해, 공백 구분 토큰이
// 4개 이상인 서술형 값인데 한글이 0자면 위반으로 보고한다.
//
// 판정 단위를 "문장"이 아니라 "필드 값"으로 고정한다(스펙 AC-19) — 문장
// 분리기를 자작하면 `Node.js`·`v1.2`·`e.g.`·`3.5배` 같은 토큰에서 오분할이
// 발생하기 때문이다.
//
// `x-termField: true`(기술 용어·고유명사)와 `x-verbatim: true`(원문 보존)
// 필드는 스키마에 `x-freeText`가 함께 붙지 않으므로 애초에 대상에서
// 제외된다 — collectFreeTextPaths가 x-freeText 마커만 수집하기 때문에
// 별도 예외 처리 없이 구조적으로 빠진다.

import { resolveRef } from "./schema-validate.mjs";

const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏]/;

/**
 * 스키마 트리를 순회해 x-freeText:true 인 string 필드의 경로 목록을
 * 반환한다. 경로는 문자열 토큰 배열이며 배열 항목 자리는 '[]'로 표시한다
 * (예: ["nodes", "[]", "text"]).
 *
 * $ref는 #/$defs/Name 형태만 해석한다(schema-validate.mjs와 동일 한계).
 * 순환 참조 방어를 위해 깊이 상한을 둔다 — 이 프로젝트의 스키마들은
 * 재귀 구조가 아니므로 실제로는 도달하지 않는다.
 */
export function collectFreeTextPaths(schema, root = schema, prefix = [], depth = 0, out = []) {
  if (depth > 30) return out;
  const resolved = resolveRef(schema, root);
  if (!resolved || typeof resolved !== "object") return out;

  if (resolved.type === "string" && resolved["x-freeText"] === true) {
    out.push([...prefix]);
  }
  if (resolved.properties && typeof resolved.properties === "object") {
    for (const [key, sub] of Object.entries(resolved.properties)) {
      collectFreeTextPaths(sub, root, [...prefix, key], depth + 1, out);
    }
  }
  if (resolved.items) {
    collectFreeTextPaths(resolved.items, root, [...prefix, "[]"], depth + 1, out);
  }
  return out;
}

/** instance에서 path 패턴(배열 자리는 '[]'로 확장)에 해당하는 값들을 모두 뽑는다. */
export function getValuesAtPath(instance, pathTokens) {
  let current = [instance];
  for (const token of pathTokens) {
    const next = [];
    for (const c of current) {
      if (c == null) continue;
      if (token === "[]") {
        if (Array.isArray(c)) next.push(...c);
      } else if (typeof c === "object" && !Array.isArray(c) && token in c) {
        next.push(c[token]);
      }
    }
    current = next;
  }
  return current;
}

/**
 * schema가 정의하는 x-freeText 필드들의 실제 instance 값을 검사해 위반
 * 목록을 반환한다. 각 위반: { path: 'nodes[].text', value: '...' }
 */
export function lintFreeText(schema, instance) {
  const paths = collectFreeTextPaths(schema);
  const violations = [];
  for (const p of paths) {
    const values = getValuesAtPath(instance, p);
    for (const value of values) {
      if (typeof value !== "string") continue;
      const tokens = value.trim().split(/\s+/).filter(Boolean);
      if (tokens.length >= 4 && !HANGUL_RE.test(value)) {
        violations.push({ path: p.join(".").replace(/\.\[\]/g, "[]"), value });
      }
    }
  }
  return violations;
}
