// scripts/lib/fs-walk.mjs
//
// 파일 순회(재귀) + 제외 규칙 유틸. 의존성 0.
//
// 설계 원칙(중요): 이 모듈 자신은 "무엇을 제외할지"를 하드코딩하지 않는다.
// 제외 목록(excludeDirs)은 항상 호출자가 넘긴다. Phase 0-C 스펙 요구사항인
// "제외 규칙은 기본 검사 루트(레포 루트) 실행에만 적용하고, 검사 루트가
// 인자로 명시 지정되면 적용하지 않는다"는 이 모듈이 아니라 호출자
// (scripts/validate-plugin.mjs)가 excludeDirs 배열을 비우거나 채우는
// 방식으로 구현한다 — 그래야 필터가 이 모듈에 하드코딩되지 않는다.
//
// walk()는 절대경로 파일 목록을 반환한다. 심볼릭 링크는 따라가지 않는다
// (순환 참조 방지 및 예측 가능성).

import fs from "node:fs";
import path from "node:path";

/**
 * root 아래를 재귀 순회해 파일(디렉터리 제외) 절대경로 배열을 반환한다.
 *
 * @param {string} root 순회 시작 디렉터리(절대경로 권장)
 * @param {object} [opts]
 * @param {string[]} [opts.excludeDirs] 이 절대경로 목록과 정확히 일치하는
 *   디렉터리는 하위로 내려가지 않는다(prefix 비교가 아니라 정확한 경로
 *   비교 — 상위 디렉터리 이름이 우연히 접두어로 겹치는 오탐을 막는다).
 * @returns {string[]} 절대경로 파일 목록(디렉터리 미포함)
 */
export function walk(root, opts = {}) {
  const excludeDirs = new Set((opts.excludeDirs ?? []).map((p) => path.resolve(p)));
  const out = [];

  function recurse(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // 경로가 없거나 읽기 불가 — 조용히 스킵(호출자가 존재 여부를 먼저
      // 확인하는 것이 정상 경로이므로 여기서는 예외를 던지지 않는다).
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // 심볼릭 링크는 순회하지 않는다
      if (entry.isDirectory()) {
        if (excludeDirs.has(path.resolve(full))) continue;
        recurse(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  recurse(root);
  return out;
}

/**
 * dir 바로 아래(1단계)의 하위 디렉터리 이름 배열을 반환한다.
 * dir이 없으면 빈 배열(스킬 0개 등 "아직 없음" 상태를 정상 취급하기 위함).
 */
export function listSubdirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * dir 바로 아래(1단계)의 파일 중 확장자가 ext(예: '.json')인 파일의
 * 절대경로 배열을 반환한다. dir이 없으면 빈 배열.
 */
export function listFilesByExt(dir, ext) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && path.extname(e.name) === ext)
    .map((e) => path.join(dir, e.name));
}

export function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** root 기준 상대경로를 posix 구분자(`/`)로 정규화해 반환한다(메시지 출력용). */
export function toPosixRel(root, absPath) {
  return path.relative(root, absPath).split(path.sep).join("/");
}
