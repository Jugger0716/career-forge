// scripts/lib/redact.mjs
//
// §4·§6 배경이 요구하는 시크릿/PII 마스킹 유틸(AWS 키, private key 블록,
// JWT, password= 필드, 이메일 패턴). P0 기본값(`--no-diff`)에서는 diff
// 원문 자체를 수집하지 않으므로 이 모듈이 collect-git-facts.mjs의 기본
// 경로에서 호출되지는 않지만, `include_diff`/스니펫 인용 옵트인 경로가
// 코드 원문을 다루게 될 때(구현 7단계 이후 skills가 옵트인 인용을 렌더링할
// 때) 공유할 단일 마스킹 구현으로 이 파일을 둔다 — 마스킹 규칙이 여러
// 곳에 흩어지면 "마스킹 우회" 회귀(AC-11, tests/contamination 40건 중
// 10건)를 잡을 오라클이 하나로 안 모인다.
//
// 모든 함수는 순수 문자열 변환이다(파일 I/O·git 호출 없음).

const PATTERNS = [
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "aws-secret-key", re: /\b(?:[A-Za-z0-9+/]{40})\b/g },
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: "password-field", re: /\b(password|passwd|pwd)\s*=\s*\S+/gi },
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

/**
 * 텍스트 안의 알려진 시크릿/PII 패턴을 `[REDACTED:<name>]`로 치환한다.
 * aws-secret-key 패턴(40자 base64 유사 문자열)은 오탐 폭이 넓으므로
 * aws-access-key가 이미 찾은 자리를 다시 건드리지 않도록 순서대로 누적
 * 적용한다(먼저 적용된 패턴이 만든 `[REDACTED:...]` 자체는 재매칭되지
 * 않는다 — 대괄호·콜론이 위 정규식들의 문자 집합과 겹치지 않는다).
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
