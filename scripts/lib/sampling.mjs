// scripts/lib/sampling.mjs
//
// 구현 5단계가 확정한 정본 `samplingMethod` 리터럴의 프로덕션 구현.
// `fixtures/golden/compute-sampling-golden.mjs`는 이 파일을 참조하지
// 않고 리터럴로부터 독립적으로 재구현한 것이다(그래야 골든이 "이
// 구현의 출력 스냅샷"이 아니라 리터럴 자체에 대한 독립 검증이 된다 —
// PROVENANCE.md 참조). 이 파일은 그 반대편, 즉 `collect-git-facts.mjs`가
// 실제로 호출하는 정본 구현이다. 두 구현이 300커밋 픽스처에서 같은
// 선택 집합을 내는지가 AC-21 (b)의 핵심 게이트다.
//
// 정본 리터럴(schemas/evidence.schema.json의 coverage.samplingMethod
// description과 완전히 동일한 문자열 — 한 글자도 바꾸지 않는다):
//   K=min(max_commits,total);ratio=recent40/churn40/even20;order=recent:
//   (authorDate desc,hash asc),churn:(commitLevelInsertions+
//   commitLevelDeletions desc);floor;remainder→recent;dedup=prior-buckets-
//   excluded,backfill-next-rank;tie=churn:(authorDate desc,hash asc),even:
//   [since,until] equal-split,min(authorDate);even-range-default=
//   [min(authorDate),max(authorDate)];even-backfill=(authorDate asc,hash asc),
//   carry-to-next-bucket

export const CANONICAL_SAMPLING_METHOD_LITERAL =
  "K=min(max_commits,total);ratio=recent40/churn40/even20;order=recent:(authorDate desc,hash asc),churn:(commitLevelInsertions+commitLevelDeletions desc);floor;remainder→recent;dedup=prior-buckets-excluded,backfill-next-rank;tie=churn:(authorDate desc,hash asc),even:[since,until] equal-split,min(authorDate);even-range-default=[min(authorDate),max(authorDate)];even-backfill=(authorDate asc,hash asc),carry-to-next-bucket";

export const NO_TRUNCATION_SAMPLING_METHOD_LITERAL = "none:full-scan";

function byHashAsc(a, b) {
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
}

/** order=recent:(authorDate desc,hash asc) — "최근" 버킷 정렬. */
function sortRecent(commits) {
  return [...commits].sort((a, b) => {
    if (a.authorEpochSec !== b.authorEpochSec) return b.authorEpochSec - a.authorEpochSec;
    return byHashAsc(a, b);
  });
}

/**
 * order=churn:(commitLevelInsertions+commitLevelDeletions desc);
 * tie=churn:(authorDate desc,hash asc) — "변경량" 버킷 정렬. churn은
 * 호출자가 미리 계산해 넘긴 commit.churn(= 커밋 레벨 insertions+deletions,
 * viaMerge/binary 제외 합 — 머지 커밋은 항상 0)을 그대로 쓴다.
 */
function sortChurn(commits) {
  return [...commits].sort((a, b) => {
    if (a.churn !== b.churn) return b.churn - a.churn;
    if (a.authorEpochSec !== b.authorEpochSec) return b.authorEpochSec - a.authorEpochSec;
    return byHashAsc(a, b);
  });
}

/**
 * tie=even:[since,until] equal-split,min(authorDate);
 * even-range-default=[min(authorDate),max(authorDate)];
 * even-backfill=(authorDate asc,hash asc),carry-to-next-bucket — "시간
 * 균등" 버킷. since/until 미지정 실행에서는 range를 모집단 전체의
 * [min(authorDate),max(authorDate)]로 잡는다(호출자가 이미 그렇게 계산해
 * minDate/maxDate로 넘긴다 — since/until 지정 시에도 호출자가 그 값을
 * epoch로 변환해 넘기면 이 함수는 그대로 따른다).
 *
 * 구간이 소진되면(후보 0건) 부족분을 다음 구간의 "요구 수"에 누적
 * 이월하고, 마지막 구간까지 못 채운 몫은 전체 잔여 풀에서
 * (authorDate asc, hash asc) 순으로 최종 보충한다.
 */
