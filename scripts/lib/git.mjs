// scripts/lib/git.mjs
//
// 구현 5·6단계가 명령한 "공유 git 호출 계층"의 단일 구현. §7·구현 5단계·
// 구현 6단계가 요구하는 세 계약을 이 파일 하나에 둔다 — scripts/collect-
// git-facts.mjs(구현 5단계)와 scripts/verify-evidence.mjs(구현 6단계)가
// 이 파일을 동일하게 import해서 쓴다(둘 다 이 레포에 이미 구현돼 있다).
// 계약이 두 곳에 따로 구현되면 (exit code, stderr 패턴) 3분류나 머지 diff
// 산식이 드리프트할 위험이 있다 — 이 파일이 그 드리프트를 원천 차단한다.
//
// 계약 1 — 고정 프리픽스: 모든 git 호출은
//   `git -C <repo> --no-pager -c core.quotepath=false -c i18n.logOutputEncoding=UTF-8`
//   를 인자 배열로만 조합한다(셸 문자열 조합·Invoke-Expression류 금지).
//
// 계약 2 — (exit code, stderr 패턴) 3분류:
//   0            → "ok"
//   1            → "lookup-failed"(조회 실패 — 인용 FAIL로 집계)
//   128 + 알려진 조회 실패 stderr 패턴
//                → "lookup-failed"(rev-parse --verify에 --quiet를 안 붙였을 때의
//                   구제 경로 — 이 파일의 함수들은 가능하면 --quiet를 붙여 애초에
//                   exit 1로 정규화하고, 이 패턴 매칭은 --quiet를 못 붙이는 호출
//                   (예: git show/cat-file)을 위한 것이다)
//   그 외 128 · 129 이상
//                → "tool-error"(도구·레포 오류 — 별도 리포트, 인용 FAIL 미집계)
//
// 계약 3 — 머지 의미론: 커밋 M의 파일 변경 집합은 항상
//   `git diff --numstat -z <M의 1부모 또는 EMPTY_TREE_SHA(루트 커밋)> M`
//   로 계산한다(= 스펙 리터럴 "git diff --numstat -z M^1 M"의 일반화 —
//   루트 커밋은 부모가 없으므로 git의 빈 트리 상수를 1부모 자리에 대신
//   쓴다). 커밋 순회에는 `--first-parent`를 쓰지 않는다(사이드 브랜치
//   소실 방지) — 이 파일의 어떤 함수도 그 옵션을 추가하지 않는다.
//
//   실측 확인(이 프로젝트 fixtures/merge 시나리오 동등 구조로 별도 검증):
//   `git show --numstat --format= -z <merge>`는 `git diff --numstat -z
//   <merge>^1 <merge>`와 값이 같지만, **`git show --name-status --format=
//   -z <merge>`는 기본 diff-merges 설정에서 완전히 빈 출력을 낸다**(git
//   show/log가 머지 커밋의 patch/name-status를 기본적으로 생략하기
//   때문 — numstat만 예외적으로 1부모 통계를 보여주는 legacy 특수
//   동작이다). 이 비대칭 때문에 changeType(A/M/D/R) 판정에 필요한
//   name-status를 `git show`로는 얻을 수 없어, 이 파일은 항상 명시적
//   2-트리 `git diff --numstat -z <base> <sha>` / `git diff --name-status
//   -z <base> <sha>` 형태만 쓴다(머지·루트·일반 커밋 전부 동일 코드 경로).

import { spawnSync } from "node:child_process";

/** §7 정본 프리픽스. 모든 호출에 강제한다.
 *
 * `diff.renames=true`·`diff.renameLimit=0`(무제한)을 추가로 고정한다(콜드
 * 리뷰 M 대응) — 이 둘을 고정하지 않으면 사용자 gitconfig의
 * `diff.renames=false` 한 줄로 같은 레포·같은 인자에서 files[] 건수·
 * changeType·oldPath·커밋 레벨 insertions/deletions·contentHash가 전부
 * 달라진다(리네임이 D+A로 갈라짐). 명시 고정으로 "읽는 사람의 gitconfig에
 * 무관한 결정적 원장"을 실제로 보장한다. */
export const GIT_FIXED_PREFIX_ARGS = [
  "--no-pager",
  "-c", "core.quotepath=false",
  "-c", "i18n.logOutputEncoding=UTF-8",
  "-c", "diff.renames=true",
  "-c", "diff.renameLimit=0",
];

