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
//
// 제외가 하나 더 있고, 그것은 구조적으로 빠지지 않으므로 코드에 명시돼
// 있다: **`origin: "user"`인 노드의 free-text는 검사하지 않는다.** 이
// 린트의 목적은 LLM의 영어 누수를 잡는 것이지 사용자의 언어 선택을
// 강제하는 것이 아니다 — `gapNode.selfAssessment`처럼 스펙이 사용자
// 입력으로 정의한 필드까지 때리면, 영어로 자가진단을 쓴 사용자에게 남는
// 선택지가 "게이트를 끄는 것"뿐이 된다(스펙 리스크 절이 지목한 '검증 우회'
// 경로 그대로다). 대안이던 "selfAssessment를 x-verbatim으로 전환"은
// 채택하지 않았다 — 그 필드는 GapAnalyzer가 요약해 쓸 수도 있어서, 통째로
// 빼면 LLM 누수까지 못 잡는 반대 실패가 생긴다. 좁은 쪽(노드 단위 origin)이
// 정확하다.
//
// 이 제외의 회귀 오라클은 `origin` 하나만 다른 픽스처 쌍이다 —
// tests/fixtures-valid/gap-report.json(origin:"user" 영문 → exit 0)와
// tests/fixtures-invalid/20-gap-report-generated-english/(같은 내용,
// origin:"generated" → exit 1). 한쪽만 두면 "제외가 너무 넓어 전부 통과"와
// "제외가 정확히 좁게 작동"을 구별할 수 없다.

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

/**
 * instance에서 path 패턴(배열 자리는 '[]'로 확장)에 해당하는 값들을 모두 뽑는다.
 *
 * 반환은 순수 값 배열이 아니라 `{ value, container }` 쌍의 배열이다 —
 * `container`는 그 값을 **직접** 담고 있는 객체(대개 노드)이며, 호출자가
 * 형제 필드(`origin` 등)를 보고 판정을 조정할 수 있게 하기 위한 것이다.
 * 값만 flat하게 반환하던 이전 형태로는 "이 문자열이 어느 노드에서 나왔는가"를
 * 알 수 없어 AC-19의 `origin: "user"` 제외를 구현할 수 없었다.
 */
export function getValuesAtPath(instance, pathTokens) {
  let current = [{ value: instance, container: null }];
  for (const token of pathTokens) {
    const next = [];
    for (const c of current) {
      const v = c.value;
      if (v == null) continue;
      if (token === "[]") {
        // 배열 확장은 컨테이너를 바꾸지 않는다 — 항목 자신이 다음 키의
        // 컨테이너가 되므로, 다음 루프의 else 분기에서 갱신된다.
        if (Array.isArray(v)) {
          for (const item of v) next.push({ value: item, container: c.container });
        }
      } else if (typeof v === "object" && !Array.isArray(v) && token in v) {
        next.push({ value: v[token], container: v });
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
    for (const { value, container } of values) {
      if (typeof value !== "string") continue;
      // AC-19 제외: 같은 노드의 origin이 "user"면 그 노드의 free-text는
      // 검사하지 않는다. 이 린트가 잡으려는 것은 **LLM의 영어 누수**이고,
      // 사용자가 자기 자가진단·자기 경력 서술을 영어로 쓰는 것은 결함이
      // 아니다. 제외하지 않으면 사용자에게 남는 회피책이 "게이트를 끄는
      // 것"뿐이 된다.
      //
      // 제외는 **노드 단위**이며 필드 단위 오버라이드는 없다. origin이
      // 없거나(중첩 서브객체 안의 free-text 등) "generated"면 예외 없이
      // 검사한다(fail-closed).
      //
      // 이 예외의 안전성은 스키마 쪽 계약에 의존한다 — `origin`은 병합·
      // 편집 감지 로직만 설정하고 생성 템플릿이 직접 기입하지 않는다.
      // LLM이 스스로 "user"를 적을 수 있으면 이 제외가 곧 자기면제 통로가
      // 된다(각 노드 스키마의 origin description에 같은 문장을 못 박아 뒀다).
      //
      // 새 x-freeText 필드를 추가할 때: 그 필드가 origin을 형제로 갖는
      // 노드의 직속 필드인지 확인하라. 더 깊이 중첩하면 container가 노드가
      // 아니게 되어 이 제외가 조용히 무력화된다(검사는 계속되므로 오탐
      // 방향이며 미탐 방향은 아니다).
      if (container && container.origin === "user") continue;
      const tokens = value.trim().split(/\s+/).filter(Boolean);
      if (tokens.length >= 4 && !HANGUL_RE.test(value)) {
        violations.push({ path: p.join(".").replace(/\.\[\]/g, "[]"), value });
      }
    }
  }
  return violations;
}
