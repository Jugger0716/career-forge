// 오염 주입 스위트 채점 엔진 — **순수 함수만 둔다.**
//
// 이 파일에는 파일 IO도 프로세스 실행도 없다. 입력은 (케이스 정의, 프로덕션 CLI가 뱉은
// 관측 결과)이고 출력은 판정과 집계다. 그렇게 나눈 이유가 둘이다:
//
//   1. **격리 사본에서 변이를 넣어 채점 로직만 시험할 수 있다** — 300커밋 픽스처도
//      서브프로세스도 필요 없다. 채점기가 IO와 붙어 있으면 「분모를 채점된 건수로
//      바꾸기」 같은 변이를 관측하는 데 10분짜리 픽스처 빌드가 걸린다.
//   2. **자기충족을 구조로 막는다** — 아래 절대 조건을 보라.
//
// **절대 조건: 이 파일은 REJECT 사유 코드를 한 글자도 소유하지 않는다.**
// 기대 코드의 주인은 `cases/` 아래 케이스 파일이고, 실제 코드의 주인은 프로덕션
// CLI(`scripts/verify-evidence.mjs`·`scripts/validate-plugin.mjs --secret-scan`)다.
// 채점기가 둘 다 소유하면 자기가 심은 문자열을 자기가 찾는 게이트가 된다.
// `(CT-3)`이 이 파일에서 코드 리터럴이 0건임을 소스 스캔으로 관측한다 — 규약이 아니라
// 집행이다. 경계와 근거는 `tests/contamination/README.md` §1에 있다.
//
// **판정 어휘는 넷이고 「미제출」은 0%가 아니다.** 부재를 미탐지로 강등하면 아무것도
// 제출하지 않은 회차가 「탐지에 실패했다」와 같은 점수를 받는다(절대 규칙 6).

/** 케이스 종. 값은 케이스 파일의 `kind`와 바이트 동일하다. */
export const CASE_KINDS = Object.freeze({
  FAKE_HASH: "fake-hash",
  OTHER_AUTHOR: "other-author",
  SECRET_BYPASS: "secret-bypass",
  UNSUPPORTED_CLAIM: "unsupported-claim",
});

/** 채점에 LLM이 필요 없는 세 종. AC-8 (iv)의 경계이며 `--contamination`의 대상이다. */
export const MACHINE_KINDS = Object.freeze([
  CASE_KINDS.FAKE_HASH,
  CASE_KINDS.OTHER_AUTHOR,
  CASE_KINDS.SECRET_BYPASS,
]);

/**
 * 판정 어휘.
 *
 * `RESOLVED_BY_REGENERATION`은 반증이 성공해 재생성으로 노드가 사라지거나 고쳐진
 * 경우다 — `DETECTED`의 정상적 귀결이므로 **탐지로 센다.** 「노드가 없다」를 미탐지로
 * 읽으면 반증이 가장 잘 작동한 회차가 가장 낮은 점수를 받는다.
 */
export const OUTCOME = Object.freeze({
  DETECTED: "DETECTED",
  MISSED: "MISSED",
  INVALID: "INVALID",
  RESOLVED_BY_REGENERATION: "RESOLVED_BY_REGENERATION",
});

/** 탐지로 세는 판정. 분자의 정본이다. */
const DETECTING_OUTCOMES = Object.freeze([OUTCOME.DETECTED, OUTCOME.RESOLVED_BY_REGENERATION]);

/**
 * 케이스 정의의 형태를 검사한다. **부재를 default로 채우지 않는다** — 빠진 필드는
 * 위반 목록에 남고 호출부가 FAIL시킨다.
 *
 * @param {unknown} def 케이스 파일에서 판독한 값
 * @param {string} source 사유에 담을 출처(파일명 등)
 * @returns {string[]} 위반 사유. 빈 배열이면 적합.
 */
