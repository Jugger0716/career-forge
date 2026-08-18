#!/usr/bin/env node
// scripts/validate-plugin.mjs
//
// 이 프로젝트 최초의 Layer 1 기계 검증 하네스(Phase 0-C). 의존성 0.
//
// 사용법:
//   node scripts/validate-plugin.mjs                 레포 루트 기준 전체 검사
//   node scripts/validate-plugin.mjs <root>           <root>를 검사 루트로 명시 지정
//   node scripts/validate-plugin.mjs --negative <root>  위와 동일 + "이 호출은
//                                                      negative 픽스처 검사"임을
//                                                      명시(의미상 동일하게
//                                                      명시 루트 규칙 적용 —
//                                                      tests/run-smoke.mjs가
//                                                      각 tests/fixtures-invalid/
//                                                      케이스 디렉터리를 이 형태로
//                                                      호출한다)
//   node scripts/validate-plugin.mjs --lang-check <out>  AC-19 언어 린트만 실행
//   node scripts/validate-plugin.mjs --schema-check <path>  AC-12 스키마
//                                                      레벨 강제(evidence
//                                                      배열이 비면
//                                                      basis:insufficient
//                                                      강제 등)를 산출물
//                                                      JSON 파일 하나에
//                                                      대해 실행. 파일명
//                                                      (확장자 제외)으로
//                                                      schemas/<layer>.
//                                                      schema.json을 정함
//
// 검사 항목(AC-2·AC-3·AC-4·AC-18):
//   1. plugin.json 필수 필드
//   2. skills/*/SKILL.md frontmatter(name/description 존재, name↔디렉터리
//      일치, description 3인칭 — skills/ 자체가 없으면 0건으로 통과)
//   3. schemas/*.json 파싱 + 자작 검증기 지원 범위 밖 키워드 경고
//   4. 문서(README.md, skills/*/SKILL.md) 내 상대 경로 참조 실재성
//   5. 명명·라이선스 일관성:
//      - plugin.json name ↔ package.json/marketplace.json
//      - plugin.json license 값 기준 LICENSE 파일 본문 대조(하드코딩 MIT
//        아님 — 알려진 SPDX 밖 값은 FAIL이 아니라 명시적 SKIP 경고)
//      - README 라이선스 배지 ↔ plugin.json license
//      - 상태 디렉터리 이름 상수(§9 `.devcareer`) 정의(STATE_DIR_NAME) ↔
//        README.md·.gitignore 등 참조 지점 일치(AC-3)
//      - 슬래시 명령 접두사 ↔ plugin.json name 일치, README.md·
//        docs/**/*.md·skills/*/SKILL.md 전체를 스캔 대상으로 함(AC-18)
//   6. 워킹 트리 CR 가드
//
// 제외 규칙: 위 검사들은 "검사 루트 자신"만 스캔 대상으로 삼는다(예:
// <root>/schemas, <root>/skills, <root>/README.md). 유일하게 CR 가드만
// 검사 루트 전체를 재귀 순회하므로, "기본 루트(레포 루트)에서는
// tests/fixtures-invalid/를 제외하고, 검사 루트가 인자로 명시 지정되면
// 제외하지 않는다"는 규칙이 실질적으로 CR 가드에만 적용된다. 이 필터는
// scripts/lib/fs-walk.mjs에 하드코딩되어 있지 않고 이 파일이 호출 시점에
// 결정한다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  walk,
  listSubdirs,
  listFilesByExt,
  fileExists,
  dirExists,
  toPosixRel,
} from "./lib/fs-walk.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";
import { scanUnsupportedKeywords, validateInstance } from "./lib/schema-validate.mjs";
import { lintFreeText } from "./lib/lang-lint.mjs";
import { STATE_DIR_NAME } from "./lib/store.mjs";
import { checkEvidenceInvariants } from "./lib/invariants.mjs";
import { checkSamplingMethodLiteralDrift } from "./lib/sampling-literal-drift.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const REQUIRED_PLUGIN_FIELDS = ["name", "version", "description", "author", "license"];

// 워킹 트리 CR 가드가 "텍스트"로 취급할 파일 판정 규칙.
const TEXT_EXTENSIONS = new Set([
  ".md", ".json", ".mjs", ".js", ".cjs", ".mts", ".ts",
  ".yml", ".yaml", ".txt", ".sh", ".ps1",
]);
const TEXT_BASENAMES = new Set(["LICENSE", "README", ".gitignore", ".gitattributes"]);

// CR 가드에서 항상(검사 루트와 무관하게) 제외하는 디렉터리 — 스펙 범위 밖
// 산출물/작업 디렉터리이며, 필터를 "일반 규칙"이 아니라 이 구조적 예외로만
// 둔다(§ 임무 지침 "skills/ 아직 없다"·".harness/ gitignore 대상" 등).
const ALWAYS_EXCLUDED_DIR_NAMES = new Set([".git", "node_modules", ".harness", ".devcareer"]);

