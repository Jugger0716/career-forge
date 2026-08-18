// scripts/lib/store.mjs
//
// §6·§9·AC-15가 확정한 저장 루트·`<repo-key>` 산출의 단일 정본. 의존성 0
// (node:crypto만 사용). 이 파일 밖에서 저장 루트나 `<repo-key>`를 재계산하지
// 않는다 — 재계산 지점이 둘로 갈리면 스테일 판정(AC-22)과 identity 집합
// 조회(AC-7 (a)축)가 서로 다른 파일을 정본으로 삼게 된다.
//
// - STATE_DIR_NAME: 디렉터리 "이름" 상수(§9). 저장 루트 그 자체가 아니다.
// - 기본 저장 루트: `~/.devcareer/<repo-key>/`
// - 명시 동의 시 저장 루트: `<repo>/.devcareer/`(레포 하위 재키잉 없음 —
//   레포 내부에 있다는 사실 자체가 레포를 식별하므로 <repo-key> 서브
//   디렉터리를 두지 않는다)
//
// `<repo-key>` 산출 4단계(§6 원문 그대로 구현 — 새로 발명하지 않는다):
//   1. 입력 정본화 — `git -C <repo> rev-parse --show-toplevel`
//   2. 정규화(순서 고정) — NFC → 확장 길이 접두사 제거 → 백슬래시→슬래시 →
//      연속 슬래시 축약(선행 UNC "//" 보존) → 후행 "/" 제거(드라이브 루트
//      예외) → 대소문자 비구분 플랫폼(Windows)에서 전체 소문자 폴드
//   3. 키 조립 — `<slug>-<hash8>` (slug: 마지막 경로 요소를 ASCII 소문자화 +
//      `[^a-z0-9]+`→`-` 치환 + 앞뒤 `-` 제거 + 32자 절단, 빈 문자열이면
//      "repo". hash8: 정규화 경로 UTF-8 바이트의 SHA-256 hex 앞 8자)
//   4. 충돌 처리 — `<repo-key>/.repo-key`에 정규화 경로 SHA-256 전체 64자
//      hex를 담아 대조. 대상 디렉터리가 있고 `.repo-key` 값이 다르면
//      hash8 자릿수를 8→12→16→…→64로 4자씩 늘려 같은 절차를 반복한다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runGit } from "./git.mjs";

/** §9: 디렉터리 이름 상수(정본). 저장 루트 값이 아니라 이름 하나다. */
export const STATE_DIR_NAME = ".devcareer";

// 콜드 리뷰 A-21 대응: §7 고정 프리픽스와 (exit code, stderr) 3분류가
// 예전에는 이 파일에 별도로(GIT_FIXED_PREFIX_ARGS 재정의 + execFileSync
// 직접 호출) 존재해, git.mjs가 §7 정본으로 diff.renames 등을 추가해도
// 이 사본은 따라가지 않았다(실측: git.mjs만 고쳐도 4개 게이트 전부
// 녹색). scripts/lib/git.mjs의 runGit()을 그대로 import해서 쓰면 프리픽스·
// 3분류 둘 다 자동으로 단일 정본을 공유한다(circular import 없음 —
// git.mjs는 node:child_process 하나만 의존한다).
//
// 아울러 execFileSync는 non-zero exit에서 예외를 던지므로 비-git 디렉터리를
// `--repo`로 주면 "fatal: not a git repository" 영어 원문이 그대로 노출되고
// 그 위에 "[오류] 수집 실패: Command failed: git -C ..."가 다시 덧씌워져
// 같은 메시지가 두 번 노출됐다 — runGit + classifyGitOutcome 경로로 바꾸면
// 이 파일이 실패 사유(outcome)를 스스로 분류해 명확한 한국어 메시지로
// 감쌀 수 있다.

/**
 * §6 step 1 — 입력 정본화. 사용자가 넘긴 문자열이 아니라
 * `git -C <repo> rev-parse --show-toplevel`의 출력을 이후 정규화의 입력으로
 * 쓴다. 상대 경로(`.`/`..`)·심볼릭 링크·레포 하위 디렉터리 지정이 여기서
 * 한 번에 해소된다(비-git 경로는 실행 대상이 아니므로 이 함수의 계약 밖).
 *
 * @param {string} repoPathInput 사용자가 지정한 경로(레포 루트 또는 그 하위)
 * @returns {string} git이 보고하는 레포 최상위 절대경로(원문 그대로, 아직
 *   정규화 전)
 */
export function getRepoToplevel(repoPathInput) {
  const r = runGit(repoPathInput, ["rev-parse", "--show-toplevel"]);
  if (r.outcome !== "ok") {
    throw new Error(
      `git 레포 최상위 경로를 확인할 수 없습니다(경로=${repoPathInput}, outcome=${r.outcome}): ` +
      `${(r.stderr ?? "").trim() || "(stderr 없음)"}`
    );
  }
  return r.stdout.trim();
}