export function checkCaseShape(def, source) {
  const problems = [];
  const shape = def === null ? "null" : Array.isArray(def) ? "array" : typeof def;
  if (shape !== "object") {
    problems.push(`${source}: 케이스가 객체가 아님(${shape})`);
    return problems;
  }
  const knownKinds = new Set(Object.values(CASE_KINDS));
  if (typeof def.caseId !== "string" || def.caseId === "") problems.push(`${source}: caseId 없음`);
  if (!knownKinds.has(def.kind)) problems.push(`${source}: kind가 알려진 종이 아님(${JSON.stringify(def.kind)})`);
  if (typeof def.axis !== "string" || def.axis === "") problems.push(`${source}: axis 없음 — 10건이 서로 달라야 할 축을 적지 않으면 같은 케이스의 10배다`);
  if (typeof def.layer !== "string" || def.layer === "") problems.push(`${source}: layer 없음`);

  const expect = def.expect;
  const expectShape = expect === null ? "null" : Array.isArray(expect) ? "array" : typeof expect;
  if (expectShape !== "object") {
    problems.push(`${source}: expect가 객체가 아님(${expectShape})`);
  } else {
    if (typeof expect.checker !== "string" || expect.checker === "") problems.push(`${source}: expect.checker 없음`);
    if (typeof expect.code !== "string" || expect.code === "") problems.push(`${source}: expect.code 없음`);
  }

  const inject = def.inject;
  const injectShape = inject === null ? "null" : Array.isArray(inject) ? "array" : typeof inject;
  if (injectShape !== "object") problems.push(`${source}: inject가 객체가 아님(${injectShape})`);
  return problems;
}

/**
 * 셀렉터를 회차 원장에서 실제 커밋으로 푼다.
 *
 * **해시를 케이스 파일에 하드코딩하지 않는 이유**: 픽스처는 결정적이지만 그 결정성은
 * `fixtures/make-fixture.mjs`의 내용에 묶인다 — 생성기가 바뀌면 해시가 갈리고 케이스가
 * 조용히 낡는다. 셀렉터는 원장의 사실(`exclusionReason` 분포)로 대상을 고르므로 생성기
 * 변경을 따라간다.
 *
 * **대상이 0건이면 `null`이 아니라 사유를 돌려준다.** 못 찾은 것을 `null`로 강등하면
 * 호출부가 그것을 「인용할 커밋이 없다」로 읽고 조용히 건너뛴다.
 *
 * @param {{exclusionReason?: string, ordinal?: number}} selector
 * @param {{commits?: object[]}} evidence 회차 원장
 * @returns {{ledgerId: string|null, reason: string|null, matched: number}}
 */
export function resolveSelector(selector, evidence) {
  const commits = Array.isArray(evidence?.commits) ? evidence.commits : null;
  if (commits === null) return { ledgerId: null, reason: "원장에 commits 배열이 없음", matched: 0 };
  if (selector === null || typeof selector !== "object" || Array.isArray(selector)) {
    return { ledgerId: null, reason: "셀렉터가 객체가 아님", matched: 0 };
  }
  const wanted = selector.exclusionReason;
  if (typeof wanted !== "string" || wanted === "") {
    return { ledgerId: null, reason: "셀렉터에 exclusionReason이 없음", matched: 0 };
  }
  const pool = commits.filter((c) => c?.exclusionReason === wanted);
  const ordinal = Number.isInteger(selector.ordinal) ? selector.ordinal : 0;
  if (pool.length === 0) {
    return { ledgerId: null, reason: `원장에 exclusionReason='${wanted}'인 커밋이 0건`, matched: 0 };
  }
  if (ordinal < 0 || ordinal >= pool.length) {
    return { ledgerId: null, reason: `ordinal ${ordinal}이 범위 밖(대상 ${pool.length}건)`, matched: pool.length };
  }
  const id = pool[ordinal]?.id;
  if (typeof id !== "string" || id === "") {
    return { ledgerId: null, reason: `선택된 커밋에 id가 없음(ordinal ${ordinal})`, matched: pool.length };
  }
  return { ledgerId: id, reason: null, matched: pool.length };
}

/**
 * 인용 축(`fake-hash`·`other-author`) 케이스 하나를 채점한다.
 *
 * @param {object} caseDef 케이스 정의
 * @param {string|null} ledgerId 이 케이스가 인용한 ledgerId(셀렉터 해소 결과 포함).
 *   `null`이면 대상을 특정하지 못한 것이므로 `INVALID`다 — `MISSED`가 아니다.
 * @param {object[]|null} violations 프로덕션 CLI 리포트의 위반 배열. `null`이면 회차
 *   산출물이 없거나 리포트를 얻지 못한 것이므로 `INVALID`다.
 * @param {{commits?: object[]}|null} evidence `exclusionReason` 보강 대조에 쓴다.
 * @returns {{caseId: string, outcome: string, detail: string}}
 */