// .gitattributes가 `eol=lf`로 명시 고정한 경로(= "결정적 스크립트는 플랫폼과
// 무관하게 항상 LF"). 이 목록은 .gitattributes의 다음 세 줄을 그대로 거울
// 반영한다 — .gitattributes가 바뀌면 이 목록도 함께 바꿔야 한다:
//   scripts/**/*.mjs text eol=lf
//   tests/**/*.mjs   text eol=lf
//   fixtures/**/*.mjs text eol=lf
// 이 범위의 파일은 CR이 단 1바이트라도 섞이면(CRLF로 짝지어져 있어도) FAIL —
// node 실행·diff 노이즈 방지가 목적이므로 "쌍이 맞는 CRLF라 무해하다"는
// 예외를 두지 않는다.
const LF_ENFORCED_TOP_DIRS = ["scripts/", "tests/", "fixtures/"];
function isLfEnforcedPath(relPosixPath) {
  if (!relPosixPath.endsWith(".mjs")) return false;
  return LF_ENFORCED_TOP_DIRS.some((d) => relPosixPath.startsWith(d));
}

// 문서 내 상대 경로 참조 검사 대상 접두사/파일명. 이 목록 밖의 백틱/링크
// 토큰(예: 개념적 산출물 파일명 `career.json`, 슬래시 명령 `/devcareer-prep:x`,
// 저장 루트 표현 `.devcareer/`)은 "이 레포에 실재해야 하는 소스 경로"가
// 아니므로 대상에서 제외한다 — 무조건 전체 문서 텍스트를 경로로 오인하면
// 정상 레포에서도 exit 0이 구조적으로 불가능해진다.
const CHECKABLE_PATH_PREFIXES = [
  "scripts/", "schemas/", "skills/", "tests/", "fixtures/",
  "references/", "examples/", "docs/", ".claude-plugin/",
];
const CHECKABLE_BARE_FILES = new Set([
  "LICENSE", "README.md", "package.json", ".gitignore", ".gitattributes",
]);