/**
 * §6 step 2 — 정규화(순서 고정, 여섯 단계). 순서를 바꾸면 결과가 갈릴 수
 * 있으므로 원문이 명시한 순서를 그대로 지킨다.
 *
 * @param {string} rawPath
 * @returns {string} 정규화된 경로 문자열
 */
export function normalizeRepoPath(rawPath) {
  // (i) 유니코드 NFC 정규화
  let p = rawPath.normalize("NFC");

  // (ii) `\\?\` / `\\?\UNC\` 확장 길이 접두사 제거
  if (p.startsWith("\\\\?\\UNC\\")) {
    p = "\\\\" + p.slice("\\\\?\\UNC\\".length);
  } else if (p.startsWith("\\\\?\\")) {
    p = p.slice("\\\\?\\".length);
  }

  // (iii) 모든 백슬래시를 `/`로 치환
  p = p.replace(/\\/g, "/");

  // (iv) 연속 슬래시를 하나로 축약(단 UNC를 뜻하는 선행 `//`는 보존)
  const isUncLeading = /^\/\/(?!\/)/.test(p);
  if (isUncLeading) {
    p = "//" + p.slice(2).replace(/\/{2,}/g, "/");
  } else {
    p = p.replace(/\/{2,}/g, "/");
  }

  // (v) 후행 `/` 제거(드라이브 루트 `c:/`는 예외로 보존)
  if (!/^[A-Za-z]:\/$/.test(p)) {
    p = p.replace(/\/+$/, "");
  }

  // (vi) 대소문자 비구분 플랫폼(Windows)에서는 전체를 ASCII 소문자로 폴드,
  // 대소문자 구분 플랫폼(POSIX)에서는 케이스를 보존한다. 드라이브 문자는
  // 이 단계에 의해 Windows에서 항상 소문자가 된다.
  if (process.platform === "win32") {
    p = p.toLowerCase();
  }

  return p;
}

/**
 * §6 step 3 — 키 조립 재료(slug, 정규화 경로 SHA-256 전체 hex)를 계산한다.
 * slug는 장식일 뿐이고 레포 동일성 판정은 전적으로 hash가 한다(한글 레포명은
 * slug가 "repo"로 축약돼도 hash는 정확히 구분한다).
 *
 * @param {string} normalizedPath normalizeRepoPath()의 출력
 * @returns {{slug: string, fullHashHex: string}}
 */
export function computeRepoKeyParts(normalizedPath) {
  const segments = normalizedPath.split("/").filter(Boolean);
  const lastSeg = segments.length > 0 ? segments[segments.length - 1] : "";
  let slug = lastSeg
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (!slug) slug = "repo";

  const fullHashHex = crypto
    .createHash("sha256")
    .update(Buffer.from(normalizedPath, "utf8"))
    .digest("hex");

  return { slug, fullHashHex };
}

/**
 * §6 step 4 — 충돌 처리. `homeRoot` 아래 `<slug>-<hash8>` 디렉터리를 찾되,
 * 이미 존재하는데 그 `.repo-key`(전체 64자 hex)가 지금 계산한 값과 다르면
 * hash8 자릿수를 8 → 12 → 16 → … → 64로 4자씩 늘려 재시도한다. 확장 순서가
 * 고정이므로 같은 입력은 언제나 같은 키에 도달한다(충돌 시에도 결정적).
 *
 * 이 함수는 순수 조회다 — 디스크에 아무것도 쓰지 않는다. 실제로 디렉터리와
 * `.repo-key` 파일을 만드는 것은 `ensureRepoKeyDir`의 몫이다.
 *
 * @param {string} normalizedPath
 * @param {{homeRoot: string}} opts
 * @returns {{repoKey: string, dir: string, fullHashHex: string}}
 */
export function resolveRepoKey(normalizedPath, { homeRoot }) {
  const { slug, fullHashHex } = computeRepoKeyParts(normalizedPath);

  for (let hashLen = 8; hashLen <= 64; hashLen += 4) {
    const hash8 = fullHashHex.slice(0, hashLen);
    const repoKey = `${slug}-${hash8}`;
    const dir = path.join(homeRoot, repoKey);
    const repoKeyFile = path.join(dir, ".repo-key");

    if (!fs.existsSync(repoKeyFile)) {
      // 아직 아무도 이 디렉터리를 이 정규화 경로로 확정하지 않았다 —
      // 비어 있거나(디렉터리 자체가 없음) 다른 목적의 디렉터리라도
      // `.repo-key`가 없으면 이 입력에 대해 처음 도달한 슬롯으로 취급한다.
      return { repoKey, dir, fullHashHex };
    }

    const existing = fs.readFileSync(repoKeyFile, "utf8").trim();
    if (existing === fullHashHex) {
      return { repoKey, dir, fullHashHex }; // 같은 레포 — 확정된 기존 키 재사용
    }
    // 값이 다르면 다른 레포가 같은 <slug>-<hash8>을 선점한 것 — 자릿수 확장.
  }

  throw new Error(
    `repo-key 충돌 해소 실패: 64자 hex까지 확장했으나 해소되지 않았습니다(${normalizedPath})`
  );
}

