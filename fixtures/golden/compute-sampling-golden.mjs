#!/usr/bin/env node
// fixtures/golden/compute-sampling-golden.mjs
//
// 이월 게이트 B-3의 정본 구현: `fixtures/golden/sampling-300.expected.json`의
// "생성 근거"다. 구현 5단계가 정의한 정본 `samplingMethod` 리터럴을 이
// 파일이 직접 파싱·재구현해 선택 집합을 계산한다 — `scripts/collect-git-
// facts.mjs`(아직 존재하지 않음)나 `scripts/lib/git.mjs`(아직 존재하지
// 않음)를 전혀 참조하지 않는다. 즉 이 스크립트가 만드는 골든은 "잘못
// 구현된 수집기의 출력 스냅샷"이 아니라 리터럴로부터의 독립 재계산이다.
//
// 사용법:
//   node fixtures/make-fixture.mjs --out <dir>          # 300커밋 픽스처 준비
//   node fixtures/golden/compute-sampling-golden.mjs <dir>/large300 [--write]
//
// --write 없이 실행하면 stdout에만 출력한다(검토용). --write는
// fixtures/golden/sampling-300.expected.json에 기록한다.
//
// 드리프트 방지: 이 스크립트는 schemas/evidence.schema.json의
// samplingMethod description에서 정본 리터럴을 정규식으로 직접 추출해,
// 아래 하드코딩 사본(HARDCODED_LITERAL)과 완전 일치하는지 실행할 때마다
// 검사한다. 스키마의 리터럴이 바뀌었는데 이 파일을 함께 갱신하지 않으면
// 이 스크립트가 즉시 실패한다(조용한 드리프트를 구조적으로 차단).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OWNER_EMAIL, isBotEmail } from "../make-fixture.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

// spec.md 구현 5단계가 못 박은 정본 리터럴의 사본. schemas/evidence.schema.json
// 의 coverage.samplingMethod description 끝에 박힌 백틱 리터럴과 매 실행마다
// 대조한다(아래 assertNoLiteralDrift).
const HARDCODED_LITERAL =
  "K=min(max_commits,total);ratio=recent40/churn40/even20;order=recent:(authorDate desc,hash asc),churn:(commitLevelInsertions+commitLevelDeletions desc);floor;remainder→recent;dedup=prior-buckets-excluded,backfill-next-rank;tie=churn:(authorDate desc,hash asc),even:[since,until] equal-split,min(authorDate);even-range-default=[min(authorDate),max(authorDate)];even-backfill=(authorDate asc,hash asc),carry-to-next-bucket";