export function gradeCitationCase(caseDef, ledgerId, violations, evidence = null) {
  const caseId = caseDef?.caseId ?? "(caseId 없음)";
  if (violations === null || !Array.isArray(violations)) {
    return { caseId, outcome: OUTCOME.INVALID, detail: "위반 목록 부재 — 회차 산출물이나 리포트가 없다(미제출은 0%가 아니다)" };
  }
  if (typeof ledgerId !== "string" || ledgerId === "") {
    return { caseId, outcome: OUTCOME.INVALID, detail: "인용 대상을 특정하지 못했다(셀렉터 미해소)" };
  }

  const hits = violations.filter((v) => v?.ledgerId === ledgerId);
  if (hits.length === 0) {
    // 주입한 인용이 산출물에서 사라졌는가(반증 성공 후 재생성)와, 검사기가 놓쳤는가는
    // 다르다. 회차가 그 사실을 선언했을 때만 전자로 센다 — 채점기가 추측하지 않는다.
    if (caseDef?.observed?.regenerated === true) {
      return { caseId, outcome: OUTCOME.RESOLVED_BY_REGENERATION, detail: "재생성으로 노드가 사라짐(반증 성공의 정상적 귀결)" };
    }
    return { caseId, outcome: OUTCOME.MISSED, detail: `ledgerId '${ledgerId}'에 대한 위반이 0건 — 검사기가 잡지 못했다` };
  }

  const expected = caseDef?.expect?.code;
  const codeMatch = hits.find((v) => v?.code === expected);
  if (codeMatch === undefined) {
    return {
      caseId,
      outcome: OUTCOME.MISSED,
      detail: `기대 코드 '${expected}'가 아닌 코드로 떨어짐(실제: ${JSON.stringify(hits.map((v) => v?.code))}) — 아무 REJECT나 탐지로 세지 않는다`,
    };
  }

  // `other-author`의 두 갈래(봇·타 저자)는 같은 코드로 뭉개진다. 케이스가
  // `exclusionReason`을 지정했으면 원장으로 보강 대조한다 — 그러지 않으면 「봇을
  // 잡았다」와 「타 저자를 잡았다」가 같은 점수가 된다.
  const wantedReason = caseDef?.expect?.exclusionReason;
  if (typeof wantedReason === "string" && wantedReason !== "") {
    const commits = Array.isArray(evidence?.commits) ? evidence.commits : [];
    const entry = commits.find((c) => c?.id === ledgerId);
    if (entry === undefined) {
      return { caseId, outcome: OUTCOME.INVALID, detail: `보강 대조 불가 — 원장에서 '${ledgerId}'를 찾지 못했다` };
    }
    if (entry.exclusionReason !== wantedReason) {
      return {
        caseId,
        outcome: OUTCOME.MISSED,
        detail: `코드는 맞지만 갈래가 다름(기대 exclusionReason='${wantedReason}', 실제='${entry.exclusionReason}')`,
      };
    }
  }
  return { caseId, outcome: OUTCOME.DETECTED, detail: `기대 코드 일치` };
}

/**
 * 시크릿 축(`secret-bypass`) 케이스 하나를 채점한다.
 *
 * 케이스마다 **산출물 파일 하나**를 갖는다 — 그래야 `--secret-scan` 한 번의 결과가
 * 그 케이스의 판정이 되고, 채점기가 오류 메시지의 산문에서 필드 경로를 긁어낼 필요가
 * 없다(산문 파싱은 프로덕션 메시지가 바뀔 때마다 조용히 낡는다).
 *
 * @param {object} caseDef
 * @param {{ok: boolean, codes: string[]}|null} scan `--secret-scan`이 낸 결과.
 *   `null`이면 스캔 자체를 돌리지 못한 것 → `INVALID`.
 * @returns {{caseId: string, outcome: string, detail: string}}
 */
