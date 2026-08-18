// scripts/lib/invariants.mjs
//
// AC-6 (i)~(iv) 및 절단 전역 불변식 (T-1)(T-2)의 기계 검사 구현.
//
// scripts/lib/schema-validate.mjs(validateInstance)는 evidence.json의
// "구조"(필드 존재·타입·enum·같은 객체 안의 if/then)만 검증한다. 이 모듈이
// 검사하는 것은 필드들 "사이의" 관계 — 배열 원소 합계 검산, 커밋 레벨
// 값과 files[] 항목 합의 일치, isMerge와 parents.length의 교차 판정
// 오라클, 그리고 truncated(형제 객체 coverage 소속 필드 samplingMethod와의
// 동치) — 인데, 이런 교차 필드 검산은 이 저장소의 의존성 0 자작 JSON
// Schema 서브셋 검증기로는 표현할 수 없다(T-2는 특히 truncated.reason과
// coverage.samplingMethod가 서로 다른 형제 객체에 있어 순수 if/then으로
// 표현하면 스키마 두 정의를 서로 참조해야 하는데, 이 검증기는 그런
// 교차 객체 조건부를 지원하지 않는다).
//
// schemas/evidence.schema.json의 x-invariant-note가 "실제 교차 검사는
// scripts/verify-evidence.mjs / validate-plugin.mjs가 수행한다(AC-6)"고
// 약속한 지점이 이 모듈이다. scripts/validate-plugin.mjs의
// `--schema-check <evidence.json>` 경로가 구조 검증(validateInstance)
// 다음 단계로 이 모듈의 checkEvidenceInvariants()를 호출해 그 약속을
// 실제로 이행한다(구현 이월 게이트 C 배선 위치).
//
// 이 Run의 배경(plan_critic_findings.md 이월 게이트 A-1/A-2, 임무 지침 사고
// 실험 M-a/M-e)이 정확히 지목한 두 개별 검사:
//   (ii)만 있고 (i)만으로는 못 잡는 것 — viaMerge:true 부여를 통째로
//     누락해도 (i)(커밋 레벨 == files[] 필터 합)는 필터가 항등 필터가
//     되어 자기충족 PASS 한다(M-a). (ii)가 isMerge===true 커밋의 files[]
//     전항목 viaMerge:true를 직접 요구해야만 이 누락을 잡는다.
//   (i)만 있고 (ii)가 없으면 못 잡는 것의 반대쪽 — 머지 유입 항목을
//     포함해 커밋 레벨 합계를 구하는(필터를 아예 제거한) 구현(M-e)은
//     (i)를 "자기 자신과" 비교하는 형태로 잘못 재정의하지 않는 한 (i)에서
//     그대로 잡힌다 — 이 모듈의 (i)는 항상 원장의 files[]로부터 독립
//     재계산한 합과 비교하므로 자기충족이 불가능하다.

function isQuantityCountedFile(f) {
  return f?.viaMerge !== true && f?.binary !== true;
}

/**
 * T-1 (JS 레벨 방어적 재확인). schemas/evidence.schema.json의
 * `truncated.allOf`(if reason==="none" then dropped_commits const 0 /
 * if reason==="budget_commits" then dropped_commits minimum 1)가 이미
 * 이 동치를 구조적으로 완결한다(enum이 두 값뿐이므로 두 if/then이 합쳐져
 * 양방향 동치가 된다) — 이 함수는 그 사실에 의존하지 않고 evidence.json
 * 값만으로 독립 재확인해, 검사 지점을 이 모듈 한 곳(AC-6 교차 검사 전체)
 * 으로 모은다.
 *
 * @param {object} evidence
 * @returns {{code: string, message: string}[]}
 */
export function checkTruncatedDroppedCommitsInvariant(evidence) {
  const reason = evidence?.truncated?.reason;
  const dropped = evidence?.truncated?.dropped_commits;
  const droppedPositive = typeof dropped === "number" && dropped > 0;
  const reasonNotNone = reason !== "none";
  if (droppedPositive !== reasonNotNone) {
    return [{
      code: "EVIDENCE_INVARIANT_T1_VIOLATION",
      message:
        `T-1 위반(dropped_commits>0 ⟺ reason!="none"): truncated.dropped_commits=${dropped}` +
        `(양수=${droppedPositive})와 truncated.reason='${reason}'(none 아님=${reasonNotNone})가 동치가 아닙니다.`,
    }];
  }
  return [];
}

/**
 * T-2: truncated.reason==="none" ⟺ coverage.samplingMethod==="none:full-scan".
 * 픽스처 종류와 무관한 전역 불변식(구현 이월 게이트 A-1). "절단해 놓고
 * 절단 없음이라 선언"하는 조합(reason:"none" 자기선언 + 실제로는 절단된
 * samplingMethod, 또는 그 역)을 여기서 닫는다.
 *
 * @param {object} evidence
 * @returns {{code: string, message: string}[]}
 */