/** git이 어디서나 인식하는 "빈 트리" 고정 SHA(오브젝트 DB에 실재하지
 * 않아도 git이 특별 취급한다). 루트 커밋(부모 없음)의 diff 기준(base)으로
 * 쓴다 — `git diff --numstat -z <EMPTY_TREE_SHA> <rootSha>`는 루트 커밋의
 * 전체 파일을 A(added)로 정확히 보고한다(실측 확인). */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// 조회 실패로 간주하는 stderr 패턴(계약 2). 이 배열의 정본은 이 파일
// 하나이며 verify-evidence.mjs도 이를 import해서 쓴다.
const LOOKUP_FAILED_STDERR_PATTERNS = [
  /bad object/i,
  /unknown revision/i,
  /Needed a single revision/i,
  /does not exist in/i,
];

/**
 * (exit code, stderr) 쌍을 3분류 중 하나로 판정한다(계약 2).
 * @param {number} status
 * @param {string} stderr
 * @returns {"ok"|"lookup-failed"|"tool-error"}
 */
export function classifyGitOutcome(status, stderr) {
  if (status === 0) return "ok";
  if (status === 1) return "lookup-failed";
  if (status === 128 && LOOKUP_FAILED_STDERR_PATTERNS.some((p) => p.test(stderr ?? ""))) {
    return "lookup-failed";
  }
  return "tool-error";
}

/**
 * git을 인자 배열로 스폰한다(셸 문자열 조합 금지 — §7). execFileSync와
 * 달리 non-zero exit에서도 예외를 던지지 않고 {status, stdout, stderr}를
 * 그대로 반환한다 — 호출자가 classifyGitOutcome으로 분류하게 한다.
 *
 * @param {string} repoPath
 * @param {string[]} args `-C <repoPath>` 및 고정 프리픽스 뒤에 붙는 나머지 인자
 * @param {{maxBuffer?: number}} [opts]
 * @returns {{status: number, stdout: string, stderr: string, outcome: "ok"|"lookup-failed"|"tool-error"}}
 */
export function runGit(repoPath, args, opts = {}) {
  const result = spawnSync(
    "git",
    ["-C", repoPath, ...GIT_FIXED_PREFIX_ARGS, ...args],
    {
      encoding: "utf8",
      maxBuffer: opts.maxBuffer ?? 1024 * 1024 * 256,
    }
  );

  if (result.error) {
    // git 실행 파일 자체를 못 찾는 등 스폰 실패 — git 프로세스가 시작조차
    // 못 했으므로 exit code 개념이 없다. "도구 오류"로 취급한다.
    return {
      status: -1,
      stdout: "",
      stderr: String(result.error.message ?? result.error),
      outcome: "tool-error",
    };
  }

  const status = result.status ?? (result.signal ? 129 : 0);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status, stdout, stderr, outcome: classifyGitOutcome(status, stderr) };
}

/**
 * `git rev-parse --verify --quiet <sha>^{commit}` — 커밋 실존성 검사(AC-7
 * (b)축). `--quiet`를 붙였으므로 조회 실패는 stderr 패턴에 기대지 않고
 * 항상 exit 1로 정규화된다(스펙이 명시한 예외 회피 경로).
 *
 * @param {string} repoPath
 * @param {string} sha
 * @returns {{ok: boolean, status: number, stderr: string, outcome: "ok"|"lookup-failed"|"tool-error"}}
 */