export function gradeSecretCase(caseDef, scan) {
  const caseId = caseDef?.caseId ?? "(caseId 없음)";
  if (scan === null || typeof scan !== "object" || !Array.isArray(scan.codes)) {
    return { caseId, outcome: OUTCOME.INVALID, detail: "스캔 결과 부재 — 산출물이 없거나 스캔을 돌리지 못했다" };
  }
  const expected = caseDef?.expect?.code;
  if (scan.codes.includes(expected)) {
    return { caseId, outcome: OUTCOME.DETECTED, detail: "기대 코드 일치" };
  }
  if (scan.ok === true) {
    return { caseId, outcome: OUTCOME.MISSED, detail: "스캔이 통과했다 — 마스킹 우회가 잡히지 않았다" };
  }
  return {
    caseId,
    outcome: OUTCOME.MISSED,
    detail: `기대 코드 '${expected}'가 아닌 코드로 떨어짐(실제: ${JSON.stringify(scan.codes)}) — 다른 이유로 실패한 것을 탐지로 세지 않는다`,
  };
}

/**
 * 한 종·한 회차의 집계.
 *
 * **분모는 언제나 케이스 파일 개수다.** 채점된 건수로 바꾸는 것이 이 게이트를
 * 무력화하는 가장 싼 방법이다 — 산출물을 안 낸 회차가 100%를 받는다. `(CT-9)`가
 * 그 변이를 관측한다.
 *
 * @param {object[]} caseDefs 이 종의 케이스 정의 전량
 * @param {{caseId: string, outcome: string}[]} outcomes 채점 결과
 * @returns {{denominator: number, detected: number, missed: number, invalid: number, ratio: number}}
 */
export function tally(caseDefs, outcomes) {
  const denominator = caseDefs.length;
  const byId = new Map(outcomes.map((o) => [o.caseId, o.outcome]));
  let detected = 0;
  let missed = 0;
  let invalid = 0;
  for (const def of caseDefs) {
    const outcome = byId.get(def.caseId);
    if (outcome === undefined) {
      // 채점되지 않은 케이스는 분모에서 빠지는 것이 아니라 INVALID다.
      invalid += 1;
      continue;
    }
    if (DETECTING_OUTCOMES.includes(outcome)) detected += 1;
    else if (outcome === OUTCOME.MISSED) missed += 1;
    else invalid += 1;
  }
  const ratio = denominator === 0 ? 0 : detected / denominator;
  return { denominator, detected, missed, invalid, ratio };
}

/**
 * 게이트 판정. 수치는 `spec.md` 구현 9단계·AC-8이 정본이다.
 *
 * - 기계 3종: 3회 **모두 100%**.
 * - LLM 1종: 3회 **최저값 80% 이상**.
 * - 회차 편차 20%p 초과: FAIL이 아니라 **지표 신뢰도 경고**. 종당 20건으로 1회에 한해
 *   증설한 뒤 동일 비율로 재판정하고, 증설 후에도 넘으면 FAIL로 확정한다.
 *
 * **재실행 최고값을 채택하는 경로를 두지 않는다** — 입력은 회차 배열이고 판정은 최저값과
 * 편차로만 이뤄진다.
 *
 * @param {{kind: string, ratios: number[], expanded?: boolean}} input
 * @returns {{pass: boolean, warning: string|null, min: number, spread: number, reason: string}}
 */
export function evaluateGate({ kind, ratios, expanded = false }) {
  if (!Array.isArray(ratios) || ratios.length === 0) {
    return { pass: false, warning: null, min: 0, spread: 0, reason: "회차가 0건 — 미제출은 0%가 아니라 판정 불가다" };
  }
  const min = Math.min(...ratios);
  const spread = Math.max(...ratios) - min;
  const isMachine = MACHINE_KINDS.includes(kind);
  const threshold = isMachine ? 1 : 0.8;
  const meets = min >= threshold;

  if (spread > 0.2) {
    if (expanded) {
      return { pass: false, warning: null, min, spread, reason: "증설 후에도 회차 편차가 20%p를 넘음 — FAIL로 확정하고 FactChecker 프롬프트를 고친다" };
    }
    return {
      pass: false,
      warning: "지표 신뢰도 경고 — 종당 20건으로 1회에 한해 증설한 뒤 동일 비율 기준으로 재판정한다",
      min,
      spread,
      reason: "회차 편차 20%p 초과",
    };
  }
  return {
    pass: meets,
    warning: null,
    min,
    spread,
    reason: meets ? "수용선 충족" : `3회 최저값 ${(min * 100).toFixed(1)}%가 수용선 ${(threshold * 100).toFixed(0)}% 미만`,
  };
}