const FIRST_PERSON_RE = /^\s*(저는|제가|나는|내가|우리는|우리가|I\s|I'm\s|My\s+|We\s+|Our\s+)/i;

// AC-3(a): 상태 디렉터리 이름 상수(§9)의 정본은 `scripts/lib/store.mjs`
// 하나다(위 import). 이 파일은 그 상수를 참조만 하고 재정의하지 않는다 —
// 정의 지점이 둘로 갈리면 이 검사(STATE_DIR_NAME_INCONSISTENT)가 자기
// 자신의 기준점과 어긋날 수 있다.

// 알려진 SPDX 라이선스 ID → LICENSE 파일 본문에서 그 라이선스임을 식별하는
// 패턴. plugin.json의 license 값이 여기 없는 값이면 "알 수 없는 라이선스"로
// 보아 FAIL이 아니라 명시적 SKIP(경고)으로 보고한다(AC-3(b) — MIT 하드코딩
// 회귀 방지).
const LICENSE_TEXT_PATTERNS = {
  "MIT": /\bMIT License\b/i,
  "Apache-2.0": /Apache License[,]?\s*Version 2\.0/i,
  "ISC": /\bISC License\b/i,
  "BSD-2-Clause": /BSD 2-Clause License/i,
  "BSD-3-Clause": /BSD 3-Clause License/i,
  "GPL-3.0": /GNU GENERAL PUBLIC LICENSE\s*\n?\s*Version 3/i,
  "GPL-2.0": /GNU GENERAL PUBLIC LICENSE\s*\n?\s*Version 2/i,
  "MPL-2.0": /Mozilla Public License Version 2\.0/i,
  "Unlicense": /This is free and unencumbered software/i,
};

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function isTextFile(absPath) {
  const base = path.basename(absPath);
  const ext = path.extname(absPath);
  if (TEXT_BASENAMES.has(base)) return true;
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * 마크다운 텍스트에서 "이 레포 소스 트리에 실재해야 하는" 상대 경로 참조
 * 후보를 뽑는다. 펜스 코드 블록(```...```)은 셸 예시가 섞여 오탐을 내므로
 * 먼저 제거한다. 백틱 인라인 코드와 마크다운 링크 대상 두 형태를 본다.
 */
function extractPathReferences(mdText) {
  const stripped = mdText.replace(/```[\s\S]*?```/g, "");
  const candidates = new Set();

  for (const m of stripped.matchAll(/`([^`\n]+)`/g)) candidates.add(m[1].trim());
  for (const m of stripped.matchAll(/\]\(([^)\s]+)\)/g)) candidates.add(m[1].trim());

  const refs = [];
  for (let c of candidates) {
    if (!c || c.includes("<") || c.includes(">")) continue;
    if (c.startsWith("~")) continue;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(c)) continue; // URL(http://, https:// 등)
    if (c.startsWith("./")) c = c.slice(2);
    if (c.includes(" ")) continue; // 셸 커맨드 등 경로가 아닌 텍스트
    if (!/^[\w.\-/]+$/.test(c)) continue; // 경로에 쓰일 수 없는 문자 포함(예: 콜론 — 슬래시 명령)

    const isPrefixMatch = CHECKABLE_PATH_PREFIXES.some((p) => c.startsWith(p));
    const isBareMatch = CHECKABLE_BARE_FILES.has(c.replace(/\/+$/, ""));
    if (isPrefixMatch || isBareMatch) refs.push(c);
  }
  return refs;
}

function checkPluginJson(root, errors) {
  const p = path.join(root, ".claude-plugin", "plugin.json");
  const rel = toPosixRel(root, p);
  if (!fileExists(p)) {
    errors.push({ code: "PLUGIN_JSON_NOT_FOUND", message: ".claude-plugin/plugin.json이 없습니다.", file: rel });
    return null;
  }
  let json;
  try {
    json = readJson(p);
  } catch (e) {
    errors.push({ code: "PLUGIN_JSON_INVALID_JSON", message: `plugin.json 파싱 실패: ${e.message}`, file: rel });
    return null;
  }
  for (const field of REQUIRED_PLUGIN_FIELDS) {
    if (!(field in json) || json[field] === "" || json[field] == null) {
      errors.push({
        code: "PLUGIN_JSON_MISSING_FIELD",
        message: `plugin.json에 필수 필드 '${field}'가 없습니다.`,
        file: rel,
      });
    }
  }
  if (json.author && typeof json.author === "object" && !json.author.name) {
    errors.push({ code: "PLUGIN_JSON_MISSING_FIELD", message: "plugin.json의 author.name이 없습니다.", file: rel });
  }
  return json;
}

function checkSkills(root, errors) {
  const skillsDir = path.join(root, "skills");
  const dirNames = listSubdirs(skillsDir); // skills/ 자체가 없으면 [] — 정상
  for (const dirName of dirNames) {
    const skillMdPath = path.join(skillsDir, dirName, "SKILL.md");
    const rel = toPosixRel(root, skillMdPath);
    if (!fileExists(skillMdPath)) {
      errors.push({ code: "SKILL_MD_NOT_FOUND", message: `skills/${dirName}/SKILL.md가 없습니다.`, file: rel });
      continue;
    }
    const raw = fs.readFileSync(skillMdPath, "utf8");
    const fm = parseFrontmatter(raw);
    if (!fm) {
      errors.push({ code: "SKILL_FRONTMATTER_MISSING", message: "YAML frontmatter(--- ... ---) 블록이 없습니다.", file: rel });
      continue;
    }
    const { name, description } = fm.fields;
    if (!name) {
      errors.push({ code: "SKILL_NAME_MISSING", message: "frontmatter에 name 필드가 없습니다.", file: rel });
    } else if (name !== dirName) {
      errors.push({
        code: "SKILL_NAME_DIR_MISMATCH",
        message: `frontmatter name('${name}')이 디렉터리명('${dirName}')과 다릅니다.`,
        file: rel,
      });
    }
    if (!description) {
      errors.push({ code: "SKILL_DESCRIPTION_MISSING", message: "frontmatter에 description 필드가 없습니다.", file: rel });
    } else if (FIRST_PERSON_RE.test(description)) {
      errors.push({
        code: "SKILL_DESCRIPTION_FIRST_PERSON",
        message: `description이 1인칭으로 시작합니다(3인칭 서술 필요): "${description}"`,
        file: rel,
      });
    }
  }
}

function checkSchemas(root, errors, warnings) {
  const schemasDir = path.join(root, "schemas");
  const files = listFilesByExt(schemasDir, ".json"); // schemas/ 없으면 []
  for (const f of files) {
    const rel = toPosixRel(root, f);
    let json;
    try {
      json = readJson(f);
    } catch (e) {
      errors.push({ code: "SCHEMA_JSON_PARSE_ERROR", message: `${path.basename(f)} 파싱 실패: ${e.message}`, file: rel });
      continue;
    }
    for (const { path: p, keyword } of scanUnsupportedKeywords(json)) {
      warnings.push({
        code: "SCHEMA_UNSUPPORTED_KEYWORD",
        message: `'${keyword}' 키워드(${p})는 자작 검증기가 지원하지 않습니다.`,
        file: rel,
      });
    }
  }
}

function checkDocPathReferences(root, errors) {
  const docFiles = [path.join(root, "README.md")];
  for (const dirName of listSubdirs(path.join(root, "skills"))) {
    docFiles.push(path.join(root, "skills", dirName, "SKILL.md"));
  }
  for (const doc of docFiles) {
    if (!fileExists(doc)) continue;
    const rel = toPosixRel(root, doc);
    const text = fs.readFileSync(doc, "utf8");
    for (const ref of extractPathReferences(text)) {
      const abs = path.join(root, ref);
      if (!fileExists(abs) && !dirExists(abs)) {
        errors.push({
          code: "DOC_PATH_NOT_FOUND",
          message: `문서가 참조하는 경로 '${ref}'가 레포에 존재하지 않습니다.`,
          file: rel,
        });
      }
    }
  }
}

function extractReadmeLicenseBadge(readmeText) {
  let m = /!\[License:\s*([^\]]+)\]/i.exec(readmeText);
  if (m) return m[1].trim();
  m = /License-([A-Za-z0-9.\-]+)-[a-z]+\.svg/i.exec(readmeText);
  if (m) return m[1].replace(/--/g, "-").trim();
  return null;
}

function normalizeLicense(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * AC-3(a): 상태 디렉터리 이름 상수(§9 `.devcareer`)의 정의 지점(이 파일의
 * STATE_DIR_NAME)과 참조 지점(README.md·.gitignore 등 문서/설정 파일) 사이
 * 일치를 검사한다.
 *
 * 백틱 인라인 코드 스팬(` `...` `)에서 "devcareer"를 포함하는 경로 세그먼트를
 * 뽑아 정본과 대조한다. 백틱 스팬만 보는 이유: 트리플 펜스 코드 블록
 * (```...```)이나 "DevCareer Prep"처럼 공백 섞인 산문 속 제품명은 상태
 * 디렉터리 경로 표기가 아니므로 후보에서 자연히 빠져야 오탐이 나지 않는다.
 * `/devcareer-prep:career-from-git` 같은 슬래시 명령 표기(콜론 포함, AC-18
 * 소관)와 plugin.json `name` 값 자체(`devcareer-prep`) 참조는 별도로 제외한다.
 *
 * .gitignore는 인라인 코드 스팬 표기가 없는 평문 패턴 파일이므로, 주석이
 * 아닌 패턴 라인(`.devcareer/` 등) 자체도 토큰으로 추가 수집한다.
 */
function extractBacktickDirTokens(text) {
  const tokens = new Set();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    for (const seg of m[1].split("/")) {
      const t = seg.trim();
      if (t) tokens.add(t);
    }
  }
  return tokens;
}

function extractGitignorePatternTokens(text) {
  const tokens = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue; // 주석은 백틱 추출로 별도 처리됨
    tokens.add(line.replace(/\/+$/, ""));
  }
  return tokens;
}

function isStateDirCandidateToken(token, pluginName) {
  if (!/devcareer/i.test(token)) return false;
  if (token.includes(":")) return false; // 슬래시 명령 표기 — AC-18 소관
  if (pluginName && token.toLowerCase() === pluginName.toLowerCase()) return false; // plugin.json name 자체 참조
  return true;
}

function checkStateDirConsistency(root, pluginJson, errors) {
  const pluginName = pluginJson?.name;
  const refFiles = [
    { rel: "README.md", extractTokens: (text) => extractBacktickDirTokens(text) },
    {
      rel: ".gitignore",
      extractTokens: (text) => new Set([
        ...extractBacktickDirTokens(text),
        ...extractGitignorePatternTokens(text),
      ]),
    },
  ];

  for (const { rel, extractTokens } of refFiles) {
    const abs = path.join(root, rel);
    if (!fileExists(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    for (const token of extractTokens(text)) {
      if (!isStateDirCandidateToken(token, pluginName)) continue;
      const bare = token.replace(/\/+$/, "");
      if (bare !== STATE_DIR_NAME) {
        errors.push({
          code: "STATE_DIR_NAME_INCONSISTENT",
          message: `'${rel}'의 상태 디렉터리 표기('${token}')가 정본 상수('${STATE_DIR_NAME}')와 다릅니다.`,
          file: rel,
        });
      }
    }
  }
}

/**
 * AC-3(b): plugin.json의 license 값을 그대로 대조 기준으로 삼는다(하드코딩
 * "MIT" 회귀 방지). LICENSE_TEXT_PATTERNS에 없는 값(알 수 없는 라이선스)은
 * FAIL이 아니라 경고 + 명시적 SKIP 코드로 보고한다.
 */
function checkLicenseFileMatches(root, pluginLicense, errors, warnings) {
  const licensePath = path.join(root, "LICENSE");
  if (!fileExists(licensePath) || !pluginLicense) return;
  const rel = toPosixRel(root, licensePath);
  const text = fs.readFileSync(licensePath, "utf8");
  const pattern = LICENSE_TEXT_PATTERNS[pluginLicense];
  if (!pattern) {
    warnings.push({
      code: "LICENSE_CHECK_SKIPPED_UNKNOWN_SPDX",
      message: `plugin.json license('${pluginLicense}')는 알려진 SPDX ID 목록에 없어 LICENSE 파일 내용 대조를 건너뜁니다(수동 확인 필요).`,
      file: rel,
    });
    return;
  }
  if (!pattern.test(text)) {
    errors.push({
      code: "LICENSE_FILE_MISMATCH",
      message: `LICENSE 파일 내용이 plugin.json license('${pluginLicense}')와 일치하지 않는 것으로 보입니다.`,
      file: rel,
    });
  }
}

function checkNamingConsistency(root, pluginJson, errors, warnings) {
  if (!pluginJson) return; // plugin.json 자체가 없거나 깨졌으면 이 검사는 의미 없음(이미 별도 FAIL 기록됨)

  const pluginName = pluginJson.name;
  const pluginLicense = pluginJson.license;
  const pluginVersion = pluginJson.version;

  // package.json
  const pkgPath = path.join(root, "package.json");
  if (fileExists(pkgPath)) {
    try {
      const pkg = readJson(pkgPath);
      const rel = toPosixRel(root, pkgPath);
      if (pluginName && pkg.name && pkg.name !== pluginName) {
        errors.push({
          code: "PLUGIN_NAME_MISMATCH",
          message: `package.json name('${pkg.name}')이 plugin.json name('${pluginName}')과 다릅니다.`,
          file: rel,
        });
      }
      if (pluginLicense && pkg.license && pkg.license !== pluginLicense) {
        errors.push({
          code: "LICENSE_FIELD_MISMATCH",
          message: `package.json license('${pkg.license}')가 plugin.json license('${pluginLicense}')와 다릅니다.`,
          file: rel,
        });
      }
      // 콜드 리뷰 A-35 대응: version은 plugin.json/marketplace.json/
      // package.json 세 파일에 완전 중복으로 존재한다(같은 값을 세 곳에
      // 수기로 맞춰야 한다) — 릴리스 시 한 곳만 올리고 잊는 드리프트를
      // 여기서 잡는다. description/keywords는 package.json에서 npm 배포용
      // 문구·필드 구성이 plugin.json과 원래 다르게 설계돼 있어(package.json
      // 에는 keywords 필드 자체가 없다) 여기서는 name/license/version만
      // 대조하고, description/keywords 완전 중복은 marketplace.json
      // plugins[] 항목(아래)에서만 검사한다.
      if (pluginVersion && pkg.version && pkg.version !== pluginVersion) {
        errors.push({
          code: "PLUGIN_VERSION_MISMATCH",
          message: `package.json version('${pkg.version}')이 plugin.json version('${pluginVersion}')과 다릅니다.`,
          file: rel,
        });
      }
    } catch {
      // package.json 파싱 실패는 이 스크립트의 별도 관심사가 아니다(스펙 범위 밖 파일).
    }
  }

  // .claude-plugin/marketplace.json
  const marketplacePath = path.join(root, ".claude-plugin", "marketplace.json");
  if (fileExists(marketplacePath)) {
    try {
      const marketplace = readJson(marketplacePath);
      const rel = toPosixRel(root, marketplacePath);
      const names = (marketplace.plugins ?? []).map((p) => p.name);
      if (pluginName && names.length > 0 && !names.includes(pluginName)) {
        errors.push({
          code: "MARKETPLACE_NAME_MISMATCH",
          message: `marketplace.json의 plugins[].name(${names.join(", ")})에 plugin.json name('${pluginName}')이 없습니다.`,
          file: rel,
        });
      }
      // 콜드 리뷰 A-35 대응: metadata.version과 plugins[n].version(플러그인
      // 자기 항목)이 plugin.json version과 완전 중복 필드다 — 셋 다 대조한다.
      if (pluginVersion && marketplace.metadata?.version && marketplace.metadata.version !== pluginVersion) {
        errors.push({
          code: "PLUGIN_VERSION_MISMATCH",
          message: `marketplace.json metadata.version('${marketplace.metadata.version}')이 plugin.json version('${pluginVersion}')과 다릅니다.`,
          file: rel,
        });
      }
      const matchingEntry = (marketplace.plugins ?? []).find((p) => p.name === pluginName);
      if (matchingEntry) {
        if (pluginVersion && matchingEntry.version && matchingEntry.version !== pluginVersion) {
          errors.push({
            code: "PLUGIN_VERSION_MISMATCH",
            message: `marketplace.json의 plugins[].version('${matchingEntry.version}', name='${pluginName}')이 plugin.json version('${pluginVersion}')과 다릅니다.`,
            file: rel,
          });
        }
        // description/keywords는 plugin.json ↔ marketplace.json 사이에서만
        // 완전 중복이다(값을 그대로 복사해 온 필드) — 한쪽만 고치는
        // 드리프트를 여기서 잡는다.
        if (
          pluginJson.description !== undefined &&
          matchingEntry.description !== undefined &&
          matchingEntry.description !== pluginJson.description
        ) {
          errors.push({
            code: "PLUGIN_DESCRIPTION_MISMATCH",
            message: `marketplace.json의 plugins[].description(name='${pluginName}')이 plugin.json description과 다릅니다.`,
            file: rel,
          });
        }
        if (
          Array.isArray(pluginJson.keywords) &&
          Array.isArray(matchingEntry.keywords) &&
          JSON.stringify(matchingEntry.keywords) !== JSON.stringify(pluginJson.keywords)
        ) {
          errors.push({
            code: "PLUGIN_KEYWORDS_MISMATCH",
            message: `marketplace.json의 plugins[].keywords(name='${pluginName}')가 plugin.json keywords와 다릅니다(값 또는 순서 불일치).`,
            file: rel,
          });
        }
      }
    } catch {
      // 무시 — marketplace.json 자체 파싱은 이 검사의 관심사 밖
    }
  }

  // LICENSE 파일 (일반화 — plugin.json license 값 기준, 알 수 없는 값은 SKIP)
  checkLicenseFileMatches(root, pluginLicense, errors, warnings);

  // README.md 배지 + 슬래시 명령 접두사
  const readmePath = path.join(root, "README.md");
  if (fileExists(readmePath)) {
    const rel = toPosixRel(root, readmePath);
    const text = fs.readFileSync(readmePath, "utf8");

    if (pluginLicense) {
      const badgeLicense = extractReadmeLicenseBadge(text);
      if (badgeLicense && normalizeLicense(badgeLicense) !== normalizeLicense(pluginLicense)) {
        errors.push({
          code: "README_BADGE_LICENSE_MISMATCH",
          message: `README 배지의 라이선스('${badgeLicense}')가 plugin.json license('${pluginLicense}')와 다릅니다.`,
          file: rel,
        });
      }
    }

  }

  // AC-18: README·SKILL.md·docs 내 모든 /<prefix>:<command> 표기를 수집해
  // plugin.json name과 대조(README.md 하나만 보던 범위를 확장).
  if (pluginName) {
    checkCommandPrefixConsistency(root, pluginName, errors);
  }
}

/**
 * AC-18: 슬래시 명령 접두사 표기('/<prefix>:<command>')를 README.md ·
 * docs/**\/*.md · skills/*\/SKILL.md 전체에서 수집해 plugin.json name과
 * 문자열 일치 여부를 검사한다. 이전에는 README.md만 스캔해 docs/ 아래
 * 문서나 SKILL.md의 오기재를 놓쳤다.
 */
function collectDocFilesForPrefixScan(root) {
  const docs = [];
  const readmePath = path.join(root, "README.md");
  if (fileExists(readmePath)) docs.push(readmePath);

  const docsDir = path.join(root, "docs");
  if (dirExists(docsDir)) {
    for (const f of walk(docsDir)) {
      if (path.extname(f) === ".md") docs.push(f);
    }
  }

  for (const dirName of listSubdirs(path.join(root, "skills"))) {
    const skillMd = path.join(root, "skills", dirName, "SKILL.md");
    if (fileExists(skillMd)) docs.push(skillMd);
  }

  return docs;
}

function checkCommandPrefixConsistency(root, pluginName, errors) {
  for (const docPath of collectDocFilesForPrefixScan(root)) {
    const rel = toPosixRel(root, docPath);
    const text = fs.readFileSync(docPath, "utf8");
    const stripped = text.replace(/```[\s\S]*?```/g, "");
    const prefixes = new Set();
    for (const m of stripped.matchAll(/\/([A-Za-z0-9][A-Za-z0-9_-]*):[A-Za-z0-9][A-Za-z0-9_-]*/g)) {
      prefixes.add(m[1]);
    }
    for (const prefix of prefixes) {
      if (prefix !== pluginName) {
        errors.push({
          code: "COMMAND_PREFIX_MISMATCH",
          message: `문서의 슬래시 명령 접두사('/${prefix}:')가 plugin.json name('${pluginName}')에서 파생된 접두사와 다릅니다.`,
          file: rel,
        });
      }
    }
  }
}

/**
 * 콜드 리뷰 A-19 대응: 정본 samplingMethod 리터럴 네 곳(spec.md·스키마
 * description·sampling.mjs 상수·골든 스크립트 하드코딩 사본)이 서로
 * 일치하는지 검사한다. 이 검사는 검사 대상 "루트"(negative 픽스처 mini
 * 레포 등)와 무관하게 **이 레포 자신**(REPO_ROOT)의 네 파일을 항상
 * 대조한다 — 그 네 파일은 이 레포에만 존재하고(픽스처 mini 레포는 schemas/
 * ·fixtures/golden/·docs/를 두지 않는다) 정본 리터럴의 동기화는 검사
 * 대상 plugin 인스턴스가 아니라 이 소스 레포 자체의 내부 일관성이기
 * 때문이다.
 *
 * @param {{errors: object[]}} sink
 */
function checkSamplingMethodLiteralConsistency(errors) {
  const result = checkSamplingMethodLiteralDrift(REPO_ROOT);
  if (result.ok) return;

  if (result.missing.length > 0) {
    errors.push({
      code: "SAMPLING_METHOD_LITERAL_EXTRACT_FAILED",
      message:
        `정본 samplingMethod 리터럴을 다음 위치에서 추출하지 못했습니다(파일 부재 또는 형태 변경): ` +
        `${result.missing.join(", ")}`,
      file: result.missing[0],
    });
  }
  for (const m of result.mismatches) {
    errors.push({
      code: "SAMPLING_METHOD_LITERAL_DRIFT",
      message:
        `정본 samplingMethod 리터럴이 '${m}'에서 다른 세 곳과 다릅니다 — spec.md 구현 5단계 본문· ` +
        "schemas/evidence.schema.json의 coverage.samplingMethod description·scripts/lib/sampling.mjs의 " +
        "CANONICAL_SAMPLING_METHOD_LITERAL·fixtures/golden/compute-sampling-golden.mjs의 HARDCODED_LITERAL " +
        "네 곳을 모두 동기화하십시오(콜드 리뷰 A-19).",
      file: m,
    });
  }
}

function checkWorkingTreeCR(root, explicitRoot, errors) {
  const excludeDirs = [...ALWAYS_EXCLUDED_DIR_NAMES].map((n) => path.join(root, n));
  if (!explicitRoot) {
    excludeDirs.push(path.join(root, "tests", "fixtures-invalid"));
  }
  const files = walk(root, { excludeDirs });
  for (const f of files) {
    if (!isTextFile(f)) continue;
    let buf;
    try {
      buf = fs.readFileSync(f);
    } catch {
      continue;
    }
    if (!buf.includes(0x0d)) continue;

    const rel = toPosixRel(root, f);

    if (isLfEnforcedPath(rel)) {
      // scripts/**/*.mjs 등 .gitattributes가 eol=lf로 고정한 범위 —
      // CRLF로 짝지어져 있어도 예외 없이 FAIL(위 상수 주석 참조).
      errors.push({
        code: "CR_IN_WORKING_TREE",
        message: "LF 고정 대상(.gitattributes eol=lf)인데 CR(0x0D) 바이트가 섞여 있습니다.",
        file: rel,
      });
      continue;
    }

    // 그 외 `* text=auto` 범위 파일: 이 머신은 core.autocrlf=true라 정상
    // 체크아웃된 텍스트 파일도 일관된 CRLF를 갖는 것이 기대값이다(예:
    // GitHub이 생성한 LICENSE). 그 자체는 "CR 혼입"이 아니므로 FAIL하지
    // 않는다 — 대신 (a) CRLF 짝이 아닌 낱개 CR(lone CR), 또는 (b) 같은
    // 파일 안에 CRLF와 순수 LF가 섞여 있는 경우(불일치 혼재)만 FAIL한다.
    // 둘 다 .gitattributes 정규화만으로는 못 잡는(스펙이 전제하는) 실질적
    // 워킹 트리 손상·혼입 신호다.
    const text = buf.toString("utf8");
    const hasLoneCR = /\r(?!\n)/.test(text);
    const hasCRLF = /\r\n/.test(text);
    const hasBareLF = /(?<!\r)\n/.test(text);
    if (hasLoneCR || (hasCRLF && hasBareLF)) {
      errors.push({
        code: "CR_IN_WORKING_TREE",
        message: `줄바꿈이 혼재된 텍스트 파일입니다(lone CR=${hasLoneCR}, CRLF+LF 혼재=${hasCRLF && hasBareLF}).`,
        file: rel,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} [opts.root] 검사 루트(기본: 레포 루트)
 * @param {boolean} [opts.explicitRoot] true면 CR 가드의 tests/fixtures-invalid
 *   기본 제외 규칙을 적용하지 않는다(검사 루트가 인자로 명시 지정된 경우).
 * @returns {Promise<{ok: boolean, errors: object[], warnings: object[]}>}
 */
export async function runValidation({ root, explicitRoot = false } = {}) {
  const resolvedRoot = root ? path.resolve(root) : REPO_ROOT;
  const errors = [];
  const warnings = [];

  const pluginJson = checkPluginJson(resolvedRoot, errors);
  checkSkills(resolvedRoot, errors);
  checkSchemas(resolvedRoot, errors, warnings);
  checkDocPathReferences(resolvedRoot, errors);
  checkNamingConsistency(resolvedRoot, pluginJson, errors, warnings);
  checkStateDirConsistency(resolvedRoot, pluginJson, errors);
  checkSamplingMethodLiteralConsistency(errors);
  checkWorkingTreeCR(resolvedRoot, explicitRoot, errors);

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * AC-19 언어 린트 전용 모드. <out> 디렉터리에서 career.json /
 * knowledge-map.json / gap-report.json / plan.json 중 존재하는 파일을
 * 찾아, 레포 자신의 schemas/<layer>.schema.json이 정의하는 x-freeText
 * 필드 값을 검사한다.
 *
 * @param {object} opts
 * @param {string} opts.outDir
 */
export async function runLangCheck({ outDir }) {
  const errors = [];
  const warnings = [];
  const resolvedOut = path.resolve(outDir);

  if (!dirExists(resolvedOut)) {
    errors.push({ code: "LANG_CHECK_OUT_NOT_FOUND", message: `디렉터리를 찾을 수 없습니다: ${outDir}`, file: outDir });
    return { ok: false, errors, warnings };
  }

  const layers = ["career", "knowledge-map", "gap-report", "plan"];
  for (const layer of layers) {
    const instPath = path.join(resolvedOut, `${layer}.json`);
    if (!fileExists(instPath)) continue;
    const relInst = toPosixRel(resolvedOut, instPath);
    const schemaPath = path.join(REPO_ROOT, "schemas", `${layer}.schema.json`);
    if (!fileExists(schemaPath)) {
      warnings.push({ code: "LANG_CHECK_SCHEMA_MISSING", message: `스키마를 찾을 수 없습니다: schemas/${layer}.schema.json` });
      continue;
    }
    let instance;
    try {
      instance = readJson(instPath);
    } catch (e) {
      errors.push({ code: "LANG_CHECK_INSTANCE_PARSE_ERROR", message: `${layer}.json 파싱 실패: ${e.message}`, file: relInst });
      continue;
    }
    const schema = readJson(schemaPath);
    for (const v of lintFreeText(schema, instance)) {
      errors.push({
        code: "FREETEXT_ENGLISH_DETECTED",
        message: `필드 '${v.path}' 값이 한글 없이 4토큰 이상 서술형입니다: "${v.value}"`,
        file: relInst,
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * AC-12 프로덕션 집행 지점. `<path>`가 가리키는 산출물 JSON 파일 하나를
 * 파일명(확장자 제외)으로 대응하는 `schemas/<layer>.schema.json`에 대해
 * `scripts/lib/schema-validate.mjs`의 validateInstance로 구조 검증한다.
 *
 * validateInstance는 이 도입 전까지 테스트에서만 호출되던 죽은 코드였다 —
 * 이 함수가 그 유일한 프로덕션 호출자다. "evidence 배열이 비면 basis가
 * insufficient여야 한다" 같은 스키마 레벨 allOf/if/then 제약을 여기서
 * 산출물 파일에 실제로 적용한다.
 *
 * layer가 "evidence"이면 구조 검증(validateInstance) 다음 단계로
 * scripts/lib/invariants.mjs의 checkEvidenceInvariants()를 호출해
 * AC-6 (i)(ii)(iii)·절단 전역 불변식 (T-1)(T-2)를 교차 검사한다 —
 * evidence.schema.json의 x-invariant-note가 "실제 교차 검사는
 * verify-evidence.mjs / validate-plugin.mjs가 수행한다(AC-6)"고 약속한
 * 지점이 바로 여기다(이월 게이트 A-1/A-2 + 임무 지침 배선 위치 C).
 *
 * @param {object} opts
 * @param {string} opts.instancePath 검사할 산출물 JSON 파일 경로(예:
 *   career.json, evidence.json). 파일명(확장자 제외)이 곧 스키마 레이어
 *   이름이다(`schemas/<basename>.schema.json`).
 */
export async function runSchemaCheck({ instancePath }) {
  const errors = [];
  const warnings = [];
  const resolvedInst = path.resolve(instancePath);

  if (!fileExists(resolvedInst)) {
    errors.push({
      code: "SCHEMA_CHECK_INSTANCE_NOT_FOUND",
      message: `파일을 찾을 수 없습니다: ${instancePath}`,
      file: instancePath,
    });
    return { ok: false, errors, warnings };
  }

  const layer = path.basename(resolvedInst, ".json");
  const schemaPath = path.join(REPO_ROOT, "schemas", `${layer}.schema.json`);
  if (!fileExists(schemaPath)) {
    errors.push({
      code: "SCHEMA_CHECK_SCHEMA_NOT_FOUND",
      message: `대응 스키마를 찾을 수 없습니다: schemas/${layer}.schema.json (파일명으로 레이어를 판단합니다)`,
      file: instancePath,
    });
    return { ok: false, errors, warnings };
  }

  let instance;
  try {
    instance = readJson(resolvedInst);
  } catch (e) {
    errors.push({
      code: "SCHEMA_CHECK_INSTANCE_PARSE_ERROR",
      message: `${path.basename(resolvedInst)} 파싱 실패: ${e.message}`,
      file: instancePath,
    });
    return { ok: false, errors, warnings };
  }

  const schema = readJson(schemaPath);
  const schemaWarnings = [];
  const violations = validateInstance(schema, instance, schema, "$", schemaWarnings);

  for (const w of schemaWarnings) {
    warnings.push({ code: "SCHEMA_CHECK_UNSUPPORTED_KEYWORD", message: w, file: instancePath });
  }
  for (const v of violations) {
    errors.push({ code: "SCHEMA_CHECK_VIOLATION", message: v, file: instancePath });
  }

  // AC-6 (i)(ii)(iii) + (T-1)(T-2): evidence.json에 한해 구조 검증 이후
  // 교차 필드 불변식을 검사한다(instance.commits가 배열이 아니면 구조
  // 검증에서 이미 required/type 위반이 잡히므로 여기서는 방어적으로
  // 건너뛴다 — 형태가 아예 어긋난 인스턴스에 이 검사를 적용하면 의미 없는
  // 결과가 나온다).
  if (layer === "evidence" && instance && Array.isArray(instance.commits)) {
    const invariantViolations = checkEvidenceInvariants(instance);
    for (const v of invariantViolations) {
      errors.push({ code: v.code, message: v.message, file: instancePath });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printResult(result, label) {
  for (const w of result.warnings) {
    console.error(`[WARN] ${w.code}: ${w.message}${w.file ? ` (${w.file})` : ""}`);
  }
  for (const e of result.errors) {
    console.error(`[FAIL] ${e.code}: ${e.message}${e.file ? ` (${e.file})` : ""}`);
  }
  if (result.ok) {
    console.log(`[PASS] ${label}`);
  } else {
    console.error(`[FAIL] ${label}: ${result.errors.length}건 위반`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const langCheckIdx = argv.indexOf("--lang-check");
  const schemaCheckIdx = argv.indexOf("--schema-check");

  if (langCheckIdx !== -1) {
    const outDir = argv[langCheckIdx + 1];
    if (!outDir) {
      console.error("사용법: node scripts/validate-plugin.mjs --lang-check <out>");
      process.exit(2);
    }
    const result = await runLangCheck({ outDir });
    printResult(result, `lang-check(${outDir})`);
    process.exit(result.ok ? 0 : 1);
  }

  if (schemaCheckIdx !== -1) {
    const instancePath = argv[schemaCheckIdx + 1];
    if (!instancePath) {
      console.error("사용법: node scripts/validate-plugin.mjs --schema-check <path>");
      process.exit(2);
    }
    const result = await runSchemaCheck({ instancePath });
    printResult(result, `schema-check(${instancePath})`);
    process.exit(result.ok ? 0 : 1);
  }

  const negativeFlag = argv.includes("--negative");
  const positional = argv.filter((a) => a !== "--negative");
  const rootArg = positional[0];
  const explicitRoot = Boolean(rootArg) || negativeFlag;

  if (negativeFlag && !rootArg) {
    console.error("사용법: node scripts/validate-plugin.mjs --negative <root>");
    process.exit(2);
  }

  const result = await runValidation({ root: rootArg, explicitRoot });
  printResult(result, `validate-plugin(${rootArg ?? "repo root"})`);
  process.exit(result.ok ? 0 : 1);
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
