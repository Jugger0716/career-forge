// scripts/lib/secret-scan.mjs
//
// 구현 7단계 (e) / 슬라이스 B 스펙 심사 C-2 / 착수 전 게이트 C-1.
//
// **왜 이 파일이 있는가.** `scripts/lib/redact.mjs`는 수집기가 원장을 쓸 때
// 적용하는 **마스킹 함수**이지, 이미 만들어진 산출물에서 시크릿을 **탐지해
// REJECT를 내는 검사기**가 아니었다. 그래서 AC-8의 「마스킹 우회 시크릿」
// 10건은 REJECT 사유 문자열을 출력할 코드가 프로덕션에 0곳인 채로 선언만
// 돼 있었고(심사 C-2의 실측: `grep -ni 'redact|secret|mask'
// scripts/verify-evidence.mjs` → 0건), 그대로 두면 오염 스위트가 자기
// 채점기를 자기가 만드는 자기충족 구조가 된다. 이 모듈이 그 채점 대상이
// 되는 프로덕션 검사 지점이다.
//
// **호출자는 둘이다(2026-09-28부터).** `scripts/validate-plugin.mjs --secret-scan`
// (두 SKILL.md의 마스킹 검사 단계)과 `scripts/render-markdown.mjs`(렌더 직전
// 재검사 — 도그푸딩 1회차 결함 ④)다. 그 전까지는 앞의 것이 유일한 호출자였고,
// 그래서 마스킹 검사 단계를 건너뛰거나 그 FAIL을 무시하면 걸린 문자열이 사용자
// 문서에 그대로 실렸다(실측). **두 호출자는 같은 스키마로 이 함수를 그대로 불러야
// 한다** — 한쪽이 패턴을 거르거나 스키마를 달리 고르는 순간 「앞 단계는 막는데
// 렌더는 통과시키는」 조합이 다시 생긴다. 두 판정의 일치는 `(RV-11)`이 관측한다.
//
// **패턴은 새로 만들지 않는다.** `redact.mjs`의 `redactSecrets()`를 그대로
// 호출하고 그 반환값의 `hits`(패턴 이름 + 횟수)를 판정에 쓴다. 패턴을 여기
// 복사하면 마스킹 규칙이 두 곳으로 갈라지고, 그 순간 "수집기는 가리는데
// 검사기는 못 잡는" 조합이 생긴다 — redact.mjs 머리말이 경고한 바로 그
// 형태다. 이 모듈은 redact.mjs를 **수정하지 않는다**(`slice_plan.md`의
// 슬라이스 A 파일 수정 예외 3건에 redact.mjs는 없다).
//
// ---------------------------------------------------------------------------
// 검사 범위와 그 근거 — "전부 스캔"이 왜 틀렸는가
// ---------------------------------------------------------------------------
//
// 산출물 전체를 원시 텍스트로 스캔하면 **정상 산출물이 빨갛게 된다**:
// evidence.json의 `commits[].authorEmail`과 모든 L1+ 산출물의
// `coverage.exclusions.selectedIdentities[]`는 스키마가 `format: "email"`로
// 선언한 **합법적인 이메일 필드**인데 redact.mjs의 `email` 패턴이 여기서
// 반드시 발화한다. 게이트가 정상 출력에서 빨갛게 되면 남는 선택지는
// "게이트를 끄는 것"뿐이고, 그건 스펙 리스크 절이 지목한 검증 우회 경로다
// (lang-lint.mjs가 `origin: "user"` 제외를 넣은 것과 정확히 같은 이유).
//
// 그렇다고 `x-freeText` 필드만 스캔하는 것도 틀렸다. 그건 **fail-open**이다 —
// 새 필드가 추가될 때 마커를 안 붙이면 조용히 검사 대상에서 빠진다. 시크릿
// 미탐은 프라이버시 사고이고 오탐은 불편일 뿐이므로, 방향은 fail-closed여야
// 한다. AC-11도 "어떤 산출물에도 포함되지 않는다"이지 "free-text 필드에"가
// 아니다.
//
// 그래서 이 모듈은 **모든 문자열을 스캔하되, 면제는 필드 단위가 아니라
// (필드 × 패턴) 단위로 좁게** 준다:
//
//   스키마가 `format: "email"`로 선언한 경로의 값에 한해, **그리고 그 값
//   전체가 단일 이메일일 때에만**, `email` 패턴 히트 하나를 면제한다.
//   나머지 패턴(AWS 키·private key·JWT·password 필드)은 그 경로에서도
//   그대로 발화한다.
//
// 두 조건이 각각 다른 회피를 막는다:
//
//   (1) **패턴 단위 면제** — `format: email` 필드에 AWS 키를 넣는 회피를
//       막는다. 필드 단위로 면제하면 그 필드가 통째로 사각지대가 된다.
//   (2) **값 전체가 이메일일 때만** — `"dev@example.com AKIA..."`처럼 합법
//       이메일에 시크릿을 덧붙이는 회피를 막는다. 이 조건 덕분에 면제가
//       `--schema-check`가 먼저 돌았는지에 **의존하지 않는다**: 스키마
//       선언을 믿는 대신 값 자체를 다시 확인하므로, 자기 스키마 검증(구현
//       7단계 (a))이 아직 배선되지 않은 지금도 면제가 안전하다.
//
// **선언된 한계 — .md 렌더 산출물은 이 검사의 대상이 아니다.** 이 모듈은
// JSON 산출물 + 대응 스키마 쌍에만 적용된다. 사용자 대면 `.md`는
// `scripts/render-markdown.mjs`(구현 7단계)의 렌더 결과이고, 그 렌더 계약이
// "마크다운은 JSON의 뷰이므로 자기 판단으로 값을 만들지 않는다"를 못 박고
// 있으므로 JSON이 깨끗하면 `.md`도 깨끗하다는 것이 근거다. 이것은 **증명이
// 아니라 계약 의존**이다 — 렌더러가 그 계약을 어기면 이 검사는 그 유출을
// 보지 못한다. 렌더러를 만들 때 이 문장을 다시 읽고, 계약 위반 가능성이
// 생기면 스캔 대상을 넓혀라.
//
// **그 한계가 2026-09-28에 좁혀졌다 — 다만 절반이다.** 렌더러가 렌더 직전에 **자기
// 입력 JSON**을 이 함수로 다시 스캔하므로, 이 검사가 거부하는 JSON은 이제 `.md`가 될
// 수 없다(결함 ④). 남은 계약 의존은 둘이다:
//
//   (1) **렌더러가 스스로 조립하는 문구** — JSON 값이 아니라 `render-contract.mjs`의
//       정본 리터럴이며 여기서 스캔되지 않는다.
//   (2) **따로 스캔된 값들이 문서에서 인접하며 새로 이루는 패턴.** 이 함수는 문자열
//       값을 **하나씩** 본다. 렌더러는 노드 id 제목 뒤에 빈 줄을 두고 본문을 잇는데
//       `password-field` 패턴의 `\s*`는 개행을 넘으므로, id가 `…token`으로 끝나고 본문이
//       `: 값`으로 시작하면 **어느 필드에도 없던 패턴이 `.md`에서 성립한다**(적대적 리뷰가
//       실측했다). 거꾸로 말하면 한 시크릿을 두 필드에 쪼개 담는 것은 필드 단위 스캔을
//       통과한다 — 정규식 스캐너가 의도적 분할을 원리상 막지 못하는 것과 같은 계열이다.
//
// `.md` 원문을 스캔하지 않는 이유는 위 「전부 스캔」 절과 같다: 이메일 자리의 값이
// 문서에 실리는 순간 `email` 패턴이 정상 출력에서 발화한다. (2)를 닫으려면 면제를
// 문서 좌표로 옮겨야 하고, 그것은 이 모듈이 아니라 렌더 계약의 일이다.

