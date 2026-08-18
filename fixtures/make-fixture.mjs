#!/usr/bin/env node
// fixtures/make-fixture.mjs
//
// 구현 4단계(Phase 0-D): 결정적 골든 픽스처 레포 생성기. 의존성 0.
//
// 이 파일은 "L0 수집기(collect-git-facts.mjs)를 위한 입력 레포"만 만든다 —
// 수집기 자체는 아직 존재하지 않는다(다음 Run 몫). 따라서 이 파일이 만드는
// 것은 실제 git 레포(임시 디렉터리)와, 그 레포에 대해 "무엇이 참인지"를
// 선언하는 declared 메타데이터뿐이다. 리네임·삭제 커밋의 path/oldPath 기대값은
// 골든 JSON이 아니라 이 파일의 declared 리터럴이 정본이다(이월 게이트 B-4) —
// 수집기·검증기가 scripts/lib/git.mjs를 공유하는 한 그 둘의 출력 비교만으로는
// `-z` 파싱 버그를 원리적으로 잡을 수 없기 때문이다.
//
// 결정성: 모든 커밋은 GIT_AUTHOR_DATE/GIT_COMMITTER_DATE/이름/이메일을
// 고정하고 GPG 서명·autocrlf를 끈 채로 만든다. Date.now()나 Math.random()은
// 어디에도 쓰지 않는다 — 같은 코드를 두 번 실행하면 완전히 같은 커밋 해시가
// 나와야 한다(AC-5).
//
// CLI:
//   node fixtures/make-fixture.mjs                두 번 실행 비교용: 임시
//                                                  디렉터리에 전 시나리오를
//                                                  만들고 비교 가능한 JSON
//                                                  매니페스트(경로 제외,
//                                                  해시·개수·declared만)를
//                                                  stdout에 출력한 뒤 임시
//                                                  디렉터리를 정리한다.
//   node fixtures/make-fixture.mjs --out <dir>     <dir> 아래 전 시나리오를
//                                                  만들고 정리하지 않는다
//                                                  (fixtures/golden/의 재계산
//                                                  스크립트가 실제 레포를
//                                                  필요로 하므로 이 모드로
//                                                  준비한다).
//   node fixtures/make-fixture.mjs --out <dir> --emit-golden
//                                                  위와 동일 + case (17)
//                                                  머지 해시 주입 산출물을
//                                                  fixtures/golden/
//                                                  case-17-merge-hash-claim.json
//                                                  으로 기록한다(머지 커밋
//                                                  해시가 결정적이므로 이
//                                                  파일 내용도 결정적이다).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 고정 identity — make-fixture.mjs와 fixtures/golden/compute-sampling-golden.mjs
// 양쪽이 이 상수를 그대로 import해서 쓴다(값을 각자 다시 타이핑하면 "선택된
// identity" 정의가 두 곳으로 갈릴 위험이 있다).
// ---------------------------------------------------------------------------

export const OWNER_NAME = "DevCareer Fixture Owner";
export const OWNER_EMAIL = "owner@devcareer-fixture.test";

export const ALICE_NAME = "Alice Kim";
export const ALICE_EMAIL = "alice@example.test";

export const BOB_NAME = "Bob Lee";
export const BOB_EMAIL = "bob@example.test";

export const BOT_DEPENDABOT_NAME = "dependabot[bot]";
export const BOT_DEPENDABOT_EMAIL =
  "49699333+dependabot[bot]@users.noreply.github.com";

export const BOT_GHACTIONS_NAME = "github-actions[bot]";
export const BOT_GHACTIONS_EMAIL =
  "github-actions[bot]@users.noreply.github.com";

/**
 * §5가 열거한 봇 패턴([bot], dependabot, github-actions) 판정. compute-
 * sampling-golden.mjs가 그대로 import해서 쓴다 — 봇 판정 규칙이 두 곳에
 *따로 구현되면 그 자체가 드리프트 지점이 된다.
 */
export function isBotEmail(email) {
  return /\[bot\]/i.test(email) || /dependabot/i.test(email) || /github-actions/i.test(email);
}

// ---------------------------------------------------------------------------
// git 호출 — §7이 강제하는 인자 배열 + 고정 프리픽스. 셸 문자열 조합 금지.
// ---------------------------------------------------------------------------

// §7 정본 프리픽스(`git -C <repo> --no-pager -c core.quotepath=false
// -c i18n.logOutputEncoding=UTF-8`) + 픽스처 생성 전용 안전장치 두 개
// (commit.gpgsign=false, core.autocrlf=false) — 사용자 전역 gitconfig에
// gpg 서명이나 autocrlf가 켜져 있으면 커밋 해시 자체가 비결정적으로 바뀌므로
// 이 두 -c는 스펙의 git 호출 계약이 아니라 이 생성기가 결정성을 지키기 위해
// 추가로 얹는 옵션이다.
const FIXED_ARGS = [
  "--no-pager",
  "-c", "core.quotepath=false",
  "-c", "i18n.logOutputEncoding=UTF-8",
  "-c", "commit.gpgsign=false",
  "-c", "core.autocrlf=false",
];