export function revParseVerifyCommit(repoPath, sha) {
  const r = runGit(repoPath, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
  return { ok: r.outcome === "ok", status: r.status, stderr: r.stderr, outcome: r.outcome };
}

/**
 * `git rev-parse --verify --quiet HEAD` — HEAD가 존재하는(=커밋이 최소
 * 1개 있는) 레포인지 확인한다. unborn branch(0커밋)에서 exit 1을 낸다
 * (실측 확인). collect-git-facts.mjs가 이 함수로 "빈 레포" 여부를 판정해
 * `git log`를 아예 호출하지 않는 경로로 분기한다(예외 중단 방지).
 *
 * @param {string} repoPath
 * @returns {boolean}
 */
export function hasAnyCommitOnHead(repoPath) {
  const r = runGit(repoPath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return r.outcome === "ok";
}

/**
 * `git rev-parse --is-shallow-repository` — shallow clone(`.git/shallow`
 * 존재) 여부를 판정한다(콜드 리뷰 C3 대응 — 이 값을 모르면 shallow 경계
 * 커밋의 부모 없음(grafted)을 진짜 루트 커밋으로 오인해 빈 트리와 diff해
 * 코드베이스 전체를 그 커밋 1건의 신규 작성분(A)으로 집계하게 된다).
 * 조회 자체가 실패하면(매우 드묾) 안전하게 false를 반환한다 — 호출자가
 * 이 신호만으로 shallow 여부를 100% 신뢰하지 않도록, 실제 판정은 항상
 * `.git/shallow` 파일의 실재 여부(getShallowBoundaryHashes)와 함께 쓴다.
 *
 * @param {string} repoPath
 * @returns {boolean}
 */
export function isShallowRepository(repoPath) {
  const r = runGit(repoPath, ["rev-parse", "--is-shallow-repository"]);
  if (r.outcome !== "ok") return false;
  return r.stdout.trim() === "true";
}

/**
 * `git rev-parse --absolute-git-dir` — 이 레포의 `.git` 디렉터리 절대경로.
 * worktree/submodule 등 `.git`이 단순 하위 디렉터리가 아닌 경우에도
 * 정확한 경로를 돌려준다(shallow 경계 판정에 필요 — `.git/shallow` 파일의
 * 실제 위치).
 *
 * @param {string} repoPath
 * @returns {string|null} 조회 실패 시 null
 */
export function getAbsoluteGitDir(repoPath) {
  const r = runGit(repoPath, ["rev-parse", "--absolute-git-dir"]);
  if (r.outcome !== "ok") return null;
  return r.stdout.trim();
}

/**
 * `git show -s --format=%ae<US>%P <sha>` — 커밋 실존성·저자 이메일·부모를
 * 단일 호출로 동시에 얻는다(콜드 리뷰 M 대응 — verify-evidence.mjs의
 * (a)축이 원장의 authorEmail·isMerge를 그대로 신뢰해 동료 커밋을 3필드
 * 편집으로 「본인 실적」으로 통과시킬 수 있던 문제. (b)(c)축은 이미 git을
 * 독립 오라클로 쓰는데 저자·머지 판정 축에는 오라클이 없었다). 존재하지
 * 않는 40자 hex는 `git rev-parse --verify`와 동일하게 exit 128 +
 * "fatal: bad object <sha>"를 내므로(실측 확인) LOOKUP_FAILED_STDERR_PATTERNS가
 * 그대로 잡아 "lookup-failed"로 정규화된다 — 별도 --quiet 상당 처리가
 * 필요 없다. 손상된 loose object는 "error: object file ... is empty" +
 * "fatal: bad object"를 내며 이 역시 lookup-failed로 분류된다(실측 확인).
 *
 * @param {string} repoPath
 * @param {string} sha
 * @returns {{outcome: "ok"|"lookup-failed"|"tool-error", status: number,
 *   stderr: string, authorEmail: string|null, parents: string[]|null}}
 */
export function getCommitAuthorAndParents(repoPath, sha) {
  const r = runGit(repoPath, ["show", "-s", `--format=%ae${US}%P`, sha]);
  if (r.outcome !== "ok") {
    return { outcome: r.outcome, status: r.status, stderr: r.stderr, authorEmail: null, parents: null };
  }
  const [authorEmailRaw, parentsRaw = ""] = r.stdout.trim().split(US);
  const parents = parentsRaw.trim().length ? parentsRaw.trim().split(/\s+/) : [];
  return { outcome: "ok", status: r.status, stderr: "", authorEmail: authorEmailRaw, parents };
}

/**
 * 옵트인 스니펫 인용 전용: `git cat-file -e <sha>:<path>`. 원장의
 * changeType이 D이거나 oldPath 계열 항목에는 적용하지 않는다(호출자
 * 책임 — 이 함수 자체는 판단하지 않는다). 삭제된 경로에 대해서는
 * "does not exist in" 패턴과 함께 exit 128을 낸다(실측 확인, 스펙 배경
 * §의 근거 문단).
 *
 * @param {string} repoPath
 * @param {string} sha
 * @param {string} filePath
 * @returns {{ok: boolean, status: number, stderr: string, outcome: "ok"|"lookup-failed"|"tool-error"}}
 */
export function catFileExists(repoPath, sha, filePath) {
  const r = runGit(repoPath, ["cat-file", "-e", `${sha}:${filePath}`]);
  return { ok: r.outcome === "ok", status: r.status, stderr: r.stderr, outcome: r.outcome };
}

// ---------------------------------------------------------------------------
// 커밋 순회 — %P를 반드시 포함한다(구현 2단계 경고: 빠뜨리면 전 커밋이
// parents:[]가 되어 AC-6 (ii)가 공허하게 PASS 한다).
// ---------------------------------------------------------------------------

const US = "\x1f"; // Unit Separator — 필드 구분자
const RS = "\x1e"; // Record Separator — 커밋 레코드 구분자

// 필드 순서: hash, parents(공백 구분), authorEmail, authorDate(ISO 8601,
// 오프셋 포함), authorEpoch(unix seconds — 정렬/샘플링 전용 내부 값,
// 최종 evidence.json 스키마에는 포함하지 않는다), subject, body(원문,
// Co-authored-by 트레일러 파싱용). body는 항상 마지막 필드로 두어, 본문에
// 개행이 섞여도 레코드 구분(RS)과 충돌하지 않게 한다(RS/US는 커밋 메시지에
// 사실상 등장하지 않는 제어 문자).
const LOG_FORMAT = `%H${US}%P${US}%ae${US}%aI${US}%at${US}%s${US}%B${RS}`;

/**
 * 커밋 메시지 본문에서 `Co-authored-by:` 트레일러 원문 줄 전체를 추출한다
 * (구현 2단계 방침 — 값이 아니라 트레일러 원문 전체를 coAuthors[]에 담는다.
 * fixtures/make-fixture.mjs의 buildCoAuthorTrailer가 선언하는 기대값
 * `"Co-authored-by: Alice Kim <alice@example.test>"`이 트레일러 원문
 * 형태이므로 이와 일치시킨다).
 *
 * @param {string} body
 * @returns {string[]}
 */
export function parseCoAuthorTrailers(body) {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^co-authored-by:/i.test(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * `parents.length >= 2`와 항상 같아야 하는 머지 판정(AC-6 (iii)의 정본
 * 구현 — 이 함수 하나로 collect-git-facts.mjs와 미래의 verify-evidence.mjs가
 * 동일한 판정을 공유한다. `viaMerge`/`excluded`에서 역추정하지 않는다).
 *
 * @param {string[]} parents
 * @returns {boolean}
 */
export function isMergeCommit(parents) {
  return parents.length >= 2;
}

/**
 * 커밋 M의 파일 변경 집합 계산에 쓸 diff 기준(base)을 정한다(계약 3).
 * 부모가 있으면 첫 부모, 없으면(루트 커밋) EMPTY_TREE_SHA.
 *
 * @param {string[]} parents
 * @returns {string}
 */
export function getDiffBase(parents) {
  return parents.length > 0 ? parents[0] : EMPTY_TREE_SHA;
}

// `--ref all` 확장 시 실제 커밋이 아닌 유령 항목(stash 엔트리, notes,
// replace, bisect 등)이 딸려 들어오지 않도록 명시 제외한다(콜드 리뷰 M
// 대응 — `git stash push -u` 한 번으로 부모 없는 "untracked files on
// <branch>" 커밋까지 원장에 들어가 개인 스크래치/시크릿 파일 경로가
// evidence.json에 실린다). `--exclude=`는 그 뒤에 오는 ref 선택 옵션
// (`--all`)에만 적용되므로 반드시 `--all`보다 먼저 와야 한다(git-log(1)).
const ALL_REF_EXCLUDES = [
  "--exclude=refs/stash",
  "--exclude=refs/notes/*",
  "--exclude=refs/replace/*",
  "--exclude=refs/bisect/*",
];

/**
 * `git log <ref> --format=<LOG_FORMAT>` 결과를 파싱해 커밋 메타데이터
 * 배열을 반환한다. 파일 변경 집합(files[])은 포함하지 않는다 —
 * 그건 getCommitFileChanges()가 커밋별로 별도 호출해 채운다(전체 로그를
 * 한 번에 --numstat으로 받으면 머지 커밋에 대해 빈 출력이 나오는 git
 * log의 기본 동작과 부딪히므로, §2가 요구하는 "머지는 항상 명시적
 * 1부모 diff로 채운다" 규칙을 지키려면 커밋별 개별 diff 호출이 필요하다
 * — 구현 5단계 산문 참조).
 *
 * **기간(`--since`/`--until`) 필터를 git에 넘기지 않는다**(콜드 리뷰 C2
 * 대응). git의 `--since`/`--until`은 committerDate 기준으로 필터하고
 * (schemas/evidence.schema.json:198이 스스로 "committerDate는 리베이스로
 * 값이 바뀌므로 쓰지 않는다"고 선언한 축과 정면 충돌), 커밋 그래프가
 * authorDate 기준으로 단조롭지 않으면 순회 자체를 조기 중단해 기간 안의
 * 커밋을 조용히 누락시킨다(실측: c1(2025-01)→c2(2019-01)→c3(2019-01)→
 * c4(2025-02) 레포에서 기간 안의 c1이 사라진다). 이 함수는 항상 **기간
 * 무제한으로 전량 순회**하고, 기간 필터는 authorEpochSec을 가진 호출자
 * (collect-git-facts.mjs)가 JS 레벨에서 수행한다 — 축 불일치와 조기
 * 중단을 한 번에 없앤다.
 *
 * HEAD가 unborn branch(0커밋)인 레포에서 `ref: "HEAD"`로 이 함수를
 * 호출하면 안 된다 — 호출 전에 hasAnyCommitOnHead()로 먼저 확인해야
 * 한다(호출자 책임 — 이 함수는 그 사전 확인을 하지 않는다).
 *
 * @param {string} repoPath
 * @param {{ref: "HEAD"|"--all"}} opts
 * @returns {{ok: boolean, commits: object[], outcome: string, stderr: string}}
 *   commits[] 각 항목: {hash, parents, authorEmail, authorDateIso,
 *   authorEpochSec, subject, body, coAuthors, isMerge}
 */
export function listCommitMetadata(repoPath, { ref }) {
  const args = ["log"];
  if (ref === "--all") {
    args.push(...ALL_REF_EXCLUDES, "--all");
  } else {
    args.push("HEAD");
  }
  args.push(`--format=${LOG_FORMAT}`);

  const r = runGit(repoPath, args);
  if (r.outcome !== "ok") {
    return { ok: false, commits: [], outcome: r.outcome, stderr: r.stderr };
  }

  const records = r.stdout.split(RS).map((s) => s.trim()).filter(Boolean);
  const commits = records.map((rec) => {
    const parts = rec.split(US);
    const [hash, parentsRaw, authorEmail, authorDateIso, authorEpochRaw, subject] = parts;
    // body는 마지막 필드 — subject 이후 남은 부분을 US로 재조합(본문에
    // 우연히 US가 섞이는 극단적 경우까지 방어).
    const body = parts.slice(6).join(US);
    const parents = parentsRaw.trim().length ? parentsRaw.trim().split(/\s+/) : [];
    return {
      hash,
      parents,
      authorEmail,
      authorDateIso,
      authorEpochSec: Number(authorEpochRaw),
      subject,
      body,
      coAuthors: parseCoAuthorTrailers(body),
      isMerge: isMergeCommit(parents),
    };
  });

  return { ok: true, commits, outcome: "ok", stderr: "" };
}

// ---------------------------------------------------------------------------
// 파일 변경 집합(files[]) — numstat + name-status 조합.
// ---------------------------------------------------------------------------

/**
 * `--numstat -z` / `--name-status -z` 출력을 NUL 기준으로 토큰화한다.
 * 마지막 빈 토큰(트레일링 NUL로 인한)은 제거한다.
 *
 * 임무 지침 배경 블로커 B(M-b/M-d) 대응: 호출부가 실수로(또는 변이로)
 * `-z`를 빼먹으면 git은 개행 구분 텍스트를 내는데, 그 원시 출력에는
 * NUL(U+0000)이 전혀 나타나지 않는다(경로에 NUL이 올 수 없으므로 이
 * 부재는 항상 신뢰할 수 있는 신호다). 출력이 비어있지 않은데 NUL이
 * 하나도 없으면 여기서 즉시 명확한 오류로 죽는다 — numstat/name-status
 * 건수 비교 가드(getCommitFileChanges)에 닿기도 전에, 또는 그 가드가
 * 우연히 건수까지 일치해(M-d처럼 단일 파일 커밋) 조용히 통과해 버리는
 * 경로 양쪽을 이 지점 하나에서 막는다. 양쪽 호출에서 `-z`를 동시에
 * 제거해도(건수 비교 가드가 우회당하는 변형) 두 호출 모두 이 함수를
 * 거치므로 독립적으로 잡힌다.
 *
 * @param {string} rawZ
 * @param {string} [sourceLabel] 오류 메시지용 호출 출처 표시(예: "numstat").
 * @returns {string[]}
 */
function tokenizeZ(rawZ, sourceLabel = "unknown") {
  if (rawZ.length > 0 && !rawZ.includes("\0")) {
    throw new Error(
      `git.mjs tokenizeZ(source=${sourceLabel}): NUL(\\0) 구분자가 감지되지 않았습니다 — ` +
      `-z 플래그 없이 호출된 git 출력으로 보입니다(경로에는 NUL이 올 수 없으므로 이 판정은 ` +
      `항상 결정적입니다). raw 출력 미리보기(최대 200자): ${JSON.stringify(rawZ.slice(0, 200))}`
    );
  }
  const tokens = rawZ.split("\0");
  while (tokens.length && tokens[tokens.length - 1] === "") tokens.pop();
  return tokens;
}

// 임무 지침 배경 블로커 B 대응: git의 `-z` 없는(기본) --numstat 출력만
// 내는 리네임 축약형("a => b", "d/{a => b}/f") 탐지 패턴. -z 출력은
// 리네임을 항상 oldPath/newPath 2토큰으로 분리해 내보내므로 이 패턴이
// path 필드에 등장하는 것 자체가 -z 누락의 신호다(AC-17이 요구하는
// "리네임 축약형이 원장에 유입되지 않는다"의 파서 레벨 방어).
const RENAME_ABBREVIATION_RE = /\{[^{}]*\s=>\s[^{}]*\}|(?:^|\/)[^/]+\s=>\s[^/]+(?:\/|$)/;

/**
 * 파싱된 path/oldPath 필드 하나가 정상적인 -z 파싱 결과로 보이는지
 * 확인한다. 개행/탭이 섞여 있으면(NUL 대신 개행이 구분자로 쓰여 여러
 * 레코드가 한 필드로 뭉친 경우) 또는 리네임 축약형이 그대로 남아 있으면
 * (-z 없이 호출된 --numstat의 표기가 새지 않아야 함) 조용히 받아들이지
 * 않고 즉시 던진다 — tokenizeZ의 NUL 가드가 어떤 이유로든 우회되더라도
 * 이 파서 레벨에서 한 번 더 방어한다(defense-in-depth).
 *
 * @param {unknown} value
 * @param {string} context 오류 메시지용(예: "parseNumstatTokens path").
 */
function assertPlausiblePathField(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `git.mjs ${context}: path 필드가 비어있거나 문자열이 아닙니다(${JSON.stringify(value)}) — ` +
      "-z 없이 파싱된 손상된 토큰 스트림일 가능성이 높습니다."
    );
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\t")) {
    throw new Error(
      `git.mjs ${context}: path에 개행/탭 문자가 포함되어 있습니다 — NUL(-z) 구분 없이 ` +
      `여러 레코드가 한 필드로 합쳐진 것으로 보입니다: ${JSON.stringify(value.slice(0, 120))}`
    );
  }
  if (RENAME_ABBREVIATION_RE.test(value)) {
    throw new Error(
      `git.mjs ${context}: path에 리네임 축약형('{... => ...}' 또는 'a => b')이 남아 있습니다 — ` +
      `-z 없이 호출된 --numstat/--name-status 출력으로 보입니다: ${JSON.stringify(value)}`
    );
  }
}

const NUMSTAT_LINE_RE = /^(\d+|-)\t(\d+|-)\t(.*)$/s;

/**
 * `--numstat -z` 토큰 스트림을 파싱한다. 일반 변경은 1토큰
 * ("ins\tdel\tpath"), 리네임/카피는 pathPart가 빈 문자열인 레코드 뒤에
 * oldPath, newPath 2토큰이 추가로 온다(스펙 배경 §의 실측 계약).
 *
 * @param {string[]} tokens
 * @returns {{insertions: number|null, deletions: number|null, binary: boolean, path: string, oldPath: string|null}[]}
 *   insertions/deletions는 binary일 때 null(호출자가 0으로 대체하고
 *   binary:true로 기록).
 */
function parseNumstatTokens(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const m = NUMSTAT_LINE_RE.exec(tokens[i]);
    if (!m) {
      i += 1; // 파싱 불가 토큰은 건너뜀(방어적 — 정상 출력에서는 발생하지 않음)
      continue;
    }
    const [, insRaw, delRaw, pathPart] = m;
    const binary = insRaw === "-" || delRaw === "-";
    if (pathPart !== "") {
      assertPlausiblePathField(pathPart, "parseNumstatTokens path");
      out.push({
        insertions: binary ? null : Number(insRaw),
        deletions: binary ? null : Number(delRaw),
        binary,
        path: pathPart,
        oldPath: null,
      });
      i += 1;
    } else {
      // 리네임/카피: 다음 두 토큰이 oldPath, newPath.
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      assertPlausiblePathField(oldPath, "parseNumstatTokens oldPath");
      assertPlausiblePathField(newPath, "parseNumstatTokens newPath");
      out.push({
        insertions: binary ? null : Number(insRaw),
        deletions: binary ? null : Number(delRaw),
        binary,
        path: newPath,
        oldPath,
      });
      i += 3;
    }
  }
  return out;
}

// A/M/D 외에 git이 실제로 낼 수 있는 name-status 단일 코드(콜드 리뷰 C1
// 대응). T(typechange — 예: 일반 파일 ↔ symlink, 서브모듈 전환)는 흔한
// 모노레포·인프라 레포에서 실제로 나타난다. U(unmerged)는 2-트리 diff
// (항상 이 파일이 쓰는 형태)에서는 이론상 나오지 않지만 방어적으로 함께
// 처리한다. schemas/evidence.schema.json의 changeType enum은 A/M/D/R로
// 고정돼 있으므로(하위 계층 호환), 이 코드들은 "M"으로 정규화하고 원본
// 코드는 rawChangeType에 보존한다 — enum을 늘리는 대신 정규화를 택한
// 이유는 numstat과 name-status를 위치(index)로 결합하는 getCommitFileChanges
// 의 정합성(두 배열 길이가 항상 같아야 함)을 지키기 위해서다: 항목을
// "스킵"하면 numstat 쪽 길이와 어긋나 즉시 별도 예외가 나므로(그 자체는
// 안전하지만 진단이 한 겹 더 필요해진다), 정규화가 더 단순하고 항상
// 정렬을 보존한다.
const NORMALIZABLE_SINGLE_PATH_CODES_RE = /^[A-Z]$/;

/**
 * `--name-status -z` 토큰 스트림을 파싱한다. 일반 변경은 2토큰
 * ("STATUS", "path"), 리네임/카피는 3토큰("R100"/"C100", oldPath, newPath).
 * A/M/D/R/C 외의 단일 대문자 코드(T/U/X 등 git이 낼 수 있는 코드)는
 * throw하지 않고 changeType:"M" + rawChangeType:<원본 코드>로 정규화한다
 * (콜드 리뷰 C1 — "알 수 없는 코드에서 프로세스를 죽이는 설계 자체가
 * 문제"). status 토큰 자체가 비어있거나 문자가 아니면(진짜 `-z` 누락·
 * 손상된 스트림 신호) 그때만 throw한다.
 *
 * @param {string[]} tokens
 * @returns {{changeType: "A"|"M"|"D"|"R", path: string, oldPath: string|null, rawChangeType?: string}[]}
 */
function parseNameStatusTokens(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    const code = typeof status === "string" && status.length > 0 ? status[0] : undefined;
    if (code === "R" || code === "C") {
      // 카피(C)는 -C 없이는 이론상 나오지 않지만, 나오더라도 스키마
      // enum(A/M/D/R)에 맞춰 R과 동일한 2-경로 형태로 취급한다.
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      assertPlausiblePathField(oldPath, "parseNameStatusTokens oldPath");
      assertPlausiblePathField(newPath, "parseNameStatusTokens path");
      out.push({ changeType: "R", oldPath, path: newPath });
      i += 3;
    } else if (code === "A" || code === "M" || code === "D") {
      const filePath = tokens[i + 1];
      assertPlausiblePathField(filePath, "parseNameStatusTokens path");
      out.push({ changeType: code, path: filePath, oldPath: null });
      i += 2;
    } else if (typeof code === "string" && NORMALIZABLE_SINGLE_PATH_CODES_RE.test(code)) {
      // T(typechange)·U(unmerged) 등 미지원 단일 코드 — M으로 정규화하고
      // 원본을 rawChangeType에 보존한다(위 주석 참조). 형태는 A/M/D와
      // 동일하게 2토큰(STATUS, path)이다.
      const filePath = tokens[i + 1];
      assertPlausiblePathField(filePath, "parseNameStatusTokens path");
      out.push({ changeType: "M", oldPath: null, path: filePath, rawChangeType: code });
      i += 2;
    } else {
      throw new Error(
        `git.mjs parseNameStatusTokens: name-status 토큰이 손상되었습니다(status=${JSON.stringify(status)}, index=${i}) — ` +
        "관측값이 빈 문자열이거나 대문자 코드가 아닙니다. -z 없이 파싱된 손상된 토큰 스트림일 가능성이 높습니다."
      );
    }
  }
  return out;
}