export function checkTruncatedSamplingMethodInvariant(evidence) {
  const reason = evidence?.truncated?.reason;
  const method = evidence?.coverage?.samplingMethod;
  const isNoneReason = reason === "none";
  const isFullScanMethod = method === "none:full-scan";
  if (isNoneReason !== isFullScanMethod) {
    return [{
      code: "EVIDENCE_INVARIANT_T2_VIOLATION",
      message:
        `T-2 위반(reason=="none" ⟺ samplingMethod=="none:full-scan"): truncated.reason='${reason}'` +
        `(none=${isNoneReason})과 coverage.samplingMethod='${method}'(full-scan=${isFullScanMethod})가 동치가 아닙니다.`,
    }];
  }
  return [];
}

/**
 * AC-6 (i): 모든 커밋에서 커밋 레벨 insertions/deletions ==
 * `viaMerge !== true`이고 `binary !== true`인 files[] 항목의 합.
 * files[]로부터 독립 재계산한 값과 비교하므로(원장의 insertions/
 * deletions 필드 자신을 다시 읽는 것이 아니다) 자기충족이 불가능하다.
 *
 * @param {object} evidence
 * @returns {{code: string, message: string}[]}
 */
export function checkCommitLevelSumInvariant(evidence) {
  const violations = [];
  for (const c of evidence?.commits ?? []) {
    const files = c.files ?? [];
    const counted = files.filter(isQuantityCountedFile);
    const expectedIns = counted.reduce((s, f) => s + (f.insertions ?? 0), 0);
    const expectedDel = counted.reduce((s, f) => s + (f.deletions ?? 0), 0);
    if (c.insertions !== expectedIns || c.deletions !== expectedDel) {
      violations.push({
        code: "EVIDENCE_INVARIANT_AC6_I_VIOLATION",
        message:
          `AC-6 (i) 위반: 커밋 ${c.hash ?? c.id}의 커밋 레벨 insertions/deletions(${c.insertions}/${c.deletions})가 ` +
          `files[](viaMerge!==true, binary!==true) 합(${expectedIns}/${expectedDel})과 다릅니다.`,
      });
    }
  }
  return violations;
}

/**
 * AC-6 (ii): `isMerge === true`인 커밋은 files[] 전 항목이 viaMerge:true이고
 * 커밋 레벨 insertions/deletions가 0. `viaMerge` 부여 누락을 잡는 유일한
 * 검사 — 판정 오라클은 `viaMerge` 자신이 아니라 원장의 `isMerge`다.
 *
 * @param {object} evidence
 * @returns {{code: string, message: string}[]}
 */
export function checkMergeViaMergeInvariant(evidence) {
  const violations = [];
  for (const c of evidence?.commits ?? []) {
    if (c.isMerge !== true) continue;
    const files = c.files ?? [];
    const nonViaMerge = files.filter((f) => f.viaMerge !== true);
    if (nonViaMerge.length > 0) {
      violations.push({
        code: "EVIDENCE_INVARIANT_AC6_II_VIOLATION",
        message:
          `AC-6 (ii) 위반: 머지 커밋 ${c.hash ?? c.id}의 files[] ${files.length}건 중 ${nonViaMerge.length}건이 ` +
          `viaMerge:true가 아닙니다(경로: ${nonViaMerge.map((f) => f.path).join(", ")}).`,
      });
    }
    if (c.insertions !== 0 || c.deletions !== 0) {
      violations.push({
        code: "EVIDENCE_INVARIANT_AC6_II_VIOLATION",
        message:
          `AC-6 (ii) 위반: 머지 커밋 ${c.hash ?? c.id}의 커밋 레벨 insertions/deletions(${c.insertions}/${c.deletions})가 0이 아닙니다.`,
      });
    }
  }
  return violations;
}

/**
 * AC-6 (iii): `isMerge === (parents.length >= 2)` — 괄호 안 정의가 아니라
 * 원장의 모든 커밋에 대해 성립해야 하는 기계 검사 불변식. `%P` 누락으로
 * 전 커밋 parents:[]·isMerge:false가 된 구현에서 (ii)가 공허 통과하는
 * 경로를 여기서 막는다(오라클의 정확성 축 — 비공허성은 checkMergeNonVacuous).
 *
 * @param {object} evidence
 * @returns {{code: string, message: string}[]}
 */
export function checkIsMergeOracleInvariant(evidence) {
  const violations = [];
  for (const c of evidence?.commits ?? []) {
    const parents = Array.isArray(c.parents) ? c.parents : [];
    const expected = parents.length >= 2;
    if (c.isMerge !== expected) {
      violations.push({
        code: "EVIDENCE_INVARIANT_AC6_III_VIOLATION",
        message:
          `AC-6 (iii) 위반: 커밋 ${c.hash ?? c.id}의 isMerge=${c.isMerge}가 parents.length(${parents.length})>=2` +
          `(=${expected})와 다릅니다.`,
      });
    }
  }
  return violations;
}

