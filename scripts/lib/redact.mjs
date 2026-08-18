// scripts/lib/redact.mjs
//
// §4·§6 배경이 요구하는 시크릿/PII 마스킹 유틸(AWS 키, private key 블록,
// JWT, password= 필드, 이메일 패턴). collect-git-facts.mjs가 원장 커밋의
// `subject`·`coAuthors`를 직렬화하는 지점에서 이 모듈을 호출한다(콜드
// 리뷰 A-9 대응 — 커밋 제목·co-author 트레일러는 diff 원문이 아니므로
// `--no-diff` 기본값의 보호 범위 밖이고, 여기서 마스킹하지 않으면 시크릿·
// 동료 이메일이 원문 그대로 원장에 남는다). `include_diff`/스니펫 인용
// 옵트인 경로(구현 7단계 이후, P0 스키마는 diff 원문 자체를 담지 않는다)가
// 코드 원문을 다루게 될 때도 이 파일을 공유 구현으로 재사용한다 — 마스킹
// 규칙이 여러 곳에 흩어지면 "마스킹 우회" 회귀(AC-11, tests/contamination
// 40건 중 10건)를 잡을 오라클이 하나로 안 모인다.
//
// 모든 함수는 순수 문자열 변환이다(파일 I/O·git 호출 없음).
//
// 콜드 리뷰 A-10 대응 — 오탐/미탐 수정:
//   - aws-secret-key: 40자 순수 소문자 hex(= 이 도구가 도처에서 인용하는
//     커밋 SHA·`commitHash` 스키마 형식 `^[0-9a-f]{40}$` 그 자체)는 선행
//     부정 탐색 `(?![0-9a-f]{40}\b)`으로 제외한다 — 이 예외가 없으면 이
//     도구의 산출물(커밋 해시로 가득한 원장)이 자기 자신을 파괴한다.
//     대문자·`/`·`+`를 포함하는 실제 AWS 시크릿 키(예시 키 포함)는 그대로
//     잡힌다.
//   - private-key-block: END 마커를 옵셔널로 하고(diff 훅이 파일 일부만
//     담아 잘린 PEM 블록도 잡아야 한다) 대소문자를 구분하지 않는다.
//   - jwt: 두 번째 세그먼트를 `eyJ`가 아니라 `ey`로, 서명 세그먼트를
//     빈 문자열 허용(`*`)으로 완화한다 — payload가 `eyA`로 시작하거나
//     `alg:none`이라 서명이 빈 토큰도 잡는다.
//   - password-field: 좌측 경계를 `(?<![A-Za-z0-9])`로, 구분자를 `[:=]`로
//     넓히고(JSON `"password": "..."` 형태의 콜론 구분·따옴표 감싼 키/값
//     지원), 키 이름에 `secret`·`token`을 추가하며 값에서 이미 만들어진
//     `[REDACTED:...]` 토큰(대괄호 포함)은 재매칭하지 않도록 값 문자
//     집합에서 대괄호를 제외한다 — 그래야 순서대로 누적 적용해도 먼저
//     치환된 결과가 뒤 패턴에 다시 삼켜져 히트 수가 부풀려지지 않는다.
const PATTERNS = [
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "aws-secret-key", re: /\b(?![0-9a-f]{40}\b)[A-Za-z0-9+/]{40}\b/g },
  { name: "private-key-block", re: /-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*?(?:-----END[^\n]*-----|$)/gi },
  { name: "jwt", re: /\bey[A-Za-z0-9_-]+\.ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*(?![A-Za-z0-9_-])/g },
  { name: "password-field", re: /(?<![A-Za-z0-9])[A-Za-z0-9_]*(?:password|passwd|pwd|secret|token)[A-Za-z0-9_]*"?\s*[:=]\s*"?[^\s",}[\]]+"?/gi },
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

/**
 * 텍스트 안의 알려진 시크릿/PII 패턴을 `[REDACTED:<name>]`로 치환한다.
 * 배열 순서대로 누적 적용한다(먼저 적용된 패턴이 만든 `[REDACTED:...]`
 * 자체는 뒤 패턴들이 재매칭하지 않는다 — 대괄호가 어떤 패턴의 값 문자
 * 집합에도 포함되지 않는다. commitHash 40자 hex는 aws-secret-key에서
 * 명시적으로 제외되므로 이 도구가 인용하는 커밋 해시는 파괴되지 않는다).
 *
 * @param {string} text
 * @returns {{ text: string, hits: {name: string, count: number}[] }}
 */
export function redactSecrets(text) {
  let out = text;
  const hits = [];
  for (const { name, re } of PATTERNS) {
    let count = 0;
    out = out.replace(re, () => {
      count += 1;
      return `[REDACTED:${name}]`;
    });
    if (count > 0) hits.push({ name, count });
  }
  return { text: out, hits };
}

/** redactSecrets가 무언가 치환했는지만 빠르게 확인한다(마스킹 로그용). */
export function containsSecretPattern(text) {
  return PATTERNS.some(({ re }) => new RegExp(re.source, re.flags).test(text));
}