function extractCanonicalLiteralFromSchema() {
  const schemaPath = path.join(REPO_ROOT, "schemas", "evidence.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const desc = schema.$defs?.coverage?.properties?.samplingMethod?.description;
  if (!desc) {
    throw new Error(
      `드리프트 감지 실패: schemas/evidence.schema.json에서 coverage.samplingMethod description을 찾지 못했습니다.`
    );
  }
  const m = /`([^`]+)`\s*$/.exec(desc.trim());
  if (!m) {
    throw new Error(
      `드리프트 감지 실패: samplingMethod description 끝에서 백틱으로 감싼 정본 리터럴을 찾지 못했습니다.`
    );
  }
  return m[1];
}

function assertNoLiteralDrift() {
  const canonical = extractCanonicalLiteralFromSchema();
  if (canonical !== HARDCODED_LITERAL) {
    throw new Error(
      "드리프트 감지: schemas/evidence.schema.json의 samplingMethod 정본 리터럴이 이 재계산 " +
        "스크립트의 하드코딩 사본과 다릅니다. spec.md 구현 5단계 리터럴, 스키마 description, " +
        "이 스크립트(HARDCODED_LITERAL) 세 곳을 모두 대조하십시오.\n" +
        `  스키마: ${canonical}\n  이 스크립트: ${HARDCODED_LITERAL}`
    );
  }
}

// ---------------------------------------------------------------------------
// git 플럼빙 — §7 고정 프리픽스. scripts/lib/git.mjs를 재사용하지 않는다
// (아직 존재하지 않을뿐더러, 존재하더라도 "수집기·검증기와 독립적으로
// 재계산"이라는 이 파일의 목적상 의도적으로 별도 구현을 유지한다).
// ---------------------------------------------------------------------------

const FIXED_ARGS = ["--no-pager", "-c", "core.quotepath=false", "-c", "i18n.logOutputEncoding=UTF-8"];

function gitOut(dir, args) {
  return execFileSync("git", ["-C", dir, ...FIXED_ARGS, ...args], { encoding: "utf8" });
}

const RS = "\x1e";
const US = "\x1f";

/**
 * 레포의 전 커밋(--all)을 순회하며 hash/parents/authorEmail/authorDate/
 * isMerge/churn을 모은다. churn은 비-머지 커밋만 `git show --numstat
 * --format= -z`로 실측하고, 머지 커밋은 스펙 정의대로 항상 0이다(1부모
 * diff로 유입된 files[]는 전부 viaMerge:true라 커밋 레벨 합산에서 빠진다).
 */
function collectCommits(dir) {
  const raw = gitOut(dir, ["log", "--all", `--format=%H${US}%P${US}%ae${US}%at${RS}`]);
  const records = raw.split(RS).map((s) => s.trim()).filter(Boolean);

  const commits = records.map((rec) => {
    const [hash, parentsRaw, authorEmail, authorAt] = rec.split(US);
    const parents = parentsRaw.trim().length ? parentsRaw.trim().split(/\s+/) : [];
    return {
      hash,
      parents,
      authorEmail,
      authorDateEpoch: Number(authorAt),
      isMerge: parents.length >= 2,
    };
  });

  for (const c of commits) {
    if (c.isMerge) {
      c.churn = 0;
      continue;
    }
    const numstatRaw = gitOut(dir, ["show", "--numstat", "--format=", "-z", c.hash]);
    c.churn = sumNumstat(numstatRaw);
  }

  return commits;
}

/**
 * `--numstat -z` 출력을 NUL 기준으로 파싱해 churn(ins+del) 합을 낸다.
 * 일반 변경 레코드는 한 토큰("ins\tdel\tpath")이고, 리네임/카피는 두
 * 토큰으로 나뉜다("ins\tdel\t" 다음에 oldPath, newPath 두 토큰) — 이
 * 파일에서는 경로 자체가 필요 없으므로 소비만 하고 churn 합산에서는
 * 제외 신호(binary "-")만 확인한다.
 */
function sumNumstat(rawZ) {
  const tokens = rawZ.split("\0");
  while (tokens.length && tokens[tokens.length - 1] === "") tokens.pop();

  let sum = 0;
  let i = 0;
  while (i < tokens.length) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
    if (!m) {
      i += 1;
      continue;
    }
    const [, insRaw, delRaw, pathPart] = m;
    const binary = insRaw === "-" || delRaw === "-";
    if (!binary) sum += Number(insRaw) + Number(delRaw);
    i += pathPart === "" ? 3 : 1; // 리네임/카피는 oldPath/newPath 두 토큰을 더 소비
  }
  return sum;
}

// ---------------------------------------------------------------------------
// 샘플링 재계산 — 정본 리터럴의 각 절을 그대로 코드로 옮긴다.
// ---------------------------------------------------------------------------

function byHashAsc(a, b) {
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
}

/**
 * order=recent:(authorDate desc,hash asc) — "최근" 버킷.
 */
function sortRecent(commits) {
  return [...commits].sort((a, b) => {
    if (a.authorDateEpoch !== b.authorDateEpoch) return b.authorDateEpoch - a.authorDateEpoch;
    return byHashAsc(a, b);
  });
}

/**
 * order=churn:(commitLevelInsertions+commitLevelDeletions desc);
 * tie=churn:(authorDate desc,hash asc) — "변경량" 버킷.
 */
function sortChurn(commits) {
  return [...commits].sort((a, b) => {
    if (a.churn !== b.churn) return b.churn - a.churn;
    if (a.authorDateEpoch !== b.authorDateEpoch) return b.authorDateEpoch - a.authorDateEpoch;
    return byHashAsc(a, b);
  });
}

/**
 * tie=even:[since,until] equal-split,min(authorDate);
 * even-range-default=[min(authorDate),max(authorDate)];
 * even-backfill=(authorDate asc,hash asc),carry-to-next-bucket — "시간 균등"
 * 버킷. since/until 미지정 픽스처 실행을 전제하므로 range는
 * [min(authorDate),max(authorDate)](모집단 전체 기준)로 등분한다. 구간이
 * 소진되면(candidate 0건) 그 몫을 다음 구간으로 이월하고, 그래도 남는
 * 몫은 전체 잔여 풀에서 authorDate asc, hash asc 순으로 보충한다.
 */
function selectEvenBucket(pool, evenCount, minDate, maxDate) {
  const selected = [];
  const used = new Set();
  const span = maxDate - minDate;
  const intervalSize = evenCount > 0 ? span / evenCount : 0;

  let carry = 0;
  for (let bucket = 0; bucket < evenCount; bucket++) {
    const want = 1 + carry;
    carry = 0;
    const lo = minDate + bucket * intervalSize;
    const hi = bucket === evenCount - 1 ? maxDate : minDate + (bucket + 1) * intervalSize;
    const candidates = pool
      .filter((c) => !used.has(c.hash) && c.authorDateEpoch >= lo && c.authorDateEpoch <= hi)
      .sort((a, b) => (a.authorDateEpoch !== b.authorDateEpoch ? a.authorDateEpoch - b.authorDateEpoch : byHashAsc(a, b)));

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
      .sort((a, b) => (a.authorDateEpoch !== b.authorDateEpoch ? a.authorDateEpoch - b.authorDateEpoch : byHashAsc(a, b)));
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
 * 전체를 순서대로 적용한다.
 *
 * @param {object[]} population `excluded !== true`인 커밋(구현 5단계 — 봇·
 *   타 저자는 이미 제외된 목록)
 * @param {number} maxCommits
 */
function computeSampling(population, maxCommits) {
  const total = population.length;
  const K = Math.min(maxCommits, total);

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
  const minDate = Math.min(...population.map((c) => c.authorDateEpoch));
  const maxDate = Math.max(...population.map((c) => c.authorDateEpoch));
  const evenSelected = selectEvenBucket(afterChurn, evenCount, minDate, maxDate);

  const selected = [...recentSelected, ...churnSelected, ...evenSelected];

  if (selected.length !== K) {
    throw new Error(`샘플링 재계산 불변식 위반: 선택 수(${selected.length}) != K(${K})`);
  }
  const uniq = new Set(selected.map((c) => c.hash));
  if (uniq.size !== K) {
    throw new Error("샘플링 재계산 불변식 위반: 버킷 간 중복 선택 발생(dedup 실패)");
  }

  return {
    total,
    K,
    recentCount,
    churnCount,
    evenCount,
    selectedHashesSorted: [...selected.map((c) => c.hash)].sort(),
  };
}

// ---------------------------------------------------------------------------
// 공개 API + CLI
// ---------------------------------------------------------------------------

/**
 * @param {string} repoDir `fixtures/make-fixture.mjs`의 large300 픽스처가
 *   실제로 만들어진 디렉터리(`--out <dir>` 실행 결과의 `<dir>/large300`).
 * @param {{maxCommits?: number}} [opts]
 */
export function computeGolden(repoDir, { maxCommits = 50 } = {}) {
  assertNoLiteralDrift();

  const allCommits = collectCommits(repoDir);
  const traversed = allCommits.length;
  const population = allCommits.filter((c) => !isBotEmail(c.authorEmail) && c.authorEmail === OWNER_EMAIL);

  const sampling = computeSampling(population, maxCommits);

  return {
    generatedBy:
      "fixtures/golden/compute-sampling-golden.mjs — 정본 samplingMethod 리터럴의 독립 재계산" +
      "(collect-git-facts.mjs·scripts/lib/git.mjs 미참조, 순수 git 플럼빙 직접 호출)",
    canonicalLiteralVerifiedAgainstSchema: true,
    samplingMethodLiteral: HARDCODED_LITERAL,
    // 이 골든을 재현하는 데 필요한 파라미터 전체. 하나라도 다르면 선택 집합이 달라진다.
    // 기록하지 않으면 재현자가 collect-git-facts.mjs 기본값으로 돌렸다가 불일치를 보고
    // 수집기가 고장난 것으로 오인한다(실제로 머지 설정 차이로 5건이 어긋난 사례가 있었다).
    parameters: {
      maxCommits,
      // population = `excluded !== true`. 아래 세 축이 그 정의를 구성한다.
      identity: OWNER_EMAIL,
      botsExcluded: true,
      // 머지 커밋은 owner 저작이므로 population에 **포함**된다.
      // collect-git-facts.mjs 로 재현하려면 `--merge-included` 를 반드시 지정해야 한다
      // (그 스크립트의 기본값은 머지 제외이므로 지정하지 않으면 total 이 5 작아진다).
      mergeIncluded: true,
      equivalentCollectorInvocation:
        "node scripts/collect-git-facts.mjs --repo <fixture>/large300 " +
        `--identity ${OWNER_EMAIL} --max-commits ${maxCommits} --merge-included`,
    },
    coverage: {
      traversed,
      total: sampling.total,
      analyzed: sampling.K,
      droppedCommits: sampling.total - sampling.K,
    },
    bucketSizes: {
      recent: sampling.recentCount,
      churn: sampling.churnCount,
      even: sampling.evenCount,
    },
    selectedCommitHashesSorted: sampling.selectedHashesSorted,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const repoDir = argv[0];
  const write = argv.includes("--write");

  if (!repoDir) {
    console.error("사용법: node fixtures/golden/compute-sampling-golden.mjs <300커밋-픽스처-repo-dir> [--write]");
    process.exit(2);
  }

  const golden = computeGolden(path.resolve(repoDir));
  const outPath = path.join(SCRIPT_DIR, "sampling-300.expected.json");

  if (write) {
    fs.writeFileSync(outPath, JSON.stringify(golden, null, 2) + "\n", "utf8");
    console.error(`[compute-sampling-golden] 기록됨: ${outPath}`);
  } else {
    console.log(JSON.stringify(golden, null, 2));
  }
}

const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main();
}