function selectEvenBucket(pool, evenCount, minEpoch, maxEpoch) {
  const selected = [];
  const used = new Set();
  const span = maxEpoch - minEpoch;
  const intervalSize = evenCount > 0 ? span / evenCount : 0;

  let carry = 0;
  for (let bucket = 0; bucket < evenCount; bucket++) {
    const want = 1 + carry;
    carry = 0;
    const lo = minEpoch + bucket * intervalSize;
    const hi = bucket === evenCount - 1 ? maxEpoch : minEpoch + (bucket + 1) * intervalSize;
    const candidates = pool
      .filter((c) => !used.has(c.hash) && c.authorEpochSec >= lo && c.authorEpochSec <= hi)
      .sort((a, b) => (a.authorEpochSec !== b.authorEpochSec ? a.authorEpochSec - b.authorEpochSec : byHashAsc(a, b)));

    let taken = 0;
    for (const c of candidates) {
      if (taken >= want) break;
      selected.push(c);
      used.add(c.hash);
      taken += 1;
    }
    if (taken < want) carry += want - taken;
  }

  if (carry > 0) {
    const leftovers = pool
      .filter((c) => !used.has(c.hash))
      .sort((a, b) => (a.authorEpochSec !== b.authorEpochSec ? a.authorEpochSec - b.authorEpochSec : byHashAsc(a, b)));
    for (const c of leftovers) {
      if (carry <= 0) break;
      selected.push(c);
      used.add(c.hash);
      carry -= 1;
    }
  }

  return selected;
}

/**
 * K=min(max_commits,total);ratio=recent40/churn40/even20;floor;
 * remainder→recent;dedup=prior-buckets-excluded,backfill-next-rank
 * 전체를 순서대로 적용해 population에서 K건을 선택한다.
 *
 * @param {{hash: string, authorEpochSec: number, churn: number}[]} population
 *   `excluded !== true`인 커밋만(구현 5단계 — 호출자가 이미 필터링해
 *   넘긴다. 이 함수는 population 자체를 필터링하지 않는다).
 * @param {number} maxCommits
 * @param {{since?: number|null, until?: number|null}} [range] since/until이
 *   epoch(초)로 지정되면 시간 균등 버킷의 range로 쓰고, 없으면
 *   even-range-default(population의 min/max authorDate)를 쓴다.
 * @returns {{K: number, total: number, recentCount: number, churnCount: number,
 *   evenCount: number, selectedHashes: string[]}}
 */
export function computeSampling(population, maxCommits, range = {}) {
  const total = population.length;
  const K = Math.min(maxCommits, total);

  if (K === 0) {
    return { K: 0, total, recentCount: 0, churnCount: 0, evenCount: 0, selectedHashes: [] };
  }

  const recentBase = Math.floor(K * 0.4);
  const churnBase = Math.floor(K * 0.4);
  const evenBase = Math.floor(K * 0.2);
  const remainder = K - (recentBase + churnBase + evenBase);
  const recentCount = recentBase + remainder; // remainder→recent
  const churnCount = churnBase;
  const evenCount = evenBase;

  const recentSelected = sortRecent(population).slice(0, recentCount);
  const recentSet = new Set(recentSelected.map((c) => c.hash));

  const afterRecent = population.filter((c) => !recentSet.has(c.hash));
  const churnSelected = sortChurn(afterRecent).slice(0, churnCount);
  const churnSet = new Set(churnSelected.map((c) => c.hash));

  const afterChurn = afterRecent.filter((c) => !churnSet.has(c.hash));

  let evenSelected = [];
  if (evenCount > 0) {
    const minEpoch = range.since ?? Math.min(...population.map((c) => c.authorEpochSec));
    const maxEpoch = range.until ?? Math.max(...population.map((c) => c.authorEpochSec));
    evenSelected = selectEvenBucket(afterChurn, evenCount, minEpoch, maxEpoch);
  }

  const selected = [...recentSelected, ...churnSelected, ...evenSelected];

  if (selected.length !== K) {
    throw new Error(`샘플링 불변식 위반: 선택 수(${selected.length}) != K(${K})`);
  }
  const uniq = new Set(selected.map((c) => c.hash));
  if (uniq.size !== K) {
    throw new Error("샘플링 불변식 위반: 버킷 간 중복 선택 발생(dedup 실패)");
  }

  return {
    K,
    total,
    recentCount,
    churnCount,
    evenCount,
    selectedHashes: selected.map((c) => c.hash),
  };
}