/**
 * `resolveRepoKey`가 고른 디렉터리를 실제로 만들고 `.repo-key`(정규화 경로
 * SHA-256 전체 64자 hex — 절대경로 원문은 쓰지 않는다, AC-15)를 원자적으로
 * (temp→rename) 써서 그 레포의 키로 확정한다. 이미 확정돼 있으면 그대로
 * 반환한다(멱등).
 *
 * @param {string} normalizedPath
 * @param {{homeRoot: string}} opts
 * @returns {{repoKey: string, dir: string, fullHashHex: string}}
 */
export function ensureRepoKeyDir(normalizedPath, { homeRoot }) {
  const resolved = resolveRepoKey(normalizedPath, { homeRoot });
  const repoKeyFile = path.join(resolved.dir, ".repo-key");

  if (!fs.existsSync(repoKeyFile)) {
    fs.mkdirSync(resolved.dir, { recursive: true });
    const tmp = path.join(
      resolved.dir,
      `.repo-key.tmp-${process.pid}-${Date.now()}`
    );
    fs.writeFileSync(tmp, resolved.fullHashHex, "utf8");
    fs.renameSync(tmp, repoKeyFile);
  }

  return resolved;
}

/**
 * 저장 루트 해석의 단일 진입점(§6·§9·AC-15). config.json의 `storage` 값에
 * 따라 기본(`home`) 또는 명시 동의(`repo`) 루트를 반환한다.
 *
 * - `home`(기본): `~/.devcareer/<repo-key>/` — `<repo-key>`는 위 4단계로
 *   결정적으로 산출하고, 처음 해석되는 시점에 디렉터리와 `.repo-key`를
 *   확정(ensureRepoKeyDir)한다.
 * - `repo`(명시 동의, `storage.repoOptIn === true` 필수): `<repo>/.devcareer/`
 *   — 레포 내부이므로 `<repo-key>` 서브 디렉터리를 두지 않는다(이미 그
 *   레포 안에 있다는 사실 자체가 레포를 식별한다).
 *
 * @param {object} opts
 * @param {string} opts.repoPath 대상 레포 경로(루트 또는 그 하위)
 * @param {{root?: "home"|"repo", repoOptIn?: boolean}} [opts.storage]
 * @param {string} [opts.homeRoot] 테스트 전용 — 실제 os.homedir() 대신 쓸
 *   임시 홈 루트(생략 시 `~/.devcareer`)
 * @returns {{root: string, repoKey: string|null, mode: "home"|"repo"}}
 */
export function resolveStorageRoot({ repoPath, storage, homeRoot } = {}) {
  const toplevel = getRepoToplevel(repoPath);

  if (storage && storage.root === "repo") {
    if (!storage.repoOptIn) {
      throw new Error(
        "storage.root === 'repo'는 storage.repoOptIn === true 명시 동의가 있어야 합니다(§6 프라이버시 기본값)."
      );
    }
    return {
      root: path.join(toplevel, STATE_DIR_NAME),
      repoKey: null,
      mode: "repo",
    };
  }

  const normalized = normalizeRepoPath(toplevel);
  const effectiveHomeRoot = homeRoot ?? path.join(os.homedir(), STATE_DIR_NAME);
  const { repoKey, dir } = ensureRepoKeyDir(normalized, { homeRoot: effectiveHomeRoot });
  return { root: dir, repoKey, mode: "home" };
}

/**
 * `getRepoToplevel` → `normalizeRepoPath` → `resolveRepoKey`를 한 번에
 * 수행하는 편의 함수(디스크에 쓰지 않는 순수 조회 — 테스트·조회 전용).
 * AC-15의 "같은 레포를 표기만 다른 절대경로로 지정해도 동일한 `<repo-key>`가
 * 나온다" 오라클이 이 함수를 직접 검증한다.
 *
 * @param {string} repoPathInput
 * @param {{homeRoot: string}} opts
 * @returns {{repoKey: string, dir: string, fullHashHex: string, normalizedPath: string}}
 */
export function computeRepoKeyForPath(repoPathInput, { homeRoot }) {
  const toplevel = getRepoToplevel(repoPathInput);
  const normalizedPath = normalizeRepoPath(toplevel);
  const resolved = resolveRepoKey(normalizedPath, { homeRoot });
  return { ...resolved, normalizedPath };
}