function runGit(dir, args, env) {
  return execFileSync("git", ["-C", dir, ...FIXED_ARGS, ...args], {
    encoding: "utf8",
    env: env ?? process.env,
    // stderr을 부모 프로세스에 상속시키지 않고 캡처만 한다 — 의도적으로
    // 실패시키는 호출(예: unborn branch에서의 rev-parse HEAD)의 git fatal
    // 메시지가 정상 실행 로그에 노이즈로 섞이는 것을 막는다. 실패 시
    // 메시지는 던져진 Error의 stderr 필드에서 여전히 확인 가능하다.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "--quiet", "-b", "main"]);
}

function writeFile(dir, relPath, content) {
  const abs = path.join(dir, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function writeBinaryFile(dir, relPath, buffer) {
  const abs = path.join(dir, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
}

function gitAdd(dir, relPath) {
  runGit(dir, ["add", "--", relPath]);
}

function gitMv(dir, fromRel, toRel) {
  const toAbs = path.join(dir, ...toRel.split("/"));
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  runGit(dir, ["mv", "--", fromRel, toRel]);
}

function gitRm(dir, relPath) {
  runGit(dir, ["rm", "--quiet", "--", relPath]);
}

function authorEnv({ authorName, authorEmail, epoch }) {
  const dateStr = `${epoch} +0900`;
  return {
    ...process.env,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_AUTHOR_DATE: dateStr,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
    GIT_COMMITTER_DATE: dateStr,
  };
}

function commit(dir, { message, authorName = OWNER_NAME, authorEmail = OWNER_EMAIL, epoch, allowEmptyMessage = false }) {
  const args = ["commit", "-m", message];
  if (allowEmptyMessage) args.push("--allow-empty-message");
  runGit(dir, args, authorEnv({ authorName, authorEmail, epoch }));
}

function commitMerge(dir, { branchName, message, authorName = OWNER_NAME, authorEmail = OWNER_EMAIL, epoch }) {
  runGit(dir, ["merge", "--no-ff", "-m", message, branchName], authorEnv({ authorName, authorEmail, epoch }));
}

function headHash(dir) {
  try {
    return runGit(dir, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null; // unborn branch(0커밋) 또는 비-git 디렉터리
  }
}

function allCommitHashes(dir) {
  try {
    return runGit(dir, ["rev-list", "--all"]).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`[self-check 실패] ${label}: 실제=${JSON.stringify(actual)} 기대=${JSON.stringify(expected)}`);
  }
}

// ---------------------------------------------------------------------------
// 시나리오별 base epoch. 서로 겹치지 않도록 시나리오마다 1,000,000초(약 11.5일)
// 씩 띄운다 — 각 시나리오 내부에서 최대 수백 개의 3600초 간격 타임스탬프를
// 쓰므로 이 정도 간격이면 서로 다른 시나리오의 타임스탬프 범위가 절대
// 겹치지 않는다. 시간대는 항상 "+0900"(KST) 고정 — 실행 머신의 로컬 TZ에
// 의존하면 결정성이 깨진다.
// ---------------------------------------------------------------------------

const BASE = {
  emptyRepo: 1_700_000_000,
  singleCommit: 1_701_000_000,
  multiAuthor: 1_702_000_000,
  botCommits: 1_703_000_000,
  korean: 1_704_000_000,
  spacePath: 1_705_000_000,
  merge: 1_706_000_000,
  rename: 1_707_000_000,
  delete: 1_708_000_000,
  emptyMessage: 1_709_000_000,
  coAuthorTrailer: 1_710_000_000,
  vendoredPaths: 1_711_000_000,
  secrets: 1_712_000_000,
  binaryFile: 1_713_000_000,
  large300: 1_720_000_000,
  toolErrorNonGit: 1_730_000_000,
  toolErrorCorrupted: 1_731_000_000,
  optInSnippet: 1_732_000_000,
  churnKeyDivergence: 1_733_000_000,
};

// ---------------------------------------------------------------------------
// 시나리오 (0) 빈 레포 / unborn branch
// ---------------------------------------------------------------------------

export function buildEmptyRepo(dir) {
  initRepo(dir);
  return { declared: { commitCount: 0, note: "unborn branch — HEAD가 아직 어떤 커밋도 가리키지 않는다." } };
}

// ---------------------------------------------------------------------------
// 시나리오 (1) 1커밋(초기 커밋)
// ---------------------------------------------------------------------------

export function buildSingleCommit(dir) {
  initRepo(dir);
  writeFile(dir, "README.md", "# Fixture\n\nInitial commit.\n");
  gitAdd(dir, "README.md");
  commit(dir, { message: "chore: initial commit", epoch: BASE.singleCommit + 3600 });
  return { declared: { commitCount: 1 } };
}

// ---------------------------------------------------------------------------
// 시나리오 (2) 다중 저자
// ---------------------------------------------------------------------------

export function buildMultiAuthor(dir) {
  initRepo(dir);
  const base = BASE.multiAuthor;
  writeFile(dir, "a.txt", "owner content\n");
  gitAdd(dir, "a.txt");
  commit(dir, { message: "chore: owner adds a", epoch: base + 3600 });

  writeFile(dir, "b.txt", "alice content\n");
  gitAdd(dir, "b.txt");
  commit(dir, { message: "feat: alice adds b", authorName: ALICE_NAME, authorEmail: ALICE_EMAIL, epoch: base + 7200 });

  writeFile(dir, "c.txt", "bob content\n");
  gitAdd(dir, "c.txt");
  commit(dir, { message: "feat: bob adds c", authorName: BOB_NAME, authorEmail: BOB_EMAIL, epoch: base + 10800 });

  return {
    declared: {
      commitCount: 3,
      authors: [
        { email: OWNER_EMAIL, count: 1 },
        { email: ALICE_EMAIL, count: 1 },
        { email: BOB_EMAIL, count: 1 },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// 시나리오 (3) 봇 커밋 — 두 가지 봇 패턴(dependabot, github-actions) 포함
// ---------------------------------------------------------------------------

export function buildBotCommits(dir) {
  initRepo(dir);
  const base = BASE.botCommits;
  writeFile(dir, "app.txt", "app v1\n");
  gitAdd(dir, "app.txt");
  commit(dir, { message: "chore: init app", epoch: base + 3600 });

  writeFile(dir, "package.json.lock", '{"lodash": "4.17.20"}\n');
  gitAdd(dir, "package.json.lock");
  commit(dir, {
    message: "chore(deps): bump lodash from 4.17.20 to 4.17.21",
    authorName: BOT_DEPENDABOT_NAME,
    authorEmail: BOT_DEPENDABOT_EMAIL,
    epoch: base + 7200,
  });

  writeFile(dir, ".github/workflows/ci.yml", "name: ci\n");
  gitAdd(dir, ".github/workflows/ci.yml");
  commit(dir, {
    message: "ci: automated workflow update",
    authorName: BOT_GHACTIONS_NAME,
    authorEmail: BOT_GHACTIONS_EMAIL,
    epoch: base + 10800,
  });

  writeFile(dir, "app.txt", "app v2\n");
  gitAdd(dir, "app.txt");
  commit(dir, { message: "feat: app v2", epoch: base + 14400 });

  return {
    declared: {
      commitCount: 4,
      botCommits: [
        { email: BOT_DEPENDABOT_EMAIL, pattern: "dependabot" },
        { email: BOT_GHACTIONS_EMAIL, pattern: "github-actions" },
      ],
      ownerCommitCount: 2,
    },
  };
}

// ---------------------------------------------------------------------------
// 시나리오 (4) 한글 파일명 · 한글 커밋 메시지
// ---------------------------------------------------------------------------

export function buildKorean(dir) {
  initRepo(dir);
  const base = BASE.korean;
  writeFile(dir, "한글파일.txt", "한글 내용입니다.\n");
  gitAdd(dir, "한글파일.txt");
  commit(dir, { message: "한글 커밋 메시지: 초기 한글 파일 추가", epoch: base + 3600 });

  writeFile(dir, "문서/두번째파일.txt", "하위 디렉터리의 한글 파일.\n");
  gitAdd(dir, "문서/두번째파일.txt");
  commit(dir, { message: "두 번째 한글 커밋: 하위 디렉터리 포함", epoch: base + 7200 });

  return {
    declared: {
      commitCount: 2,
      paths: ["한글파일.txt", "문서/두번째파일.txt"],
      note: "core.quotepath=false + i18n.logOutputEncoding=UTF-8 없이 파싱하면 옥탈 이스케이프로 깨지는 것을 확인하는 오라클.",
    },
  };
}

// ---------------------------------------------------------------------------
// 시나리오 (5) 공백 포함 경로
// ---------------------------------------------------------------------------

export function buildSpacePath(dir) {
  initRepo(dir);
  const base = BASE.spacePath;
  const p = "path with spaces/file one.txt";
  writeFile(dir, p, "content with a path containing spaces\n");
  gitAdd(dir, p);
  commit(dir, { message: "feat: add file with spaces in path", epoch: base + 3600 });

  return { declared: { commitCount: 1, path: p } };
}

// ---------------------------------------------------------------------------
// 시나리오 (6) merge 커밋 — 단독(300커밋 픽스처와 별개, AC-6 (iv)/AC-7/(17)의
// 최소 오라클 역할).
// ---------------------------------------------------------------------------

export function buildMerge(dir) {
  initRepo(dir);
  const base = BASE.merge;

  writeFile(dir, "main.txt", "main branch content\n");
  gitAdd(dir, "main.txt");
  commit(dir, { message: "chore: initial main commit", epoch: base + 3600 });

  runGit(dir, ["checkout", "-b", "feature"]);
  writeFile(dir, "feature.txt", "feature branch content\n");
  gitAdd(dir, "feature.txt");
  // feature-notes.txt를 같은 커밋에서 함께 건드려 이 커밋을 다중 파일
  // 커밋으로 만든다(-z 계약이 실제 관측 가능해지는 조건 — 임무 지침 2).
  writeFile(dir, "feature-notes.txt", "notes about the feature branch\n");
  gitAdd(dir, "feature-notes.txt");
  commit(dir, { message: "feat: add feature file and notes", epoch: base + 7200 });

  runGit(dir, ["checkout", "main"]);
  commitMerge(dir, { branchName: "feature", message: "Merge branch 'feature' into main", epoch: base + 10800 });

  const mergeCommitHash = headHash(dir);
  const parents = runGit(dir, ["log", "-1", "--format=%P", mergeCommitHash])
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  assertEqual(parents.length, 2, "merge 픽스처: 머지 커밋 parents.length");

  return {
    declared: {
      commitCount: 3,
      branchName: "feature",
      mergeCommitHash,
      parents,
      parentsCount: parents.length,
      viaMergeFiles: ["feature-notes.txt", "feature.txt"],
      note: "isMerge=(parents.length>=2)의 비공허성 오라클(AC-6 (iv)). files[]는 1부모 diff(main.txt tip vs merge)로 채워지며 feature.txt·feature-notes.txt 둘 다 viaMerge:true로 유입된다(원본 feature 커밋이 다중 파일 커밋이므로 -z 계약이 이 시나리오에서도 관측 가능하다).",
    },
  };
}

// ---------------------------------------------------------------------------
// 시나리오 (7) 리네임 — path/oldPath 기대값을 여기 하드코딩한다(B-4).
// ---------------------------------------------------------------------------

export function buildRename(dir) {
  initRepo(dir);
  const base = BASE.rename;
  const oldPath = "src/legacy/module.txt";
  const newPath = "src/current/module.txt";
  // 리네임 커밋과 같은 커밋에서 함께 수정되는 무관 파일 — 이 시나리오를
  // 다중 파일 커밋으로 만들어 -z 계약(리네임 레코드의 2토큰 + 일반 레코드의
  // 1토큰이 같은 -z 스트림에 섞이는 경우)이 실제로 관측되게 한다(임무 지침 2).
  const companionPath = "docs/notes.txt";

  writeFile(dir, oldPath, "export function run() {}\n");
  gitAdd(dir, oldPath);
  writeFile(dir, companionPath, "initial notes\n");
  gitAdd(dir, companionPath);
  commit(dir, { message: "feat: add legacy module and notes", epoch: base + 3600 });

  gitMv(dir, oldPath, newPath);
  writeFile(dir, companionPath, "initial notes\nupdated alongside the rename\n");
  gitAdd(dir, companionPath);
  commit(dir, { message: "refactor: rename legacy module to current (+ update notes)", epoch: base + 7200 });

  const renameCommitHash = headHash(dir);

  return {
    declared: {
      commitCount: 2,
      renameCommitHash,
      oldPath,
      path: newPath,
      changeType: "R",
      companionPath,
      note: "이 oldPath/path/changeType은 골든이 아니라 이 파일의 선언값이 정본이다(B-4) — git.mjs의 -z 파싱이 oldPath를 버리는 버그가 있어도 이 값과 직접 대조하면 잡힌다. renameCommitHash는 companionPath도 함께 수정하는 다중 파일 커밋이다.",
    },
  };
}

// ---------------------------------------------------------------------------
// 시나리오 (8) 파일 삭제 커밋 — deletedPath 기대값을 여기 하드코딩한다(B-4).
// ---------------------------------------------------------------------------

export function buildDelete(dir) {
  initRepo(dir);
  const base = BASE.delete;
  const deletedPath = "src/deprecated/old-service.txt";
  // 삭제 커밋과 같은 커밋에서 함께 수정되는 무관 파일 — 다중 파일 커밋으로
  // 만들어 D 레코드(1토큰)와 M 레코드(1토큰)가 같은 -z 스트림에 섞이는
  // 경우를 관측 가능하게 한다(임무 지침 2).
  const companionPath = "src/active/service.txt";

  writeFile(dir, deletedPath, "legacy service implementation\n");
  gitAdd(dir, deletedPath);
  writeFile(dir, companionPath, "active service v1\n");
  gitAdd(dir, companionPath);
  commit(dir, { message: "feat: add deprecated and active services", epoch: base + 3600 });

  gitRm(dir, deletedPath);
  writeFile(dir, companionPath, "active service v1\nactive service v2\n");
  gitAdd(dir, companionPath);
  commit(dir, { message: "chore: remove deprecated service (+ update active service)", epoch: base + 7200 });

  const deleteCommitHash = headHash(dir);

  return {
    declared: {
      commitCount: 2,
      deleteCommitHash,
      path: deletedPath,
      changeType: "D",
      companionPath,
      note: "git cat-file -e <deleteCommitHash>:<path>는 exit 128 'does not exist in'로 실패하지만 " +
        "git show --numstat --format= -z <deleteCommitHash>는 이 경로를 정확히 보고한다 — " +
        "이 자기모순이 verify-evidence.mjs가 트리 조회가 아니라 diff 집합 대조를 써야 하는 근거다. " +
        "deleteCommitHash는 companionPath도 함께 수정하는 다중 파일 커밋이다.",
    },
  };
}

// ---------------------------------------------------------------------------
// 시나리오 (9) 빈 커밋 메시지
// ---------------------------------------------------------------------------

export function buildEmptyMessage(dir) {
  initRepo(dir);
  const base = BASE.emptyMessage;
  writeFile(dir, "seed.txt", "seed\n");
  gitAdd(dir, "seed.txt");
  commit(dir, { message: "chore: seed", epoch: base + 3600 });

  writeFile(dir, "seed.txt", "seed\nupdated\n");
  gitAdd(dir, "seed.txt");
  commit(dir, { message: "", epoch: base + 7200, allowEmptyMessage: true });

  return { declared: { commitCount: 2, emptyMessageCommitIndex: 2 } };
}

// ---------------------------------------------------------------------------
// 시나리오 (10) Co-authored-by 트레일러 커밋 — 트레일러 있는 커밋 1개 +
// 없는 커밋 1개(AC-6이 요구하는 "비공허 + 빈 배열" 양쪽 관측용).
// ---------------------------------------------------------------------------

export function buildCoAuthorTrailer(dir) {
  initRepo(dir);
  const base = BASE.coAuthorTrailer;

  writeFile(dir, "pair.txt", "initial\n");
  gitAdd(dir, "pair.txt");
  commit(dir, { message: "chore: seed pair file", epoch: base + 3600 });

  writeFile(dir, "pair.txt", "initial\npaired change\n");
  gitAdd(dir, "pair.txt");
  commit(dir, {
    message: "feat: pair-programmed change\n\nImplemented together.\n\nCo-authored-by: Alice Kim <alice@example.test>",
    epoch: base + 7200,
  });

  writeFile(dir, "solo.txt", "solo change\n");
  gitAdd(dir, "solo.txt");
  commit(dir, { message: "chore: solo change without trailer", epoch: base + 10800 });

  return {
    declared: {
      commitCount: 3,
      withTrailerCommitIndex: 2,
      withoutTrailerCommitIndex: 3,
      expectedCoAuthorsTrailer: "Co-authored-by: Alice Kim <alice@example.test>",
      note: "P0 방침: coAuthors[]는 기록 전용 — 필터·집계에 쓰지 않는다(구현 2단계).",
    },
  };
}

// ---------------------------------------------------------------------------
// 시나리오 (11) node_modules/vendor 등 vendored 경로 (기본 제외 대상)
// ---------------------------------------------------------------------------

export function buildVendoredPaths(dir) {
  initRepo(dir);
  const base = BASE.vendoredPaths;
  const vendoredPaths = [
    "node_modules/some-pkg/index.js",
    "dist/bundle.js",
    "vendor/lib.js",
    "yarn.lock",
    "migrations/001_init.sql",
  ];
  const nonVendoredControlPath = "src/app.js";

  for (const p of [...vendoredPaths, nonVendoredControlPath]) {
    writeFile(dir, p, `// fixture content for ${p}\n`);
    gitAdd(dir, p);
  }
  commit(dir, { message: "chore: add vendored and generated paths (fixture)", epoch: base + 3600 });

  return {
    declared: {
      commitCount: 1,
      vendoredPaths,
      nonVendoredControlPath,
      note: "vendored 기본 제외 패턴: node_modules/, dist/, vendor/, *.lock, migrations/ (§5).",
    },
  };
}

// ---------------------------------------------------------------------------
// 시나리오 (12) 가짜 API 키 등 시크릿 포함 커밋 (마스킹 확인용, 전부 가짜 값)
// ---------------------------------------------------------------------------

export function buildSecrets(dir) {
  initRepo(dir);
  const base = BASE.secrets;
  const content = [
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIBOwIBAAJBAKfakekeyfakekeyfakekeyfakekeyfakekeyfakekeyfake==",
    "-----END RSA PRIVATE KEY-----",
    "password=hunter2example",
    "contact: leaked-person@example.test",
    "jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.fakeSigForFixtureOnly",
    "",
  ].join("\n");
  const p = "config/secrets-example.txt";
  writeFile(dir, p, content);
  gitAdd(dir, p);
  commit(dir, { message: "chore: add fixture secrets for masking test (fake values only)", epoch: base + 3600 });

  return {
    declared: {
      commitCount: 1,
      path: p,
      secretMarkers: ["aws-access-key", "aws-secret-key", "private-key-block", "password-field", "email", "jwt"],
      note: "전부 예시/가짜 값(AWS 공식 예시 키 포함) — AC-11 마스킹 미적용 시 산출물에 그대로 노출되는지 확인하는 용도.",
    },
  };
}

// ---------------------------------------------------------------------------
// 시나리오 (13) 바이너리 파일 커밋
// ---------------------------------------------------------------------------

export function buildBinaryFile(dir) {
  initRepo(dir);
  const base = BASE.binaryFile;
  const bytes = Buffer.alloc(300);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const p = "assets/blob.bin";
  writeBinaryFile(dir, p, bytes);
  gitAdd(dir, p);
  commit(dir, { message: "chore: add binary asset (fixture)", epoch: base + 3600 });

  return { declared: { commitCount: 1, path: p, note: "numstat이 이 파일을 '-\t-\tassets/blob.bin'(binary)으로 보고해야 한다." } };
}

// ---------------------------------------------------------------------------
// 시나리오 (14) 300커밋 대량 레포 — 예산 상한·샘플링 검증용(AC-21).
// 봇 20건 + 타 저자 30건 + 소유자 250건(정규 240 + 머지 유닛 5×2)을
// 구성해 total(=excluded!==true) < traversed(=300)를 실제로 만든다.
// ---------------------------------------------------------------------------

export function buildLarge300(dir) {
  initRepo(dir);
  const base = BASE.large300;
  let tick = 0;
  const nextEpoch = () => {
    tick += 1;
    return base + tick * 3600;
  };

  // 블록 1: 소유자 정규 커밋 240건. 전량 추가 전용이면 정본 churn 키
  // (commitLevelInsertions+commitLevelDeletions)와 오구현(insertions 단독)이
  // 수학적으로 항등이 되어 churn 판별력이 0이 된다(이 Run의 배경 ③) — 그래서
  // 네 국면(생성/수정/리네임+수정/삭제)으로 나눠 상당수 커밋에 실제
  // deletions>0을 만들고, 그중 일부를 다중 파일 커밋으로 만든다.
  //
  //   국면 A(1~120): 순수 생성(추가 전용, 기존과 동일한 churn 순환 패턴).
  //   국면 B(121~190, 70건): 기존 파일을 완전히 다른 내용으로 재작성해
  //     insertions>0 AND deletions>0을 강제한다(라인이 하나도 안 겹치므로
  //     git이 옛 라인 전부를 삭제로, 새 라인 전부를 추가로 본다). 홀수
  //     인덱스 35건은 동반 파일을 추가로 건드려 다중 파일 커밋으로 만든다.
  //   국면 C(191~200, 10건): 리네임 + 내용 수정을 한 커밋에서 동시에 수행.
  //     대상 파일은 국면 A에서 이미 "자료 구버전/파일 N.txt" 형태의 공백+
  //     한글 혼재 경로에 만들어 두었고, 여기서 "자료 신버전/파일 N.txt"로
  //     옮기며 내용도 바꾼다 — 접두사(data/)와 접미사(파일 N.txt)가 같고
  //     중간 디렉터리만 바뀌므로 git이 `data/{자료 구버전 => 자료 신버전}/
  //     파일 N.txt` 축약형을 실제로 낸다(임무 지침 3).
  //   국면 D(201~240, 40건): 파일 삭제(deletions>0 확정). 4의 배수 인덱스
  //     10건은 공유 로그 파일도 함께 수정해 다중 파일 커밋으로 만든다.
  const RENAME_POOL_START = 111; // 국면 A의 111~120이 국면 C의 리네임 원본
  const RENAME_POOL_END = 120;
  const koreanSpaceDirOld = "자료 구버전";
  const koreanSpaceDirNew = "자료 신버전";

  // 아래 세 배열은 "이 커밋을 이런 성격으로 만들 작정이었다"는 구성 의도를
  // 담는다 — verifyLarge300Composition()이 실제 git show --numstat 결과로
  // 재확인해, 의도와 실제 생성물이 어긋나면(예: 재작성 내용이 우연히 옛
  // 내용과 겹쳐 deletions==0이 되는 경우) 즉시 예외를 던진다.
  const multiFileHashes = [];
  const deletionHashes = [];
  const renameModifyHashes = [];

  for (let i = 1; i <= 120; i++) {
    const lines = 1 + ((i - 1) % 15);
    const content = Array.from({ length: lines }, (_, k) => `line ${k + 1} of commit ${i}`).join("\n") + "\n";
    const isRenamePoolFile = i >= RENAME_POOL_START && i <= RENAME_POOL_END;
    const p = isRenamePoolFile ? `data/${koreanSpaceDirOld}/파일 ${i}.txt` : `data/file-${i}.txt`;
    writeFile(dir, p, content);
    gitAdd(dir, p);
    if (i === 120) {
      // 마지막 생성 커밋에 공유 로그 파일을 함께 실어 이 커밋도 다중 파일
      // 커밋으로 만든다(국면 D가 이 파일을 이어서 갱신한다).
      writeFile(dir, "data/deletion-log.txt", "deletion log\n");
      gitAdd(dir, "data/deletion-log.txt");
      commit(dir, { message: `chore: add data file ${i} and seed deletion log`, epoch: nextEpoch() });
      multiFileHashes.push(headHash(dir));
    } else {
      commit(dir, { message: `chore: add data file ${i}`, epoch: nextEpoch() });
    }
  }

  // 국면 B: 수정(70건, 파일 1~70) — 완전 재작성으로 deletions>0 강제.
  for (let j = 1; j <= 70; j++) {
    const targetFile = `data/file-${j}.txt`;
    const oldLines = 1 + ((j - 1) % 15);
    const newLines = Math.max(1, Math.floor(oldLines / 2));
    const newContent =
      Array.from({ length: newLines }, (_, k) => `modified-line-${k + 1}-of-file-${j}-pass-b`).join("\n") + "\n";
    writeFile(dir, targetFile, newContent);
    gitAdd(dir, targetFile);
    const isMultiFile = j % 2 === 1;
    if (isMultiFile) {
      const extraPath = `data/extra-${j}.txt`;
      writeFile(dir, extraPath, `extra companion file for modify commit ${j}\n`);
      gitAdd(dir, extraPath);
    }
    commit(dir, {
      message: `refactor: rewrite data file ${j}${isMultiFile ? " and add companion" : ""}`,
      epoch: nextEpoch(),
    });
    const h = headHash(dir);
    deletionHashes.push(h);
    if (isMultiFile) multiFileHashes.push(h);
  }

  // 국면 C: 리네임 + 수정 동시 수행(10건, 파일 111~120). 공백+한글 혼재
  // 경로(`자료 구버전` → `자료 신버전`)로 `{a => b}` 축약형을 유발한다.
  for (let r = RENAME_POOL_START; r <= RENAME_POOL_END; r++) {
    const fromPath = `data/${koreanSpaceDirOld}/파일 ${r}.txt`;
    const toPath = `data/${koreanSpaceDirNew}/파일 ${r}.txt`;
    gitMv(dir, fromPath, toPath);
    // 내용을 완전히 갈아엎으면(국면 B처럼) 유사도가 git의 기본 리네임
    // 임계값(50%) 아래로 떨어져 R이 아니라 D+A로 잡힌다 — 그래서 대부분의
    // 원본 라인은 그대로 두고 첫 줄만 바꾸고 한 줄을 추가해, "리네임인데
    // 동시에 수정도 됐다"는 조건(insertions>0 AND deletions>0, changeType=R)
    // 만 만족시키면서 유사도는 높게 유지한다.
    const lines = 1 + ((r - 1) % 15);
    const originalLines = Array.from({ length: lines }, (_, k) => `line ${k + 1} of commit ${r}`);
    originalLines[0] = `line 1 of commit ${r} (renamed and updated)`;
    originalLines.push(`extra line added while renaming 파일 ${r}`);
    const newContent = originalLines.join("\n") + "\n";
    writeFile(dir, toPath, newContent);
    gitAdd(dir, toPath);
    commit(dir, { message: `refactor: rename and update 파일 ${r} (구버전 → 신버전)`, epoch: nextEpoch() });
    const h = headHash(dir);
    deletionHashes.push(h);
    renameModifyHashes.push(h);
  }

  // 국면 D: 삭제(40건, 파일 71~110). 4의 배수 인덱스(10건)는 공유 로그
  // 파일도 함께 갱신해 다중 파일 커밋으로 만든다.
  for (let k = 1; k <= 40; k++) {
    const targetId = 70 + k; // 71..110
    const targetFile = `data/file-${targetId}.txt`;
    gitRm(dir, targetFile);
    const isMultiFile = k % 4 === 0;
    if (isMultiFile) {
      writeFile(dir, "data/deletion-log.txt", `deletion log\ndeleted data/file-${targetId}.txt at step ${k}\n`);
      gitAdd(dir, "data/deletion-log.txt");
    }
    commit(dir, {
      message: `chore: delete data file ${targetId}${isMultiFile ? " and update deletion log" : ""}`,
      epoch: nextEpoch(),
    });
    const h = headHash(dir);
    deletionHashes.push(h);
    if (isMultiFile) multiFileHashes.push(h);
  }

  // 블록 2: 봇 커밋 20건.
  for (let i = 1; i <= 20; i++) {
    const p = `deps/dep-${i}.json`;
    writeFile(dir, p, `{"version": "1.0.${i}"}\n`);
    gitAdd(dir, p);
    commit(dir, {
      message: `chore(deps): bump dep-${i} to 1.0.${i}`,
      authorName: BOT_DEPENDABOT_NAME,
      authorEmail: BOT_DEPENDABOT_EMAIL,
      epoch: nextEpoch(),
    });
  }

  // 블록 3: 타 저자 커밋 30건(alice/bob 교대).
  for (let i = 1; i <= 30; i++) {
    const isAlice = i % 2 === 1;
    const name = isAlice ? ALICE_NAME : BOB_NAME;
    const email = isAlice ? ALICE_EMAIL : BOB_EMAIL;
    const p = `contrib/other-${i}.txt`;
    writeFile(dir, p, `contribution ${i} by ${name}\n`);
    gitAdd(dir, p);
    commit(dir, { message: `feat: contribution ${i} by ${name}`, authorName: name, authorEmail: email, epoch: nextEpoch() });
  }

  // 블록 4: 머지 유닛 5개(사이드 커밋 + --no-ff 머지, 전부 소유자 저자).
  // 사이드 커밋은 churn을 크게(50+i줄) 잡아 churn 상위 버킷에서 관측되게
  // 하고, 머지 커밋 자체는 정의상 커밋 레벨 churn이 항상 0이어야 한다.
  const mergeHashes = [];
  for (let i = 1; i <= 5; i++) {
    const branchName = `side-${i}`;
    runGit(dir, ["checkout", "-b", branchName]);
    const sideLines = 50 + i;
    const sideContent = Array.from({ length: sideLines }, (_, k) => `side line ${k + 1}`).join("\n") + "\n";
    const p = `side/side-${i}.txt`;
    writeFile(dir, p, sideContent);
    gitAdd(dir, p);
    commit(dir, { message: `feat: side branch ${i} work`, epoch: nextEpoch() });

    runGit(dir, ["checkout", "main"]);
    commitMerge(dir, { branchName, message: `Merge branch '${branchName}' into main`, epoch: nextEpoch() });
    mergeHashes.push(headHash(dir));
  }

  const declared = {
    totalTraversed: 300,
    botCount: 20,
    otherAuthorCount: 30,
    ownerRegularCount: 240,
    mergeUnitsCount: 5,
    ownerTotal: 240 + 5 + 5, // 250 = coverage.total (excluded !== true 커밋 수)
    maxCommits: 50,
    mergeHashes,
    // 이 Run이 닫는 퇴화 데이터 문제(원인 ③)의 구성 오라클. deletionHashes는
    // insertions 단독 churn과 정본 churn(insertions+deletions)이 서로 다른
    // 선택 집합을 낳게 만드는 근거이고, multiFileHashes는 -z 계약이 실제로
    // 관측 가능함을, renameModifyHashes는 리네임+수정 동시 발생 및
    // 공백·한글 혼재 축약 경로(`data/{자료 구버전 => 자료 신버전}/파일 N.txt`)
    // 조건이 실제로 만들어졌음을 각각 검증하는 오라클이다.
    deletionBearingCommitHashes: deletionHashes,
    deletionBearingCommitCount: deletionHashes.length, // 120 = 70(국면B) + 10(국면C) + 40(국면D)
    multiFileCommitHashes: multiFileHashes,
    multiFileCommitCount: multiFileHashes.length, // 46 = 1(국면A #120) + 35(국면B 홀수) + 10(국면D 4의 배수)
    renameModifyCommitHashes: renameModifyHashes,
    renameModifyCommitCount: renameModifyHashes.length, // 10 = 국면C
    koreanSpaceRenameDirs: { old: koreanSpaceDirOld, new: koreanSpaceDirNew },
    note:
      "coverage.traversed==300, coverage.total==250(=ownerTotal), coverage.analyzed==K==min(50,250)==50. " +
      "AC-21이 이 세 수치를 그대로 기대값으로 대조한다(B-1/B-2 — '250 하드코딩' 오류를 피하려면 " +
      "total은 항상 이 ownerTotal 필드를 참조하고 traversed(300)에서 직접 빼지 않는다). " +
      "population(=excluded!==true) 커밋 250건 중 120건이 deletions>0을 실제로 가지므로 " +
      "churn 정렬 키 insertions+deletions와 insertions 단독은 이 픽스처에서 서로 다른 상위 20건을 낳는다.",
  };

  verifyLarge300Composition(dir, declared);

  return { declared };
}

function verifyLarge300Composition(dir, declared) {
  const emails = runGit(dir, ["log", "--all", "--format=%ae"]).split("\n").map((s) => s.trim()).filter(Boolean);
  const total = emails.length;
  const botCount = emails.filter(isBotEmail).length;
  const ownerCount = emails.filter((e) => e === OWNER_EMAIL).length;
  const otherCount = total - botCount - ownerCount;
  const mergeCount = runGit(dir, ["log", "--all", "--merges", "--format=%H"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean).length;

  assertEqual(total, declared.totalTraversed, "300커밋 픽스처: traversed");
  assertEqual(botCount, declared.botCount, "300커밋 픽스처: bot count");
  assertEqual(otherCount, declared.otherAuthorCount, "300커밋 픽스처: other-author count");
  assertEqual(ownerCount, declared.ownerTotal, "300커밋 픽스처: owner(=excluded!==true) count");
  assertEqual(mergeCount, declared.mergeUnitsCount, "300커밋 픽스처: merge count");

  // 구성 의도(deletionBearingCommitHashes/multiFileCommitHashes)가 실제
  // git show --numstat -z 결과와 일치하는지 재확인한다 — "만들 작정이었다"가
  // 아니라 "실제로 그렇게 만들어졌다"를 이 생성기 자체가 검증한다.
  for (const h of declared.deletionBearingCommitHashes) {
    const raw = runGit(dir, ["show", "--numstat", "--format=", "-z", h]);
    const hasDeletion = numstatZHasDeletion(raw);
    if (!hasDeletion) {
      throw new Error(`[self-check 실패] 300커밋 픽스처: 커밋 ${h}는 deletions>0이어야 하는데 실제로는 없음`);
    }
  }
  for (const h of declared.multiFileCommitHashes) {
    const raw = runGit(dir, ["show", "--numstat", "--format=", "-z", h]);
    const fileCount = numstatZRecordCount(raw);
    if (fileCount < 2) {
      throw new Error(`[self-check 실패] 300커밋 픽스처: 커밋 ${h}는 다중 파일 커밋이어야 하는데 실제 레코드 수=${fileCount}`);
    }
  }
  // 국면 C 커밋 각각에 대해 (i) name-status가 R(리네임)로 보고하는지,
  // (ii) -z 없는 --numstat이 실제로 `{old => new}` 축약형 한 줄로 내보내는지
  // (spec.md 배경 문단의 실측 계약 — 임무 지침 3) 둘 다 재확인한다.
  const { old: oldDir, new: newDir } = declared.koreanSpaceRenameDirs;
  for (const h of declared.renameModifyCommitHashes) {
    const nameStatusZ = runGit(dir, ["diff", "--name-status", "-z", `${h}^`, h]);
    const tokens = nameStatusZ.split("\0").filter(Boolean);
    const isRename = tokens.length >= 1 && /^R\d*$/.test(tokens[0]);
    if (!isRename) {
      throw new Error(`[self-check 실패] 300커밋 픽스처: 커밋 ${h}는 리네임(R)이어야 하는데 name-status=${JSON.stringify(tokens)}`);
    }

    const numstatNoZ = runGit(dir, ["show", "--numstat", "--format=", h]);
    if (!numstatNoZ.includes(`{${oldDir} => ${newDir}}`)) {
      throw new Error(
        `[self-check 실패] 300커밋 픽스처: 커밋 ${h}의 -z 없는 --numstat이 '{${oldDir} => ${newDir}}' 축약형을 내지 않음: ${JSON.stringify(numstatNoZ)}`
      );
    }
  }
}

/** `--numstat -z` 원시 출력에서 이진 아닌 레코드 중 하나라도 deletions>0인지. */
function numstatZHasDeletion(rawZ) {
  const tokens = rawZ.split("\0");
  while (tokens.length && tokens[tokens.length - 1] === "") tokens.pop();
  let i = 0;
  while (i < tokens.length) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
    if (!m) {
      i += 1;
      continue;
    }
    const [, , delRaw, pathPart] = m;
    if (delRaw !== "-" && Number(delRaw) > 0) return true;
    i += pathPart === "" ? 3 : 1;
  }
  return false;
}

/** `--numstat -z` 원시 출력의 변경 레코드(파일) 개수. */
function numstatZRecordCount(rawZ) {
  const tokens = rawZ.split("\0");
  while (tokens.length && tokens[tokens.length - 1] === "") tokens.pop();
  let i = 0;
  let count = 0;
  while (i < tokens.length) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
    if (!m) {
      i += 1;
      continue;
    }
    const [, , , pathPart] = m;
    count += 1;
    i += pathPart === "" ? 3 : 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 시나리오 (15) 도구 오류 유발 케이스 — 두 변형.
// ---------------------------------------------------------------------------

/** (15-a) 비-git 디렉터리를 레포로 지정하는 경우. */
export function buildToolErrorNonGit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "not-a-repo.txt"),
    "이 디렉터리는 의도적으로 git 레포가 아니다(도구 오류 유발 케이스 15-a).\n",
    "utf8"
  );
  return {
    declared: {
      commitCount: null,
      expectedBehavior:
        "git -C <dir> rev-parse --show-toplevel 등 모든 git 호출이 128로 실패한다 — " +
        "'bad object'/'unknown revision'/'Needed a single revision'/'does not exist in' 어느 패턴에도 " +
        "걸리지 않으므로 (exit code, stderr 패턴) 3분류상 '도구·레포 오류'로 분류돼야 하며 인용 FAIL로 집계하지 않는다.",
    },
  };
}

/** (15-b) .git/objects 손상 레포. HEAD가 가리키는 커밋 객체 파일을 0바이트로
 * 잘라 loose object corruption을 재현한다. */
export function buildToolErrorCorrupted(dir) {
  initRepo(dir);
  const base = BASE.toolErrorCorrupted;

  writeFile(dir, "a.txt", "alpha\n");
  gitAdd(dir, "a.txt");
  commit(dir, { message: "chore: seed a", epoch: base + 3600 });

  writeFile(dir, "b.txt", "beta\n");
  gitAdd(dir, "b.txt");
  commit(dir, { message: "chore: seed b", epoch: base + 7200 });

  const targetSha = headHash(dir);
  const objDir = targetSha.slice(0, 2);
  const objFile = targetSha.slice(2);
  const objPath = path.join(dir, ".git", "objects", objDir, objFile);

  if (!fs.existsSync(objPath)) {
    throw new Error(
      `[toolErrorCorrupted] loose object 파일을 찾을 수 없습니다: ${objPath} — ` +
        `이 시점에는 git gc가 실행되지 않아 항상 loose object여야 한다.`
    );
  }
  // git이 loose object 파일을 읽기 전용(0444)으로 쓰므로 Windows에서는
  // 그대로 writeFileSync하면 EPERM이 난다 — 덮어쓰기 전에 쓰기 권한을 되돌린다.
  fs.chmodSync(objPath, 0o600);
  fs.writeFileSync(objPath, Buffer.alloc(0)); // 0바이트로 잘라 손상시킴

  return {
    declared: {
      commitCount: 2,
      corruptedCommitHash: targetSha,
      corruptedObjectPath: path.posix.join(".git", "objects", objDir, objFile),
      expectedBehavior:
        "손상된 객체에 대한 git rev-parse --verify --quiet <sha>^{commit} 또는 " +
        "git cat-file -e 호출이 exit 128로 실패하되 'bad object'/'unknown revision' 등 " +
        "알려진 조회 실패 패턴과 다른 메시지(예: 'loose object ... is corrupt', " +
        "'object file ... is empty')를 낸다 — 3분류상 '도구·레포 오류'로 분류돼야 한다. " +
        "이 시나리오 이후 이 레포에 대해서는 더 이상 git 조회를 수행하지 않는다(생성기 자체가 깨지는 것을 방지).",
      note: "이 스캐폴딩 완료 후 headHash/allCommitHashes를 다시 호출하지 않는다 — 의도적으로 깨진 레포다.",
    },
  };
}

// ---------------------------------------------------------------------------
// 시나리오 (16) 옵트인 스니펫 인용 케이스.
// git cat-file -e <sha>:<path>가 실제로 두 분기(성공/128 실패)를 다 내도록
// "존재 시점 커밋"과 "삭제 이후 커밋" 양쪽의 sha를 함께 선언한다.
// ---------------------------------------------------------------------------

export function buildOptInSnippet(dir) {
  initRepo(dir);
  const base = BASE.optInSnippet;
  const p = "src/util/formatter.txt";

  writeFile(dir, p, "function format(x) {\n  return String(x).trim();\n}\n");
  gitAdd(dir, p);
  commit(dir, { message: "feat: add formatter utility", epoch: base + 3600 });
  const existsAtCommit = headHash(dir);

  writeFile(dir, p, "function format(x) {\n  return String(x).trim().toLowerCase();\n}\n");
  gitAdd(dir, p);
  commit(dir, { message: "refactor: normalize case in formatter", epoch: base + 7200 });

  gitRm(dir, p);
  commit(dir, { message: "chore: remove formatter utility (superseded)", epoch: base + 10800 });
  const deletedAtCommit = headHash(dir);

  return {
    declared: {
      commitCount: 3,
      path: p,
      existsAtCommit,
      deletedAtCommit,
      expectedBehavior:
        `git cat-file -e ${existsAtCommit}:${p} → exit 0(존재). ` +
        `git cat-file -e ${deletedAtCommit}:${p} → exit 128, stderr에 'does not exist in' 패턴 → ` +
        "조회 실패로 보아 인용 FAIL로 집계(도구 오류 아님).",
    },
  };
}

// ---------------------------------------------------------------------------
// 시나리오 (18) churn 파생식 판별 픽스처 — collect-git-facts.mjs:193의
// `churn: diff.insertions + diff.deletions` 파생식(M-g의 변이 지점)을
// **실제로 collectGitFacts()를 호출하는** 비-golden 경로에서 관측하기 위한
// 소형 전용 오라클. large300(~85초)과 별개로 커밋 5개뿐이라 수 초 이내에
// 끝난다.
//
// population 5커밋(전원 OWNER, 봇·타 저자·머지 없음) + maxCommits=4:
//   total=5 > maxCommits=4 → 절단 실제 발생(computeSampling 진입).
//   K=min(4,5)=4, recentBase=floor(4*0.4)=1, churnBase=floor(4*0.4)=1,
//   evenBase=floor(4*0.2)=0, remainder=4-(1+1+0)=2
//   → recentCount=3, churnCount=1, evenCount=0.
// evenCount=0으로 시간 구간 보간(선택 로직 중 가장 복잡한 축)이 아예
// 관여하지 않게 설계해, 판별력을 오직 churn 정렬 축 하나에만 싣는다.
//
// 커밋 구성(오래된 → 최신 순, epoch 전량 서로 다름 → tie-break 불필요):
//   seed:        bigfile.txt를 100줄로 신규 생성 → insertions=100, deletions=0
//   churnCommit: bigfile.txt 전량 삭제(100줄) + tiny.txt 1줄 추가(같은 커밋)
//                → insertions=1, deletions=100
//   recent1/2/3: 서로 무관한 신규 파일 1개씩(시간축 전용 필러) — authorDate가
//                seed·churnCommit보다 항상 늦으므로 recentSelected(top3)가
//                이 3건을 결정적으로 뽑는다 → afterRecent={seed, churnCommit}.
//
// afterRecent 2건 중 churnCount=1이므로 churn 버킷은 정확히 1건만 뽑는다:
//   정본 키(ins+del desc):  churnCommit(1+100=101) > seed(100+0=100)
//     → churnCommit 선택, seed는 evidence.commits에서 완전히 누락.
//   insertions 단독 키:      seed(100) > churnCommit(1)
//     → (M-g가 적용됐다면) 반대로 seed가 선택되고 churnCommit이 누락.
// 이 반전이 tests/run-smoke.mjs의 named report(...) 단언(하드코딩 리터럴
// 대조, 로직 재구현 없음)으로 직접 관측된다.
// ---------------------------------------------------------------------------

export function buildChurnKeyDivergence(dir) {
  initRepo(dir);
  const base = BASE.churnKeyDivergence;
  let tick = 0;
  const nextEpoch = () => {
    tick += 1;
    return base + tick * 3600;
  };

  const bigLines = 100;
  const bigContent = Array.from({ length: bigLines }, (_, k) => `seed line ${k + 1}`).join("\n") + "\n";
  writeFile(dir, "bigfile.txt", bigContent);
  gitAdd(dir, "bigfile.txt");
  commit(dir, { message: "chore: seed bigfile (churn-key-divergence fixture)", epoch: nextEpoch() });
  const seedHash = headHash(dir);

  gitRm(dir, "bigfile.txt");
  writeFile(dir, "tiny.txt", "one line\n");
  gitAdd(dir, "tiny.txt");
  commit(dir, {
    message: "chore: delete bigfile, add tiny companion (churn-key-divergence fixture)",
    epoch: nextEpoch(),
  });
  const churnCommitHash = headHash(dir);

  const recentHashes = [];
  for (let i = 1; i <= 3; i++) {
    const p = `recent/${i}.txt`;
    writeFile(dir, p, `recent filler ${i}\n`);
    gitAdd(dir, p);
    commit(dir, { message: `chore: recent filler ${i}`, epoch: nextEpoch() });
    recentHashes.push(headHash(dir));
  }

  const declared = {
    commitCount: 5,
    maxCommits: 4,
    seedHash,
    churnCommitHash,
    recentHashes,
    seedInsertions: bigLines,
    seedDeletions: 0,
    churnCommitInsertions: 1,
    churnCommitDeletions: bigLines,
    // 정본 churn 키(insertions+deletions)로 K=4를 뽑았을 때 기대되는 선택
    // 집합(순서 무관) — tests/run-smoke.mjs가 이 값을 재구현 없이 그대로
    // Set 리터럴로 비교한다.
    expectedCanonicalSelectedHashes: [churnCommitHash, ...recentHashes],
    // insertions 단독 키(M-g)였다면 나왔을 선택 집합 — churnCommit 자리에
    // seed가 대신 들어간다. 이 값 역시 하드코딩 리터럴이며, computeSampling을
    // 다시 호출해 유도하지 않는다(이 파일 상단 주석의 수기 유도가 유일한 근거).
    expectedInsertionsOnlySelectedHashes: [seedHash, ...recentHashes],
    note:
      "K=4(recentCount=3/churnCount=1/evenCount=0). afterRecent={seed,churnCommit} 2건 중 " +
      "churnCount=1건만 churn 버킷에 뽑힌다. 정본 churn 키(insertions+deletions desc)로는 " +
      `churnCommit(ins=1,del=${bigLines},churn=${1 + bigLines}) > seed(ins=${bigLines},del=0,churn=${bigLines})이므로 ` +
      "churnCommit이 선택되고 seed는 완전히 누락된다. insertions 단독 키였다면 " +
      "seed(ins=100) > churnCommit(ins=1)이라 반대로 선택된다(M-g 대조 — collect-git-facts.mjs:193 " +
      "`churn: diff.insertions + diff.deletions` 파생식 오라클).",
  };

  verifyChurnKeyDivergenceComposition(dir, declared);

  return { declared };
}

/** `--numstat -z` 원시 출력의 전 레코드 insertions/deletions 합(이진 파일은 0). */
function numstatZTotals(rawZ) {
  const tokens = rawZ.split("\0");
  while (tokens.length && tokens[tokens.length - 1] === "") tokens.pop();
  let i = 0;
  let insertions = 0;
  let deletions = 0;
  while (i < tokens.length) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
    if (!m) {
      i += 1;
      continue;
    }
    const [, insRaw, delRaw, pathPart] = m;
    if (insRaw !== "-") insertions += Number(insRaw);
    if (delRaw !== "-") deletions += Number(delRaw);
    i += pathPart === "" ? 3 : 1;
  }
  return { insertions, deletions };
}

/**
 * 구성 의도(seed/churnCommit의 insertions/deletions)가 실제 git show
 * --numstat -z 결과와 일치하는지 재확인한다(buildLarge300의
 * verifyLarge300Composition과 동일한 원칙 — "만들 작정이었다"가 아니라
 * "실제로 그렇게 만들어졌다"를 생성기 자체가 검증한다).
 */
function verifyChurnKeyDivergenceComposition(dir, declared) {
  const seedTotals = numstatZTotals(runGit(dir, ["show", "--numstat", "--format=", "-z", declared.seedHash]));
  assertEqual(seedTotals.insertions, declared.seedInsertions, "churn-key-divergence: seed insertions");
  assertEqual(seedTotals.deletions, declared.seedDeletions, "churn-key-divergence: seed deletions");

  const churnTotals = numstatZTotals(runGit(dir, ["show", "--numstat", "--format=", "-z", declared.churnCommitHash]));
  assertEqual(churnTotals.insertions, declared.churnCommitInsertions, "churn-key-divergence: churnCommit insertions");
  assertEqual(churnTotals.deletions, declared.churnCommitDeletions, "churn-key-divergence: churnCommit deletions");

  // 정본 churn(ins+del) 기준으로 churnCommit이 seed를 이겨야 하고, insertions
  // 단독 기준으로는 반대로 seed가 이겨야 한다 — 이 대소 관계 자체가 이
  // 픽스처의 판별력이다. 어느 한쪽이라도 깨지면(예: 실수로 값을 바꿔
  // 역전이 사라지면) 생성 단계에서 즉시 예외로 중단한다.
  const canonicalChurnCommit = churnTotals.insertions + churnTotals.deletions;
  const canonicalSeed = seedTotals.insertions + seedTotals.deletions;
  if (!(canonicalChurnCommit > canonicalSeed)) {
    throw new Error(
      `[self-check 실패] churn-key-divergence: 정본 churn(ins+del) 기준 churnCommit(${canonicalChurnCommit})이 ` +
      `seed(${canonicalSeed})보다 커야 하는데 아님`
    );
  }
  if (!(seedTotals.insertions > churnTotals.insertions)) {
    throw new Error(
      `[self-check 실패] churn-key-divergence: insertions 단독 기준 seed(${seedTotals.insertions})가 ` +
      `churnCommit(${churnTotals.insertions})보다 커야 하는데 아님`
    );
  }
}

// ---------------------------------------------------------------------------
// 시나리오 (17) 머지 해시를 basis:commit 근거로 인용한 산출물 주입 케이스.
// merge 픽스처 위에 인위 주입한 산출물 조각 — 오염 스위트 40건과 별개이고
// 그 분모에 산입하지 않는다(AC-7/AC-8 B-5).
// ---------------------------------------------------------------------------

export function buildCase17MergeHashInjection(mergeDeclared) {
  return {
    schemaNote:
      "이 파일은 산출물 스키마(career.schema.json 등)의 정식 인스턴스가 아니라, " +
      "AC-7의 '머지 해시를 basis:commit 근거로 인용한 정량 주장' 위반 패턴을 재현하기 위해 " +
      "인위 주입한 최소 노드 조각이다. verify-evidence.mjs(구현 6단계)가 이 노드를 FAIL 처리해야 하며, " +
      "기대 REJECT 사유는 basis:commit + 머지 해시 규칙 위반 코드여야 한다((a)축 '제외 커밋 인용' 사유가 아니다).",
    node: {
      id: "case-17-injected-quantitative-claim",
      claim: "이 기간 동안 총 120줄을 추가했다 (인위 주입 — basis 규칙 위반 재현용, 실제 값 아님)",
      basis: "commit",
      evidence: [{ ledgerId: `commit:${mergeDeclared.mergeCommitHash}` }],
      origin: "generated",
      locked: false,
    },
    fixtureSourceMergeCommit: mergeDeclared.mergeCommitHash,
    fixtureSourceMergeParents: mergeDeclared.parents,
    executionSetting: "머지 포함 설정(mergeIncluded: true)에서 실행 — 제외 설정에서는 (a)축 FAIL로 뭉개져 basis 규칙이 평가되지 않는다.",
    expectedVerifierOutcome:
      "REJECT — basis:commit 근거가 머지 커밋 해시를 인용함(머지 해시는 inference 근거로만 허용). " +
      "(a)축 '제외 커밋 인용' 사유가 아니라 별도의 머지 해시 정량 주장 위반 코드로 FAIL해야 탐지로 채점한다(AC-7).",
  };
}

// ---------------------------------------------------------------------------
// 전체 빌드
// ---------------------------------------------------------------------------

const SCENARIOS = [
  ["emptyRepo", buildEmptyRepo],
  ["singleCommit", buildSingleCommit],
  ["multiAuthor", buildMultiAuthor],
  ["botCommits", buildBotCommits],
  ["korean", buildKorean],
  ["spacePath", buildSpacePath],
  ["merge", buildMerge],
  ["rename", buildRename],
  ["delete", buildDelete],
  ["emptyMessage", buildEmptyMessage],
  ["coAuthorTrailer", buildCoAuthorTrailer],
  ["vendoredPaths", buildVendoredPaths],
  ["secrets", buildSecrets],
  ["binaryFile", buildBinaryFile],
  ["large300", buildLarge300],
  ["toolErrorNonGit", buildToolErrorNonGit],
  ["toolErrorCorrupted", buildToolErrorCorrupted],
  ["optInSnippet", buildOptInSnippet],
  ["churnKeyDivergence", buildChurnKeyDivergence],
];

/**
 * 전 시나리오를 baseDir 아래 <시나리오명>/ 으로 생성하고, 시나리오별
 * {headHash, commitHashes, commitCount, declared}와 (17) 주입 산출물을
 * 포함한 매니페스트를 반환한다.
 *
 * @param {string} baseDir
 * @returns {object} manifest
 */
export function buildAllFixtures(baseDir) {
  const manifest = {};

  for (const [name, fn] of SCENARIOS) {
    const dir = path.join(baseDir, name);
    const result = fn(dir);
    const skipIntrospection = name === "toolErrorNonGit" || name === "toolErrorCorrupted";
    const commitHashes = skipIntrospection ? [] : allCommitHashes(dir);
    manifest[name] = {
      dir,
      headHash: name === "toolErrorNonGit" ? null : headHash(dir),
      commitHashes,
      commitCount: commitHashes.length,
      declared: result.declared,
    };
  }

  manifest.mergeHashInjection = {
    artifact: buildCase17MergeHashInjection(manifest.merge.declared),
  };

  return manifest;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function toComparableManifest(manifest) {
  const comparable = {};
  for (const [name, entry] of Object.entries(manifest)) {
    if (name === "mergeHashInjection") {
      comparable[name] = entry;
      continue;
    }
    comparable[name] = {
      headHash: entry.headHash,
      commitCount: entry.commitCount,
      commitHashes: entry.commitHashes,
      declared: entry.declared,
    };
  }
  return comparable;
}

function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const emitGolden = argv.includes("--emit-golden");

  let baseDir;
  let cleanup = false;

  if (outIdx !== -1 && argv[outIdx + 1]) {
    baseDir = path.resolve(argv[outIdx + 1]);
    fs.mkdirSync(baseDir, { recursive: true });
  } else {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-fixtures-"));
    cleanup = true;
  }

  console.error(`[make-fixture] 픽스처 생성 중... baseDir=${baseDir}`);
  const manifest = buildAllFixtures(baseDir);
  const comparable = toComparableManifest(manifest);

  // stdout에는 비교 가능한(경로 비의존) JSON만 출력한다 — baseDir 절대경로는
  // 실행마다 달라지므로 "두 번 실행해 해시가 같은지" 비교의 노이즈가 된다.
  console.log(JSON.stringify(comparable, null, 2));

  if (emitGolden) {
    const goldenDir = path.join(SCRIPT_DIR, "golden");
    fs.mkdirSync(goldenDir, { recursive: true });
    const outPath = path.join(goldenDir, "case-17-merge-hash-claim.json");
    fs.writeFileSync(outPath, JSON.stringify(manifest.mergeHashInjection.artifact, null, 2) + "\n", "utf8");
    console.error(`[make-fixture] --emit-golden: ${outPath} 기록됨`);
  }

  if (cleanup) {
    fs.rmSync(baseDir, { recursive: true, force: true });
  } else {
    console.error(`[make-fixture] 픽스처가 유지됩니다: ${baseDir}`);
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