/**
 * 커밋(또는 머지 M)의 파일 변경 집합을 계약 3대로 계산한다 —
 * `git diff --numstat -z <base> <sha>` + `git diff --name-status -z <base>
 * <sha>`를 같은 base로 각각 호출해 위치(순서)로 결합한다. 같은 diff
 * 파라미터에서 두 포맷은 항상 같은 순서로 파일을 나열한다(실측 확인 —
 * 리네임+수정+추가가 섞인 커밋에서도 순서 일치).
 *
 * @param {string} repoPath
 * @param {string} sha
 * @param {string[]} parents
 * @param {boolean} isMerge parents.length>=2와 항상 같아야 하는 값(호출자가
 *   listCommitMetadata에서 이미 계산해 넘긴다 — 여기서 재계산하지 않는다,
 *   AC-6 (iii)의 유일한 정본은 그 계산 지점 하나).
 * @returns {{ok: boolean, outcome: string, stderr: string, files: object[], insertions: number, deletions: number}}
 *   files[]: {path, oldPath, changeType, insertions, deletions, binary, viaMerge}.
 *   insertions/deletions는 files[] 중 viaMerge!==true && binary!==true 항목의
 *   합(머지 커밋은 files[] 전 항목이 viaMerge:true이므로 항상 0).
 */
