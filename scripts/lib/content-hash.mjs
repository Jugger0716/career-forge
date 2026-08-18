// scripts/lib/content-hash.mjs
//
// 콜드 리뷰 A-7 대응: evidence.json의 `contentHash` 정본 계산을 이 파일
// 하나로 모은다. 이전에는 scripts/collect-git-facts.mjs가 해시를 계산해
// 기록하기만 하고, 그 값을 재계산·대조하는 코드가 레포 전체(scripts/
// verify-evidence.mjs, scripts/validate-plugin.mjs)에 0곳이었다 — 즉
// 5개 스키마가 "정본 무결성 장치"로 선언한 필드가 실제로는 아무도
// 검증하지 않는 죽은 계약이었다. 쓰기(collect-git-facts.mjs)와
// 검증(verify-evidence.mjs, validate-plugin.mjs --schema-check)이 이
// 함수 하나를 공유해야만 "같은 구현·같은 키 순서"가 보장된다.
//
// `generatedAt`을 해시 대상에서 제외한다 — 포함하면 같은 레포·같은 옵션
// 으로 두 번 실행해도(시각만 다를 뿐 본문은 완전히 동일해도) 매번 다른
// 해시가 나와 "같은 입력 → 같은 해시" 결정성이 성립하지 않는다(골든
// 게이트의 재현성 전제와 충돌한다).
//
// 대상 필드는 evidence.json 본문에서 `generatedAt`과 `contentHash` 자신을
// 제외한 전부다. 이 함수는 순서를 필드 이름으로 고정해 새 객체를 조립한
// 뒤 직렬화하므로, 호출자가 넘긴 객체(파일에서 막 읽은 JSON이든 아직
// 디스크에 쓰기 전의 JS 객체든)의 실제 프로퍼티 나열 순서와 무관하게
// 항상 같은 문자열을 해싱한다 — "쓰기 시점 객체 조립과 검증 시점 객체
// 조립이 서로 달라 키 순서 규칙이 코드에 명시돼 있지 않다"는 콜드 리뷰
// 지적을 이 고정 목록 하나로 없앤다.
//
// 한계(스키마 description에도 명시): 이 해시는 키 없는 SHA-256이므로
// 우발적 손상·부분 편집(예: 텍스트 에디터로 필드 하나만 고치고 해시는
// 갱신하지 않은 경우)을 잡을 뿐, 해시 필드까지 함께 재계산해 다시 써넣는
// 의도적 위조는 원리적으로 막지 못한다(그 방어는 A-8의 (b)축 git 오라클
// 재도출이 담당한다 — 이 파일의 책임 범위 밖).

import crypto from "node:crypto";

/** evidence.json 해시 대상 필드(고정 순서). generatedAt·contentHash 제외. */
const EVIDENCE_CONTENT_HASH_FIELDS = ["schemaVersion", "sourceRepoHead", "coverage", "truncated", "commits"];

/**
 * evidence 객체(디스크에 쓰기 전이든, 방금 읽은 JSON이든)에서 해시 대상
 * 필드만 고정 순서로 뽑아 SHA-256 hex를 계산한다.
 *
 * @param {object} evidence
 * @returns {string} 64자 SHA-256 hex
 */
export function computeEvidenceContentHash(evidence) {
  const canonical = {};
  for (const key of EVIDENCE_CONTENT_HASH_FIELDS) {
    canonical[key] = evidence?.[key];
  }
  return crypto.createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
