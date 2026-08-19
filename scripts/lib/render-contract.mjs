// scripts/lib/render-contract.mjs
//
// 구현 7단계 렌더 계약의 **정본 리터럴과 파생 규칙**. 심사 m-3(렌더 계약이
// 스펙에 0줄) 대응.
//
// **왜 렌더러와 분리된 모듈인가.** 렌더러가 리터럴을 자기 안에 들고 있으면
// 그 리터럴을 검사하는 오라클도 같은 파일에서 읽어야 하고, 그러면 검사가
// "렌더러가 자기가 정한 문자열을 출력했다"만 확인하는 자기충족이 된다.
// 배지 문자열·커버리지 라벨·절단 고지는 여기 한 번만 정의하고, 렌더러와
// 오라클이 **둘 다 여기서 import** 한다. 그래야 오라클이 검사하는 것이
// 「출력이 계약을 만족하는가」가 된다.
//
// **배지는 verification에서만 파생한다(AC-13 (ii)).** 스펙 원문:
// "렌더 마크다운의 '근거 부족 - 미검증' 배지는 이 필드에서만 파생하며,
// 마크다운에만 존재하는 배지는 금지한다". 그래서 여기에는 basis를 보고
// 배지를 만드는 경로가 없다 — basis는 별도 축(근거 등급)이고 §1의 "정본은
// JSON, 마크다운은 렌더 뷰"가 이 분리에 걸려 있다.
//
// **배지 리터럴의 정본은 스키마 description이다.** career·knowledge-map·
// gap-report 세 스키마가 이미 `'근거 부족 - 미검증'`(하이픈)을 본문에
// 적어 두었다. 그 세 파일은 슬라이스 A 소유이고 예외 목록에 없으므로
// 여기서 그쪽을 고치지 않고 **이쪽이 그 표기를 따른다**. 두 표기가 갈리면
// tests/run-smoke.mjs의 드리프트 단언이 FAIL한다 — `samplingMethod` 정본
// 리터럴이 4곳에 묶여 있는 것과 같은 형태다.

/**
 * AC-13 강등 배지. 이 문자열이 사용자 눈에 닿는 유일한 강등 표시다.
 * 값을 바꾸려면 세 스키마의 description을 함께 바꿔야 하고, 그 파일들은
 * 슬라이스 A 소유다 — 즉 이 리터럴은 사실상 고정이다.
 */
export const EVIDENCE_BADGE = "근거 부족 - 미검증";

/**
 * `verification.status`가 이 값일 때에만 배지가 붙지 **않는다**.
 * 나머지(refuted / not-attempted / 필드 부재)는 전부 배지 대상이다 —
 * fail-closed다. 'verified만 통과'로 쓰는 이유는 상보 조건이라야
 * status enum이 늘어날 때 새 값이 조용히 무배지로 새지 않기 때문이다.
 */
export const VERIFIED_STATUS = "verified";

/**
 * 노드에 붙을 배지를 돌려준다(없으면 null).
 *
 * 판정은 오직 `node.verification.status`다. `basis`·`evidence.length`는
 * 보지 않는다 — 그 둘로 배지를 만들면 AC-13 (ii)가 금지한 "마크다운이
 * 스스로 강등을 판단하는" 경로가 된다.
 *
 * `verification` 자체가 없으면 배지를 붙인다. 스키마는 이 필드를 required로
 * 두지만 렌더러는 스키마 검증 **뒤**에만 도는 것이 아니라(사용자가 손으로
 * 편집한 파일을 렌더할 수 있다) 부재를 '검증됨'으로 읽으면 안 된다.
 *
 * @param {{verification?: {status?: string}}} node
 * @returns {string|null}
 */
export function badgeForNode(node) {
  const status = node?.verification?.status;
  return status === VERIFIED_STATUS ? null : EVIDENCE_BADGE;
}

/**
 * 커버리지 3수치의 라벨 정본. 세 값을 **전부** 렌더해야 한다는 것이 계약이며
 * (구현 7단계 렌더 계약 원문), 그래서 오라클이 이 세 라벨의 존재를 각각
 * 확인한다. `traversed`를 빼면 "순회 총계와 커버리지 분모 혼동"이 사용자
 * 눈에 닿는 표면에서 되살아난다 — 그 혼동을 막으려고 필드를 신설했다
 * (구현 2단계, R6-Major-1).
 */
export const COVERAGE_LABELS = Object.freeze({
  analyzed: "분석한 커밋",
  total: "대상 커밋",
  traversed: "순회한 커밋",
});

/** 절단 고지의 머리 문자열. `truncated.reason !== "none"`일 때만 렌더한다. */
export const TRUNCATION_NOTICE_PREFIX = "절단 고지";