export function getCommitFileChanges(repoPath, sha, parents, isMerge) {
  const base = getDiffBase(parents);

  const numstatR = runGit(repoPath, ["diff", "--numstat", "-z", base, sha]);
  if (numstatR.outcome !== "ok") {
    return { ok: false, outcome: numstatR.outcome, stderr: numstatR.stderr, files: [], insertions: 0, deletions: 0 };
  }
  const nameStatusR = runGit(repoPath, ["diff", "--name-status", "-z", base, sha]);
  if (nameStatusR.outcome !== "ok") {
    return { ok: false, outcome: nameStatusR.outcome, stderr: nameStatusR.stderr, files: [], insertions: 0, deletions: 0 };
  }

  // 콜드 리뷰 C1 대응: 아래 파싱·결합 단계가 던지는 예외(예: 정말로 손상된
  // 토큰 스트림, numstat/name-status 건수 불일치)를 여기서 삼켜 기존
  // 3분류 계약("tool-error")로 변환한다. 이전에는 이 예외가 그대로
  // 위(collect-git-facts.mjs)와 verify-evidence.mjs까지 전파돼, 커밋 1건의
  // 파싱 문제로 레포 전체 수집·검증이 미처리 예외 스택 트레이스로 죽었다
  // (실측: enriched 순회 중 어떤 봇/타 저자 커밋 하나가 이 예외를 던지면
  // evidence.json이 한 글자도 안 쓰이고, verify-evidence.mjs 쪽은 try/catch가
  // 아예 없어 리포트 0줄·--out 파일 미기록으로 죽는다).
  try {
    const numstatEntries = parseNumstatTokens(tokenizeZ(numstatR.stdout, "numstat"));
    const nameStatusEntries = parseNameStatusTokens(tokenizeZ(nameStatusR.stdout, "name-status"));

    if (numstatEntries.length !== nameStatusEntries.length) {
      throw new Error(
        `numstat(${numstatEntries.length}건)과 name-status(${nameStatusEntries.length}건) 파일 수가 다릅니다(sha=${sha}, base=${base}) — ` +
        "두 호출이 같은 diff를 가리키지 않는 것으로 보입니다."
      );
    }

    const files = [];
    let insertions = 0;
    let deletions = 0;
    for (let i = 0; i < numstatEntries.length; i++) {
      const n = numstatEntries[i];
      const s = nameStatusEntries[i];
      const viaMerge = isMerge === true;
      const ins = n.binary ? 0 : n.insertions;
      const del = n.binary ? 0 : n.deletions;
      files.push({
        path: s.path,
        oldPath: s.oldPath,
        changeType: s.changeType,
        insertions: ins,
        deletions: del,
        binary: n.binary,
        viaMerge,
        ...(s.rawChangeType ? { rawChangeType: s.rawChangeType } : {}),
      });
      if (!viaMerge && !n.binary) {
        insertions += ins;
        deletions += del;
      }
    }

    return { ok: true, outcome: "ok", stderr: "", files, insertions, deletions };
  } catch (e) {
    return {
      ok: false,
      outcome: "tool-error",
      stderr: `git.mjs getCommitFileChanges 파싱 실패(sha=${sha}, base=${base}): ${e.message}`,
      files: [],
      insertions: 0,
      deletions: 0,
    };
  }
}

// 테스트 전용 export(파서 단위 테스트에 필요 — 프로덕션 로직은 위 공개
// 함수를 통해서만 호출된다).
export const _internal = { tokenizeZ, parseNumstatTokens, parseNameStatusTokens };