import { resolveRef } from "./schema-validate.mjs";
import { redactSecrets } from "./redact.mjs";

// schema-validate.mjs의 FORMAT_CHECKERS.email과 동일한 리터럴이다. import
// 하지 않고 복제한 이유: 그 상수는 export 되어 있지 않고, export를 추가하면
// schema-validate.mjs를 수정하게 되는데 그 파일은 `slice_plan.md`의 슬라이스 A
// 파일 수정 예외 3건에 없다. 두 리터럴이 갈리면 면제 판정이 스키마 검증과
// 어긋나므로, 드리프트를 tests/run-smoke.mjs의 오라클이 관측한다.
const FULL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 값 전체가 단일 이메일인가 — 면제 판정의 두 조건 중 하나다.
 *
 * export 하는 이유는 오직 드리프트 관측 때문이다. 위 FULL_EMAIL_RE는
 * schema-validate.mjs의 FORMAT_CHECKERS.email 복제본인데, 그 상수를 직접
 * 비교할 방법이 없으면 두 리터럴이 갈려도 아무도 모른다. tests/run-smoke.mjs가
 * 이 함수와 `validateInstance({type:"string",format:"email"}, v)`의 판정을
 * 경계값으로 대조한다.
 *
 * **간접 관측은 쓰지 마라.** "format:email 경로에 넣고 위반이 나는지"로
 * 이 술어를 재려 하면, redact.mjs의 email 패턴이 애초에 발화하지 않는 값
 * (예: `a@b.c` — 그 패턴은 TLD를 `[A-Za-z]{2,}`로 요구한다)에서 "면제되지
 * 않음"과 "면제할 것이 없음"이 구별되지 않아 오라클이 거짓 FAIL을 낸다.
 */