/** 절단이 없을 때에도 그 사실을 명시한다 — 침묵은 "절단 없음"과 구별되지 않는다. */
export const NO_TRUNCATION_NOTICE = "절단 없음(전량 분석)";

/**
 * 근거 등급(`basis`) 표시 라벨. 등급 자체는 JSON이 정본이고 여기서는
 * 사용자 대면 표기만 준다. 미지의 값은 지어내지 않고 원문을 그대로 보인다 —
 * 렌더러가 모르는 값을 만나면 조용히 감추는 것이 가장 나쁜 처리다.
 */
export const BASIS_LABELS = Object.freeze({
  commit: "커밋 근거",
  inference: "추론",
  external: "외부 출처",
  insufficient: "근거 부족",
});

/**
 * @param {string|undefined} basis
 * @returns {string}
 */
export function basisLabel(basis) {
  if (typeof basis !== "string" || basis === "") return "근거 등급 미기재";
  return BASIS_LABELS[basis] ?? `${basis}(미지의 등급)`;
}

/**
 * 커버리지 3수치 줄. 값이 없으면 숫자를 지어내지 않고 `미기재`를 쓴다.
 *
 * @param {{analyzed?: number, total?: number, traversed?: number, samplingMethod?: string}} coverage
 * @returns {string}
 */
export function formatCoverage(coverage) {
  const n = (v) => (typeof v === "number" ? String(v) : "미기재");
  return (
    `${COVERAGE_LABELS.analyzed} ${n(coverage?.analyzed)}건 / ` +
    `${COVERAGE_LABELS.total} ${n(coverage?.total)}건 / ` +
    `${COVERAGE_LABELS.traversed} ${n(coverage?.traversed)}건` +
    ` (샘플링: ${coverage?.samplingMethod ?? "미기재"})`
  );
}

/**
 * 절단 고지 줄. `reason`이 `none`이면 절단이 없었다는 사실을 명시한다.
 *
 * @param {{reason?: string, dropped_commits?: number}} truncated
 * @returns {string}
 */
export function formatTruncation(truncated) {
  const reason = truncated?.reason;
  if (reason === "none" || reason === undefined) return NO_TRUNCATION_NOTICE;
  const dropped = typeof truncated?.dropped_commits === "number" ? truncated.dropped_commits : "미기재";
  return `${TRUNCATION_NOTICE_PREFIX}: ${reason}으로 ${dropped}건이 분석에서 빠졌습니다.`;
}

/**
 * 오라클이 소비하는 계약 목록. 렌더러가 출력해야 하는 요소를 **데이터로**
 * 둔다 — 산문으로만 적으면 검사가 그 산문을 읽지 못한다.
 *
 * 각 항목의 `probe(md, instance)`는 그 요소가 출력에 실재하는지를 돌려준다.
 */
export const RENDER_REQUIRED_ELEMENTS = Object.freeze([
  {
    id: "coverage-analyzed",
    why: "커버리지 3수치 중 analyzed",
    probe: (md) => md.includes(COVERAGE_LABELS.analyzed),
  },
  {
    id: "coverage-total",
    why: "커버리지 3수치 중 total",
    probe: (md) => md.includes(COVERAGE_LABELS.total),
  },
  {
    id: "coverage-traversed",
    why: "커버리지 3수치 중 traversed — 이것이 빠지면 분모 혼동이 사용자 표면에서 되살아난다",
    probe: (md) => md.includes(COVERAGE_LABELS.traversed),
  },
  {
    id: "truncation",
    why: "절단 고지(절단이 없으면 없다는 사실)",
    probe: (md) => md.includes(TRUNCATION_NOTICE_PREFIX) || md.includes(NO_TRUNCATION_NOTICE),
  },
  {
    id: "badge",
    why: "AC-13 강등 배지 — verification.status가 verified가 아닌 노드가 1건이라도 있으면 출력에 실재해야 한다",
    probe: (md, instance) => {
      const needsBadge = (instance?.nodes ?? []).some((nd) => badgeForNode(nd) !== null);
      return needsBadge ? md.includes(EVIDENCE_BADGE) : true;
    },
  },
  {
    id: "no-phantom-badge",
    why: "전 노드가 verified인데 배지가 나오면 마크다운이 스스로 강등을 만든 것이다(AC-13 (ii) 금지)",
    probe: (md, instance) => {
      const needsBadge = (instance?.nodes ?? []).some((nd) => badgeForNode(nd) !== null);
      return needsBadge ? true : !md.includes(EVIDENCE_BADGE);
    },
  },
]);