/**
 * M-f 대응: `coverage.traversed`가 `coverage.total`(또는 `analyzed`)을
 * 그대로 복사한 값이 아니라 실제 순회 총계인지를 교차 검사한다.
 * collectGitFacts()의 실제 구성상 `traversed === total + excludedCount`
 * (population + 제외 커밋 = 순회 전체)가 항상 성립하고, 원장의
 * `commits[]`에는 제외 커밋이 전량 등재되므로(`excluded===true` 건수 ==
 * `traversed - total`) 이 등식은 원장 자신의 `commits[]`만으로 독립
 * 재계산할 수 있다(coverage 필드 자신을 다시 읽는 자기충족이 아니다).
 * 부가로 `analyzed <= total <= traversed` 순서 관계도 함께 검사한다 —
 * `traversed`에 `total`을 그대로 복사한 구현은 이 부등식에서도 잡히지만
 * (제외 커밋이 0건인 축소 픽스처에서는 등식 3개가 전부 같아져 순서
 * 관계만으로는 공허 통과할 수 있으므로) 두 검사를 모두 둔다.
 *
 * @param {object} evidence
 * @returns {{code: string, message: string}[]}
 */
export function checkCoverageTraversedInvariant(evidence) {
  const coverage = evidence?.coverage ?? {};
  const { traversed, total, analyzed } = coverage;
  const violations = [];

  if (typeof traversed !== "number" || typeof total !== "number") {
    return violations; // 구조 검증(required/type)이 이미 잡을 형태 — 여기서는 방어적으로 건너뜀.
  }

  const excludedCount = (evidence?.commits ?? []).filter((c) => c.excluded === true).length;
  const expectedTraversed = total + excludedCount;
  if (traversed !== expectedTraversed) {
    violations.push({
      code: "EVIDENCE_INVARIANT_COVERAGE_TRAVERSED_VIOLATION",
      message:
        `coverage.traversed(${traversed})가 coverage.total(${total}) + commits[]의 excluded===true 건수(${excludedCount})` +
        `=${expectedTraversed}와 다릅니다(M-f: traversed에 total/analyzed를 그대로 복사하는 오구현을 잡는 검사).`,
    });
  }

  if (typeof analyzed === "number" && !(analyzed <= total && total <= traversed)) {
    violations.push({
      code: "EVIDENCE_INVARIANT_COVERAGE_ORDER_VIOLATION",
      message:
        `coverage.analyzed(${analyzed}) <= coverage.total(${total}) <= coverage.traversed(${traversed}) ` +
        "순서 관계가 성립하지 않습니다.",
    });
  }

  return violations;
}

/**
 * 절단·머지 관련 전역 교차 불변식(T-1, T-2, AC-6 (i)(ii)(iii), coverage
 * 3수치 관계)을 모두 실행해 위반을 합쳐 반환한다. `--schema-check
 * <evidence.json>`의 프로덕션 진입점(scripts/validate-plugin.mjs)이 구조
 * 검증 다음 단계로 호출한다.
 *
 * AC-6 (iv)(비공허성)는 여기 포함하지 않는다 — 머지 커밋이 없는 정상
 * evidence.json(대다수 실행)에도 무조건 적용하면 참인 산출물을 거짓
 * FAIL로 만든다. (iv)는 머지 커밋 존재가 픽스처 구성상 보장된 경우에만
 * checkMergeNonVacuous()를 별도로 호출한다(예: merge 픽스처의 골든/스모크
 * 검사).
 *
 * @param {object} evidence
 * @returns {{code: string, message: string}[]}
 */
export function checkEvidenceInvariants(evidence) {
  return [
    ...checkTruncatedDroppedCommitsInvariant(evidence),
    ...checkTruncatedSamplingMethodInvariant(evidence),
    ...checkCommitLevelSumInvariant(evidence),
    ...checkMergeViaMergeInvariant(evidence),
    ...checkIsMergeOracleInvariant(evidence),
    ...checkCoverageTraversedInvariant(evidence),
  ];
}

/**
 * AC-6 (iv): merge 픽스처의 원장에 `isMerge === true`인 커밋이 최소 1건
 * 존재하고 그 `parents.length == 2`. (ii)(iii)의 비공허성 검사이며,
 * 머지 커밋 존재가 보장된 픽스처(merge 시나리오, 300커밋 픽스처 등)에
 * 대해서만 호출한다 — 일반 evidence.json에 무조건 적용하는 함수가
 * 아니다(위 checkEvidenceInvariants 참조).
 *
 * @param {object} evidence
 * @returns {{code: string, message: string}[]}
 */
export function checkMergeNonVacuous(evidence) {
  const merges = (evidence?.commits ?? []).filter((c) => c.isMerge === true);
  if (merges.length === 0) {
    return [{
      code: "EVIDENCE_INVARIANT_AC6_IV_VACUOUS",
      message:
        "AC-6 (iv) 위반: isMerge===true인 커밋이 원장에 0건이라 (ii)(iii) 검사가 이 원장에서는 공허하게 통과합니다(비공허성 실패).",
    }];
  }
  const badParentCount = merges.filter((c) => (Array.isArray(c.parents) ? c.parents.length : 0) !== 2);
  return badParentCount.map((c) => ({
    code: "EVIDENCE_INVARIANT_AC6_IV_VIOLATION",
    message: `AC-6 (iv) 위반: 머지 커밋 ${c.hash ?? c.id}의 parents.length가 2가 아닙니다(${(c.parents ?? []).length}).`,
  }));
}