export function isSingleEmail(value) {
  return FULL_EMAIL_RE.test(String(value).trim());
}

/**
 * 스키마 트리를 순회해 `format: "email"`이 선언된 경로 패턴 목록을 반환한다.
 * 경로는 문자열 토큰 배열이며 배열 항목 자리는 '[]'로 표시한다
 * (예: ["commits", "[]", "authorEmail"]) — lang-lint.mjs의
 * collectFreeTextPaths와 같은 어휘다.
 *
 * collectFreeTextPaths와 두 곳이 다르다:
 *   - `type === "string"` 조건을 걸지 않는다. `authorEmail`은
 *     `"type": ["string", "null"]`이라 그 조건을 걸면 조용히 누락된다
 *     (누락 = 면제 안 됨 = 오탐 방향이므로 안전한 실패이긴 하지만,
 *     정상 원장이 FAIL하는 것은 그 자체로 게이트를 무력화한다).
 *   - `allOf`/`anyOf`/`oneOf`/`then`/`else`도 순회한다. evidence.schema.json은
 *     `excluded: false` 조건절의 `then` 안에서도 authorEmail을 재선언한다.
 *     `if`는 순회하지 않는다 — 그것은 값 계약이 아니라 조건식이다.
 */
export function collectEmailFormatPaths(schema, root = schema, prefix = [], depth = 0, out = []) {
  if (depth > 30) return out;
  const resolved = resolveRef(schema, root);
  if (!resolved || typeof resolved !== "object") return out;

  if (resolved.format === "email") {
    if (!out.some((p) => p.length === prefix.length && p.every((t, i) => t === prefix[i]))) {
      out.push([...prefix]);
    }
  }
  if (resolved.properties && typeof resolved.properties === "object") {
    for (const [key, sub] of Object.entries(resolved.properties)) {
      collectEmailFormatPaths(sub, root, [...prefix, key], depth + 1, out);
    }
  }
  if (resolved.items) {
    collectEmailFormatPaths(resolved.items, root, [...prefix, "[]"], depth + 1, out);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(resolved[key])) {
      for (const sub of resolved[key]) collectEmailFormatPaths(sub, root, prefix, depth + 1, out);
    }
  }
  for (const key of ["then", "else"]) {
    if (resolved[key]) collectEmailFormatPaths(resolved[key], root, prefix, depth + 1, out);
  }
  return out;
}

/**
 * 인스턴스를 순회하며 모든 문자열 값에 대해 cb({ path, value })를 호출한다.
 * `path`는 구체 경로 토큰 배열이며 배열 인덱스는 숫자 그대로 담긴다
 * (예: ["nodes", 0, "text"]). 스키마 패턴과 대조할 때 normalizePath가
 * 숫자를 '[]'로 바꾼다.
 *
 * 객체 키 자체는 검사하지 않는다 — 산출물의 키는 스키마가 고정한 집합이고
 * `additionalProperties: false`가 임의 키를 막는다.
 */
export function walkStringValues(instance, cb, path = [], depth = 0) {
  if (depth > 60) return;
  if (typeof instance === "string") {
    cb({ path, value: instance });
    return;
  }
  if (Array.isArray(instance)) {
    instance.forEach((item, i) => walkStringValues(item, cb, [...path, i], depth + 1));
    return;
  }
  if (instance && typeof instance === "object") {
    for (const [key, sub] of Object.entries(instance)) {
      walkStringValues(sub, cb, [...path, key], depth + 1);
    }
  }
}

/** 구체 경로(["nodes", 0, "text"])를 스키마 패턴 어휘("nodes.[].text")로 정규화한다. */
function normalizePath(pathTokens) {
  return pathTokens.map((t) => (typeof t === "number" ? "[]" : t)).join(".");
}

/** 사람이 읽는 표기(nodes[0].text)로 렌더한다 — 오류 메시지 전용. */
function displayPath(pathTokens) {
  return pathTokens
    .map((t) => (typeof t === "number" ? `[${t}]` : `.${t}`))
    .join("")
    .replace(/^\./, "");
}

/**
 * 산출물 인스턴스에서 시크릿 패턴 히트를 찾아 위반 목록을 반환한다.
 *
 * 각 위반: { path: 'nodes[0].text', patterns: ['aws-access-key'],
 *            excerpt: '...마스킹된 발췌...' }
 *
 * `excerpt`는 **반드시 마스킹된 텍스트**다. 원문을 담으면 이 검사기의 오류
 * 메시지 자체가 시크릿을 CI 로그·터미널 기록으로 유출하는 두 번째 경로가
 * 된다 — 유출을 막겠다는 검사기가 유출 경로를 새로 만드는 셈이다.
 *
 * @param {object} schema  대응 스키마 문서
 * @param {*} instance     산출물 JSON을 파싱한 값
 * @returns {{path: string, patterns: string[], excerpt: string}[]}
 */
export function scanForSecrets(schema, instance) {
  const emailExempt = new Set(collectEmailFormatPaths(schema).map((p) => p.join(".")));
  const violations = [];

  walkStringValues(instance, ({ path, value }) => {
    if (value === "") return;
    const { text: masked, hits } = redactSecrets(value);
    if (hits.length === 0) return;

    let effective = hits;
    if (emailExempt.has(normalizePath(path)) && isSingleEmail(value)) {
      // 스키마가 이메일 자리라고 선언했고 값 전체가 실제로 단일 이메일이다.
      // `email` 히트 하나만 면제한다 — 나머지 패턴은 그대로 위반이다.
      effective = hits.filter((h) => h.name !== "email");
    }
    if (effective.length === 0) return;

    violations.push({
      path: displayPath(path),
      patterns: effective.map((h) => h.name),
      excerpt: masked.length > 160 ? `${masked.slice(0, 160)}…` : masked,
    });
  });

  return violations;
}
